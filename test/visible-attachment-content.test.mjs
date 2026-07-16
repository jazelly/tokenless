import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const contentScript = path.join(root, 'packages/extension/dist/extension/content/provider-content.js')
const fixture = fs.readFileSync(
  path.join(root, 'test/fixtures/provider-attachment-dom-fixture.html'),
  'utf8'
)

const providers = [
  { id: 'chatgpt', input: '#upload-files', url: 'https://chatgpt.com/' },
  { id: 'claude', input: '#chat-input-file-upload-onpage', url: 'https://claude.ai/new' },
  { id: 'grok', input: 'input[name="files"]', url: 'https://grok.com/' },
]

test('visible attachment receiver verifies chunks and uses only exact provider inputs', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  for (const provider of providers) {
    await t.test(provider.id, async () => {
      const session = await openAttachmentFixture(browser, provider.url)
      try {
        const bytes = Buffer.from(`verified attachment bytes for ${provider.id};`.repeat(6))
        const requestId = `attachment-${provider.id}`
        const attachmentId = `file-${provider.id}`
        const name = `${provider.id}-proof.txt`
        const request = { provider: provider.id, requestId, targetUrl: provider.url }

        assert.deepEqual(await dispatch(session.page, {
          type: 'tokenless.bridge.attachment_prepare',
          request,
          requestId,
          attachmentId,
          name,
          mimeType: 'text/plain',
          size: bytes.length,
          sha256: sha256(bytes),
        }), {
          status: 'prepared',
          provider: provider.id,
          requestId,
          attachmentId,
          expectedBytes: bytes.length,
        })

        const wrongOffset = await dispatch(session.page, {
          type: 'tokenless.bridge.attachment_chunk',
          request,
          requestId,
          attachmentId,
          offset: 1,
          dataBase64: bytes.subarray(0, 4).toString('base64'),
        })
        assert.equal(wrongOffset.status, 'blocked')
        assert.equal(wrongOffset.stopReason, 'attachment_offset_mismatch')

        const split = Math.min(7, bytes.length)
        const firstChunk = await dispatch(session.page, {
          type: 'tokenless.bridge.attachment_chunk',
          request,
          requestId,
          attachmentId,
          offset: 0,
          dataBase64: bytes.subarray(0, split).toString('base64'),
        })
        assert.equal(firstChunk.status, 'chunk_received')
        assert.equal(firstChunk.receivedBytes, split)
        const secondChunk = await dispatch(session.page, {
          type: 'tokenless.bridge.attachment_chunk',
          request,
          requestId,
          attachmentId,
          offset: split,
          dataBase64: bytes.subarray(split).toString('base64'),
        })
        assert.equal(secondChunk.status, 'chunk_received')
        assert.equal(secondChunk.receivedBytes, bytes.length)

        const committed = await dispatch(session.page, {
          type: 'tokenless.bridge.attachment_commit',
          request,
          requestId,
          attachmentId,
        })
        assert.equal(committed.status, 'attached')
        assert.equal(committed.visible, true)
        assert.equal(committed.name, name)
        assert.equal(committed.sha256, sha256(bytes))

        const state = await session.page.evaluate(() => ({
          events: globalThis.__attachmentFixture.events,
          records: globalThis.__attachmentFixture.records,
          decoyFiles: document.querySelector('[data-decoy-file-input]').files.length,
        }))
        assert.deepEqual(state.events.slice(0, 2), ['input', 'change'])
        assert.equal(state.events.includes('chip-visible'), true)
        assert.deepEqual(state.records, [{
          bytes: [...bytes],
          name,
          size: bytes.length,
          type: 'text/plain',
        }])
        assert.equal(state.decoyFiles, 0)
        await assertVisibleFilename(session.page, name)
        assert.deepEqual(session.pageErrors, [])
      } finally {
        await session.context.close()
      }
    })
  }
})

test('visible attachment batch commit installs every file atomically in one FileList', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const session = await openAttachmentFixture(browser, 'https://chatgpt.com/')
  try {
    const requestId = 'attachment-atomic-batch'
    const request = { provider: 'chatgpt', requestId, targetUrl: 'https://chatgpt.com/' }
    const files = [
      { attachmentId: 'atomic-first', name: 'first-proof.txt', bytes: Buffer.from('first atomic bytes') },
      { attachmentId: 'atomic-second', name: 'second-proof.txt', bytes: Buffer.from('second atomic bytes') },
    ]

    for (const file of files) {
      assert.equal((await dispatch(session.page, {
        type: 'tokenless.bridge.attachment_prepare',
        request,
        requestId,
        attachmentId: file.attachmentId,
        name: file.name,
        mimeType: 'text/plain',
        size: file.bytes.length,
        sha256: sha256(file.bytes),
      })).status, 'prepared')
      assert.equal((await dispatch(session.page, {
        type: 'tokenless.bridge.attachment_chunk',
        request,
        requestId,
        attachmentId: file.attachmentId,
        offset: 0,
        dataBase64: file.bytes.toString('base64'),
      })).status, 'chunk_received')
    }

    assert.deepEqual(await session.page.evaluate(() => ({
      chips: document.querySelectorAll('.attachment-chip').length,
      events: [...globalThis.__attachmentFixture.events],
      files: document.querySelector('#upload-files').files.length,
    })), { chips: 0, events: [], files: 0 }, 'prepare and chunk must not mutate the provider input')

    const committed = await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_commit_batch',
      request,
      requestId,
      attachmentIds: files.map((file) => file.attachmentId),
    })
    assert.equal(committed.status, 'attached')
    assert.deepEqual(committed.attachments.map(({ attachmentId, name }) => ({ attachmentId, name })), [
      { attachmentId: 'atomic-first', name: 'first-proof.txt' },
      { attachmentId: 'atomic-second', name: 'second-proof.txt' },
    ])

    const state = await session.page.evaluate(async () => {
      const input = document.querySelector('#upload-files')
      const files = [...input.files]
      return {
        bytes: await Promise.all(files.map(async (file) => [...new Uint8Array(await file.arrayBuffer())])),
        events: [...globalThis.__attachmentFixture.events],
        fileNames: files.map((file) => file.name),
        records: globalThis.__attachmentFixture.records,
      }
    })
    assert.deepEqual(state.fileNames, files.map((file) => file.name))
    assert.deepEqual(state.bytes, files.map((file) => [...file.bytes]))
    assert.deepEqual(state.records.map(({ name }) => name), files.map((file) => file.name))
    assert.deepEqual(state.events, ['input', 'change', 'chip-visible', 'chip-visible'])
    assert.deepEqual(session.pageErrors, [])
  } finally {
    await session.context.close()
  }
})

test('visible attachment batch refuses a provider input that already contains a user file', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const session = await openAttachmentFixture(browser, 'https://chatgpt.com/')
  try {
    await session.page.evaluate(() => {
      const transfer = new DataTransfer()
      transfer.items.add(new File(['user-owned'], 'user-owned.txt', { type: 'text/plain' }))
      document.querySelector('#upload-files').files = transfer.files
    })
    const bytes = Buffer.from('tokenless bytes must not replace the user file')
    const requestId = 'attachment-dirty-input'
    const attachmentId = 'tokenless-file'
    const request = { provider: 'chatgpt', requestId, targetUrl: 'https://chatgpt.com/' }
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request,
      requestId,
      attachmentId,
      name: 'tokenless.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: sha256(bytes),
    })).status, 'prepared')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_chunk',
      request,
      requestId,
      attachmentId,
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })).status, 'chunk_received')

    const refused = await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_commit_batch',
      request,
      requestId,
      attachmentIds: [attachmentId],
    })
    assert.equal(refused.status, 'blocked')
    assert.equal(refused.stopReason, 'attachment_surface_not_clean')
    assert.deepEqual(await session.page.evaluate(() => ({
      events: [...globalThis.__attachmentFixture.events],
      fileNames: [...document.querySelector('#upload-files').files].map((file) => file.name),
      records: globalThis.__attachmentFixture.records,
    })), { events: [], fileNames: ['user-owned.txt'], records: [] })
    assert.deepEqual(session.pageErrors, [])
  } finally {
    await session.context.close()
  }
})

test('model configuration is prepared before an attachment mutates the provider composer', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const session = await openAttachmentFixture(browser, 'https://chatgpt.com/')
  try {
    const bytes = Buffer.from('model-before-attachment proof')
    const requestId = 'model-before-attachment'
    const attachmentId = 'model-order-file'
    const request = {
      provider: 'chatgpt',
      requestId,
      targetUrl: 'https://chatgpt.com/',
      model: 'GPT-5.5',
    }
    const preparedSubmit = await dispatch(session.page, {
      type: 'tokenless.bridge.prepare_submit',
      request,
    })
    assert.equal(preparedSubmit.status, 'prepared')
    assert.equal(preparedSubmit.configuration.model.status, 'selected')
    assert.equal(preparedSubmit.configuration.model.applied, 'GPT-5.5')

    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request,
      requestId,
      attachmentId,
      name: 'model-order.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: sha256(bytes),
    })).status, 'prepared')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_chunk',
      request,
      requestId,
      attachmentId,
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })).status, 'chunk_received')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_commit_batch',
      request,
      requestId,
      attachmentIds: [attachmentId],
    })).status, 'attached')

    assert.deepEqual(await session.page.evaluate(() => globalThis.__attachmentFixture.events), [
      'model-selected:GPT-5.5',
      'input',
      'change',
      'chip-visible',
    ])
    assert.deepEqual(session.pageErrors, [])
  } finally {
    await session.context.close()
  }
})

test('visible attachment receiver fails closed for hash drift, aborts, and uncaptured Gemini input', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())

  const claude = await openAttachmentFixture(browser, 'https://claude.ai/new')
  try {
    const bytes = Buffer.from('hash mismatch must never reach the provider input')
    const requestId = 'attachment-hash-drift'
    const attachmentId = 'file-hash-drift'
    const request = { provider: 'claude', requestId, targetUrl: 'https://claude.ai/new' }
    assert.equal((await dispatch(claude.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request,
      requestId,
      attachmentId,
      name: 'hash-drift.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: '0'.repeat(64),
    })).status, 'prepared')
    assert.equal((await dispatch(claude.page, {
      type: 'tokenless.bridge.attachment_chunk',
      request,
      requestId,
      attachmentId,
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })).status, 'chunk_received')
    const rejected = await dispatch(claude.page, {
      type: 'tokenless.bridge.attachment_commit',
      request,
      requestId,
      attachmentId,
    })
    assert.equal(rejected.status, 'blocked')
    assert.equal(rejected.stopReason, 'attachment_hash_mismatch')
    assert.deepEqual(
      await claude.page.evaluate(() => ({
        events: globalThis.__attachmentFixture.events,
        records: globalThis.__attachmentFixture.records,
      })),
      { events: [], records: [] }
    )

    const abortRequestId = 'attachment-abort'
    const abortAttachmentId = 'file-abort'
    const abortRequest = { provider: 'claude', requestId: abortRequestId, targetUrl: 'https://claude.ai/new' }
    const prepareAbort = {
      type: 'tokenless.bridge.attachment_prepare',
      request: abortRequest,
      requestId: abortRequestId,
      attachmentId: abortAttachmentId,
      name: 'abort.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: sha256(Buffer.from('x')),
    }
    assert.equal((await dispatch(claude.page, prepareAbort)).status, 'prepared')
    const aborted = await dispatch(claude.page, {
      type: 'tokenless.bridge.attachment_abort',
      request: abortRequest,
      requestId: abortRequestId,
      attachmentId: abortAttachmentId,
    })
    assert.equal(aborted.status, 'aborted')
    assert.equal(aborted.released, true)
    assert.equal((await dispatch(claude.page, prepareAbort)).status, 'prepared')
    const prematureSubmit = await dispatch(claude.page, {
      type: 'tokenless.bridge.submit',
      request: { ...abortRequest, prompt: 'must not submit with an incomplete attachment' },
    })
    assert.equal(prematureSubmit.status, 'blocked')
    assert.equal(prematureSubmit.stopReason, 'attachment_incomplete')
    assert.equal((await dispatch(claude.page, {
      type: 'tokenless.bridge.attachment_abort',
      request: abortRequest,
      requestId: abortRequestId,
      attachmentId: abortAttachmentId,
    })).status, 'aborted')
  } finally {
    await claude.context.close()
  }

  const gemini = await openAttachmentFixture(browser, 'https://gemini.google.com/app')
  try {
    const requestId = 'attachment-gemini-uncaptured'
    const blocked = await dispatch(gemini.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request: { provider: 'gemini', requestId, targetUrl: 'https://gemini.google.com/app' },
      requestId,
      attachmentId: 'file-gemini-uncaptured',
      name: 'gemini.txt',
      mimeType: 'text/plain',
      size: 0,
      sha256: sha256(Buffer.alloc(0)),
    })
    assert.equal(blocked.status, 'blocked')
    assert.equal(blocked.stopReason, 'attachment_input_unavailable')
    assert.deepEqual(gemini.pageErrors, [])
  } finally {
    await gemini.context.close()
  }
})

test('aborting an already-visible attachment poisons later submit until the provider page reloads', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const session = await openAttachmentFixture(browser, 'https://chatgpt.com/')
  try {
    const bytes = Buffer.from('must never leak into a later request')
    const requestId = 'attachment-partial-failure'
    const attachmentId = 'file-already-visible'
    const request = { provider: 'chatgpt', requestId, targetUrl: 'https://chatgpt.com/' }
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request,
      requestId,
      attachmentId,
      name: 'partial-failure.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: sha256(bytes),
    })).status, 'prepared')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_chunk',
      request,
      requestId,
      attachmentId,
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })).status, 'chunk_received')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_commit',
      request,
      requestId,
      attachmentId,
    })).status, 'attached')

    const aborted = await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_abort',
      request,
      requestId,
      attachmentId,
    })
    assert.equal(aborted.status, 'aborted')
    assert.equal(aborted.released, true)
    assert.equal(aborted.requiresReload, true)
    assert.equal(await session.page.locator('#upload-files').evaluate((input) => input.files.length), 0)

    const laterRequest = {
      provider: 'chatgpt',
      requestId: 'later-request',
      targetUrl: 'https://chatgpt.com/',
      prompt: 'This must not inherit the earlier file.',
    }
    const submit = await dispatch(session.page, {
      type: 'tokenless.bridge.submit',
      request: laterRequest,
    })
    assert.equal(submit.status, 'blocked')
    assert.equal(submit.stopReason, 'attachment_cleanup_required')
    const prepare = await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request: laterRequest,
      requestId: laterRequest.requestId,
      attachmentId: 'later-file',
      name: 'later.txt',
      mimeType: 'text/plain',
      size: 0,
      sha256: sha256(Buffer.alloc(0)),
    })
    assert.equal(prepare.status, 'blocked')
    assert.equal(prepare.stopReason, 'attachment_cleanup_required')
    assert.deepEqual(session.pageErrors, [])
  } finally {
    await session.context.close()
  }
})

test('an unconfirmed submit keeps the committed attachment ledger so abort poisons the page', async (t) => {
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const session = await openAttachmentFixture(browser, 'https://chatgpt.com/')
  try {
    const bytes = Buffer.from('must remain tracked until visible submit succeeds')
    const requestId = 'attachment-submit-unconfirmed'
    const attachmentId = 'file-submit-unconfirmed'
    const request = {
      provider: 'chatgpt',
      requestId,
      targetUrl: 'https://chatgpt.com/',
      prompt: 'The fixture will suppress this visible submission.',
      submissionConfirmTimeoutMs: 10,
    }
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_prepare',
      request,
      requestId,
      attachmentId,
      name: 'submit-unconfirmed.txt',
      mimeType: 'text/plain',
      size: bytes.length,
      sha256: sha256(bytes),
    })).status, 'prepared')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_chunk',
      request,
      requestId,
      attachmentId,
      offset: 0,
      dataBase64: bytes.toString('base64'),
    })).status, 'chunk_received')
    assert.equal((await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_commit_batch',
      request,
      requestId,
      attachmentIds: [attachmentId],
    })).status, 'attached')
    await session.page.evaluate(() => {
      globalThis.__attachmentFixture.suppressVisibleSubmit = true
    })

    const submit = await dispatch(session.page, {
      type: 'tokenless.bridge.submit',
      request,
    })
    assert.equal(submit.status, 'blocked')
    assert.equal(submit.stopReason, 'submission_unconfirmed')
    assert.equal(await session.page.locator('#upload-files').evaluate((input) => input.files.length), 1)

    const abort = await dispatch(session.page, {
      type: 'tokenless.bridge.attachment_abort',
      request,
      requestId,
      attachmentId,
    })
    assert.equal(abort.status, 'aborted')
    assert.equal(abort.released, true)
    assert.equal(abort.requiresReload, true)
    assert.equal(await session.page.locator('#upload-files').evaluate((input) => input.files.length), 0)
    const later = await dispatch(session.page, {
      type: 'tokenless.bridge.submit',
      request: {
        provider: 'chatgpt',
        requestId: 'after-unconfirmed-submit',
        targetUrl: 'https://chatgpt.com/',
        prompt: 'must be blocked until reload',
      },
    })
    assert.equal(later.status, 'blocked')
    assert.equal(later.stopReason, 'attachment_cleanup_required')
    assert.deepEqual(session.pageErrors, [])
  } finally {
    await session.context.close()
  }
})

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function dispatch(page, message) {
  return page.evaluate((payload) => globalThis.__dispatchTokenlessMessage(payload), message)
}

async function assertVisibleFilename(page, name) {
  await page.locator('.attachment-chip').filter({ hasText: name }).waitFor({ state: 'visible' })
}

async function openAttachmentFixture(browser, url) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } })
  await context.addInitScript(() => {
    const listeners = []
    Object.defineProperty(globalThis, 'chrome', {
      configurable: true,
      value: {
        runtime: {
          async sendMessage() {},
          onMessage: {
            addListener(listener) {
              listeners.push(listener)
            },
          },
        },
      },
    })
    Object.defineProperty(globalThis, '__dispatchTokenlessMessage', {
      configurable: true,
      value(message) {
        return new Promise((resolve, reject) => {
          const listener = listeners[0]
          if (!listener) return reject(new Error('Provider content listener is not installed.'))
          let responded = false
          const keepOpen = listener(message, {}, (response) => {
            responded = true
            resolve(response)
          })
          if (keepOpen !== true && !responded) reject(new Error('Provider content listener closed early.'))
        })
      },
    })
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))
  const origin = new URL(url).origin
  await page.route(`${origin}/**`, (route) => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: fixture,
  }))
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ path: contentScript })
  return { context, page, pageErrors }
}
