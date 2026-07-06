import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionPath = path.join(root, 'packages/extension/extension')
const testResultsRoot = path.join(root, 'test-results', 'tokenless-e2e', 'runs')

test('Tokenless CLI job completes through extension task page and ChatGPT fixture DOM', {
  skip: process.env.TOKENLESS_E2E !== '1' ? 'set TOKENLESS_E2E=1 to run fixture browser E2E' : false,
  timeout: 120000,
}, async () => {
  const { chromium } = await import('playwright')
  const {
    createLocalJob,
    installNativeHost,
    nativeMessagingHostDirs,
    NATIVE_HOST_NAME,
    waitLocalJobResult,
  } = await import('../packages/cli/src/index.js')

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-e2e-'))
  const artifactDir = await createArtifactDir()
  const userDataDir = path.join(tempRoot, 'profile')
  const tokenlessHome = path.join(tempRoot, 'tokenless-home')
  const prompt = 'Tokenless E2E DOM prompt 48291'
  let manifestBackup = []
  const events = []

  let context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)

  try {
    const extensionId = await discoverExtensionId(context)
    events.push({ at: new Date().toISOString(), event: 'extension_discovered', extensionId })
    await context.close()
    context = null

    const manifestHome = userDataDir
    const browsers = ['profile']
    manifestBackup = await snapshotFiles(browsers.flatMap((browser) => (
      nativeMessagingHostDirs(browser, manifestHome).map((dir) => path.join(dir, `${NATIVE_HOST_NAME}.json`))
    )))
    const installed = await installNativeHost({
      homeDir: tokenlessHome,
      manifestHome,
      extensionId,
      browsers,
    })
    assert.ok(installed.manifests.length >= 1)
    events.push({
      at: new Date().toISOString(),
      event: 'native_host_installed',
      manifests: installed.manifests,
      executable: installed.executable,
    })

    context = await launchTokenlessContext(chromium, userDataDir, tokenlessHome)
    await context.route('https://chatgpt.com/**', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: chatGptFixtureHtml(),
      })
    })
    events.push({
      at: new Date().toISOString(),
      event: 'provider_fixture_route_registered',
      route: 'https://chatgpt.com/**',
      fixture: true,
      realProviderDom: false,
    })
    const providerFixturePage = await context.newPage()
    await providerFixturePage.goto('https://chatgpt.com/')
    await providerFixturePage.locator('#prompt-textarea').waitFor({ timeout: 5000 })
    await providerFixturePage.screenshot({ path: path.join(artifactDir, '01-chatgpt-fixture-before-empty-composer.png'), fullPage: true })
    events.push({ at: new Date().toISOString(), event: 'provider_fixture_ready', url: providerFixturePage.url(), fixture: true, realProviderDom: false })

    const job = await createLocalJob({
      homeDir: tokenlessHome,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      readDelayMs: 0,
      readTimeoutMs: 10000,
    })
    events.push({ at: new Date().toISOString(), event: 'job_created', jobId: job.jobId })
    await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'before')

    const task = await context.newPage()
    await task.goto(`chrome-extension://${extensionId}/task/task.html?jobId=${job.jobId}&nonce=${job.nonce}`)
    await task.screenshot({ path: path.join(artifactDir, '02-extension-task-started.png'), fullPage: true })

    const result = await waitLocalJobResult({
      homeDir: tokenlessHome,
      jobId: job.jobId,
      nonce: job.nonce,
      timeoutMs: 30000,
    })
    events.push({ at: new Date().toISOString(), event: 'job_result_received', ok: result.ok })

    assert.equal(result.ok, true)
    assert.match(result.compactOutput, /visible ChatGPT fixture DOM answer/)
    assert.match(result.compactOutput, /Tokenless E2E DOM prompt 48291/)
    assert.doesNotMatch(result.compactOutput, /stale ChatGPT fixture DOM answer/)
    assert.doesNotMatch(result.compactOutput, /_streaming/)

    const providerPage = context.pages().find((page) => page.url().startsWith('https://chatgpt.com/')) ?? providerFixturePage
    assert.ok(providerPage, 'provider tab should be opened')
    assert.equal(await providerPage.locator('#prompt-textarea').innerText(), prompt)
    assert.match(await providerPage.locator('[data-message-author-role="assistant"]').last().innerText(), /visible ChatGPT fixture DOM answer/)
    await task.screenshot({ path: path.join(artifactDir, '03-extension-task-completed.png'), fullPage: true })
    await providerPage.screenshot({ path: path.join(artifactDir, '04-chatgpt-fixture-after-prompt-and-response.png'), fullPage: true })
    await fs.writeFile(path.join(artifactDir, 'provider-fixture-text.txt'), await providerPage.locator('body').innerText(), 'utf8')
    await fs.writeFile(path.join(artifactDir, 'task-text.txt'), await task.locator('body').innerText(), 'utf8')
    await copyJobFiles(tokenlessHome, job.jobId, artifactDir, 'after')
    await fs.writeFile(path.join(artifactDir, 'summary.json'), `${JSON.stringify({
      ok: true,
      artifactDir,
      mode: 'fixture-chatgpt',
      fixture: true,
      fixtureRoute: 'https://chatgpt.com/**',
      realProviderDom: false,
      extensionId,
      jobId: job.jobId,
      provider: 'chatgpt',
      targetUrl: 'https://chatgpt.com/',
      prompt,
      compactOutput: result.compactOutput,
      events,
    }, null, 2)}\n`, 'utf8')
    console.log(`Tokenless fixture E2E artifacts: ${artifactDir}`)
  } finally {
    if (context) {
      await fs.writeFile(path.join(artifactDir, 'pages.json'), `${JSON.stringify(
        context.pages().map((page) => ({ url: page.url() })),
        null,
        2
      )}\n`, 'utf8').catch(() => undefined)
    }
    await fs.writeFile(path.join(artifactDir, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8')
    await context?.close()
    await restoreFiles(manifestBackup)
  }
})

async function createArtifactDir() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const artifactDir = path.join(testResultsRoot, `${stamp}-${process.pid}`)
  await fs.mkdir(artifactDir, { recursive: true })
  return artifactDir
}

async function copyJobFiles(tokenlessHome, jobId, artifactDir, phase) {
  const jobDir = path.join(tokenlessHome, 'jobs')
  for (const kind of ['request', 'state', 'result']) {
    const source = path.join(jobDir, `${jobId}.${kind}.json`)
    const destination = path.join(artifactDir, `${phase}-${kind}.json`)
    await fs.copyFile(source, destination).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

async function launchTokenlessContext(chromium, userDataDir, tokenlessHome) {
  const options = {
    headless: process.env.TOKENLESS_E2E_HEADED === '1' ? false : false,
    env: {
      ...process.env,
      TOKENLESS_HOME: tokenlessHome,
    },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  }
  if (process.env.TOKENLESS_E2E_CHANNEL) {
    options.channel = process.env.TOKENLESS_E2E_CHANNEL
  }
  return chromium.launchPersistentContext(userDataDir, options)
}

async function snapshotFiles(files) {
  return Promise.all(files.map(async (file) => {
    const previous = await fs.readFile(file, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    return { file, previous }
  }))
}

async function restoreFiles(entries) {
  for (const entry of entries.reverse()) {
    if (entry.previous === null) {
      await fs.rm(entry.file, { force: true })
    } else {
      await fs.writeFile(entry.file, entry.previous)
    }
  }
}

async function discoverExtensionId(context) {
  let [worker] = context.serviceWorkers()
  if (!worker) {
    worker = await context.waitForEvent('serviceworker', { timeout: 10000 })
  }
  const url = new URL(worker.url())
  assert.equal(url.protocol, 'chrome-extension:')
  return url.hostname
}

function chatGptFixtureHtml() {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>ChatGPT Fixture</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f7f7f8;
        color: #202123;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: #f7f7f8;
      }

      .shell {
        display: grid;
        grid-template-columns: 260px 1fr;
        min-height: 100vh;
      }

      aside {
        background: #202123;
        color: #ececf1;
        padding: 18px 14px;
      }

      .brand {
        font-size: 18px;
        font-weight: 700;
        margin-bottom: 18px;
      }

      .new-chat {
        border: 1px solid rgba(255,255,255,.28);
        border-radius: 8px;
        padding: 11px 12px;
        font-size: 14px;
      }

      main {
        display: flex;
        flex-direction: column;
        min-width: 0;
      }

      header {
        height: 56px;
        border-bottom: 1px solid #e5e5e8;
        display: flex;
        align-items: center;
        padding: 0 24px;
        background: white;
        font-weight: 650;
      }

      #conversation {
        flex: 1;
        max-width: 860px;
        width: 100%;
        margin: 0 auto;
        padding: 48px 24px 180px;
        box-sizing: border-box;
      }

      .empty {
        text-align: center;
        margin-top: 92px;
        color: #565869;
      }

      article {
        display: grid;
        grid-template-columns: 40px 1fr;
        gap: 14px;
        padding: 22px 0;
        border-bottom: 1px solid #ececf1;
      }

      .avatar {
        width: 32px;
        height: 32px;
        border-radius: 4px;
        display: grid;
        place-items: center;
        font-size: 13px;
        font-weight: 700;
        color: white;
      }

      article[data-message-author-role="user"] .avatar {
        background: #2563eb;
      }

      article[data-message-author-role="assistant"] .avatar {
        background: #10a37f;
      }

      .message-label {
        font-size: 13px;
        font-weight: 700;
        margin-bottom: 6px;
      }

      .message-text {
        line-height: 1.55;
        white-space: pre-wrap;
      }

      .composer-wrap {
        position: fixed;
        left: 260px;
        right: 0;
        bottom: 0;
        padding: 22px 24px 30px;
        background: linear-gradient(to top, #f7f7f8 75%, rgba(247,247,248,0));
      }

      .composer {
        max-width: 860px;
        margin: 0 auto;
        background: white;
        border: 1px solid #d9d9e3;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,.08);
        display: grid;
        grid-template-columns: 1fr 44px;
        align-items: end;
        padding: 12px;
        gap: 10px;
      }

      #prompt-textarea {
        min-height: 44px;
        max-height: 180px;
        overflow: auto;
        outline: none;
        line-height: 1.5;
        padding: 10px 12px;
      }

      #prompt-textarea:empty::before {
        content: "Message ChatGPT";
        color: #8e8ea0;
      }

      button[data-testid="send-button"] {
        width: 42px;
        height: 42px;
        border: 0;
        border-radius: 8px;
        background: #111827;
        color: white;
        font-weight: 800;
        cursor: pointer;
      }

      .proof-strip {
        max-width: 860px;
        margin: 10px auto 0;
        color: #6b7280;
        font-size: 12px;
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside>
        <div class="brand">ChatGPT</div>
        <div class="new-chat">+ New chat</div>
      </aside>
      <main>
        <header>ChatGPT fixture DOM, not real ChatGPT</header>
        <section id="conversation">
          <article data-message-author-role="user">
            <div class="avatar">U</div>
            <div>
              <div class="message-label">You</div>
              <div class="message-text">Earlier fixture prompt</div>
            </div>
          </article>
          <article data-message-author-role="assistant">
            <div class="avatar">AI</div>
            <div>
              <div class="message-label">ChatGPT</div>
              <div class="message-text">stale ChatGPT fixture DOM answer that must not be read</div>
            </div>
          </article>
        </section>
        <div class="composer-wrap">
          <div class="composer">
            <div id="prompt-textarea" contenteditable="true" role="textbox" aria-label="Message ChatGPT"></div>
            <button data-testid="send-button" aria-label="Send prompt">↑</button>
          </div>
          <div class="proof-strip">Fixture E2E proof only: content script writes prompt here, clicks send, then reads assistant message from this local DOM.</div>
        </div>
      </main>
    </div>
    <script>
      const composer = document.querySelector('#prompt-textarea')
      const send = document.querySelector('[data-testid="send-button"]')
      const conversation = document.querySelector('#conversation')
      const empty = document.querySelector('#empty-state')
      send.addEventListener('click', () => {
        const prompt = composer.innerText || composer.textContent || ''
        empty?.remove()
        conversation.append(message('user', 'You', 'U', prompt))
        setTimeout(() => {
          const assistant = message('assistant', 'ChatGPT Fixture', 'AI', 'visible ChatGPT fixture DOM answer_streaming for: ' + prompt)
          const stop = document.createElement('button')
          stop.dataset.testid = 'stop-button'
          stop.textContent = 'Stop answering'
          document.body.append(stop)
          conversation.append(assistant)
          setTimeout(() => {
            assistant.querySelector('.message-text').textContent = 'visible ChatGPT fixture DOM answer for: ' + prompt
            stop.remove()
          }, 900)
        }, 150)
      })
      function message(role, label, avatarText, text) {
        const article = document.createElement('article')
        article.dataset.messageAuthorRole = role
        const avatar = document.createElement('div')
        avatar.className = 'avatar'
        avatar.textContent = avatarText
        const body = document.createElement('div')
        const title = document.createElement('div')
        title.className = 'message-label'
        title.textContent = label
        const content = document.createElement('div')
        content.className = 'message-text'
        content.textContent = text
        body.append(title, content)
        article.append(avatar, body)
        return article
      }
    </script>
  </body>
</html>`
}
