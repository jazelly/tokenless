import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { createLiveBrowserInspectionSession } from './helpers/live-browser-observer.mjs'
import { loadLiveProviderCapabilityMatrix } from './helpers/live-provider-capability-matrix.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const matrix = loadLiveProviderCapabilityMatrix()
const gate = requiredGate()
const homeDir = path.resolve(requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_HOME'))
const profileSlug = requiredEnv('TOKENLESS_LIVE_MANAGED_PLAYWRIGHT_PROFILE')
const suiteRunMarker = `${compactTimestamp(new Date())}_${randomUUID().slice(0, 8)}`
const handlers = {
  'session-readiness': sessionReadiness,
  'prompt-draft': promptDraft,
  'model-choice': modelChoice,
  'effort-choice': effortChoice,
  'file-selection': fileSelection,
  'file-upload': fileUpload,
  'submit-read': submitRead,
  citations,
  'conversation-continuation': conversationContinuation,
  'conversation-workspace': conversationWorkspace,
  'native-project': nativeProject,
}

const selectedCases = Object.entries(matrix.providers)
  .flatMap(([provider, declaration]) => declaration.required
    .filter((caseId) => matrix.cases[caseId].gate === gate)
    .map((caseId) => ({ provider, caseId })))

assert.ok(selectedCases.length > 0, `TOKENLESS_LIVE_E2E_GATE=${gate} selected no required cases`)
for (const { provider, caseId } of selectedCases) {
  test(`real provider ${provider}: ${caseId}`, { timeout: 1_200_000 }, async () => {
    const handler = handlers[caseId]
    assert.equal(typeof handler, 'function', `missing real E2E handler for ${caseId}`)
    const daemonUrl = `http://127.0.0.1:${await freePort()}`
    const session = await createLiveBrowserInspectionSession({
      homeDir,
      profileSlug,
      daemonUrl,
    })
    try {
      if (gate !== 'non_submission' && matrix.providers[provider].account === 'signed_in_selected_setup_profile') {
        await requireSignedInSelectedProfile(provider, session)
      }
      await handler({ provider, declaration: matrix.providers[provider], session })
    } finally {
      await session.close()
    }
  })
}

async function requireSignedInSelectedProfile(provider, session) {
  const auth = await action(session, provider, 'auth.status')
  const result = responseResult(auth.payload, 'auth.status')
  await auth.close()
  const signedIn = result?.state === 'authenticated' || String(result?.access ?? '').startsWith('signed_in_')
  if (!signedIn) {
    throw e2eFailure(
      'e2e_provider_auth_unavailable',
      `${provider} selected setup profile is not authenticated`,
    )
  }
}

async function sessionReadiness({ provider, declaration, session }) {
  const auth = await action(session, provider, 'auth.status')
  const authResult = responseResult(auth.payload, 'auth.status')
  await auth.close()
  const capabilities = await action(session, provider, 'capability.inspect')
  const capabilityResult = responseResult(capabilities.payload, 'capability.inspect')
  const navigation = await action(session, provider, 'navigation.check')
  assert.equal(responseResult(navigation.payload, 'navigation.check')?.allowed, true)
  const blocker = await action(session, provider, 'blocker.check')
  const blockerResult = responseResult(blocker.payload, 'blocker.check')
  assert.equal(blockerResult?.blocked, false)
  const signedIn = authResult?.state === 'authenticated' || String(authResult?.access ?? '').startsWith('signed_in_')
  const guestReady = authResult?.access === 'guest' ||
    blockerResult?.observation?.composerVisible === true ||
    capabilityResult?.capabilities?.['conversation.continue']?.availability === 'available'
  const ready = declaration.account === 'signed_in_selected_setup_profile'
    ? signedIn
    : signedIn || guestReady
  if (!ready) {
    throw e2eFailure(
      'e2e_provider_auth_unavailable',
      `${provider} selected setup profile does not satisfy ${declaration.account}`,
    )
  }
}

async function promptDraft({ provider, session }) {
  const marker = markerFor(provider, 'DRAFT')
  const input = await action(session, provider, 'prompt.input', ['--prompt', marker])
  assert.deepEqual(responseResult(input.payload, 'prompt.input'), {
    visible: true,
    inputProof: 'prompt-text-visible',
  })
  assert.equal(await composerContains(input.page, marker), true, `${provider} observer must see the unique draft`)
  await input.close()

  const clear = await action(session, provider, 'prompt.clear')
  assert.deepEqual(responseResult(clear.payload, 'prompt.clear'), {
    visible: true,
    inputProof: 'empty',
  })
  assert.equal(await composerContains(clear.page, marker), false, `${provider} observer must see the draft removed`)
}

async function modelChoice(context) {
  await choiceCase(context, 'model')
}

async function effortChoice(context) {
  await choiceCase(context, 'effort')
}

async function choiceCase({ provider, session }, kind) {
  const inspectAction = `${kind}.inspect`
  const selectAction = `${kind}.select`
  const inspect = await action(session, provider, inspectAction)
  const result = responseResult(inspect.payload, inspectAction)
  assert.equal(result?.supported, true, `${provider} ${inspectAction} must be supported`)
  const selected = result.choices.find((choice) => choice.selected && choice.enabled)
  const alternate = result.choices.find((choice) => !choice.selected && choice.enabled)
  assert.ok(selected, `${provider} ${kind} must expose the selected choice`)
  assert.ok(alternate, `${provider} ${kind} must expose a real alternate choice`)
  await inspect.close()

  const option = kind === 'model' ? '--model' : '--effort'
  const changed = await action(session, provider, selectAction, [option, alternate.label])
  try {
    assert.equal(responseResult(changed.payload, selectAction)?.selectedLabel, alternate.label)
    assert.equal(await exactTextVisible(changed.page, alternate.label), true, `${provider} observer must see selected ${kind}`)
  } finally {
    await changed.close()
    const restored = await action(session, provider, selectAction, [option, selected.label])
    assert.equal(responseResult(restored.payload, selectAction)?.selectedLabel, selected.label)
  }
}

async function fileSelection({ provider, session }) {
  const name = `${markerFor(provider, 'ATTACHMENT')}.txt`
  const file = path.join(root, 'test-results', 'live-provider-inputs', name)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${name}\n`, { mode: 0o600 })
  try {
    const uploaded = await action(session, provider, 'file.upload', ['--attach-file', file], 180_000)
    const result = responseResult(uploaded.payload, 'file.upload')
    assert.ok(result?.attachments?.some((attachment) => attachment.name === name))
    assert.equal(await exactTextVisible(uploaded.page, name), true, `${provider} observer must see selected attachment`)
    await uploaded.close()
    await action(session, provider, 'prompt.clear')
  } finally {
    await fs.rm(file, { force: true })
  }
}

async function fileUpload({ provider, session }) {
  const marker = markerFor(provider, 'ATTACHMENT_SUBMISSION')
  const name = `${marker}.txt`
  const file = path.join(root, 'test-results', 'live-provider-inputs', name)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${marker}\n`, { mode: 0o600 })
  try {
    const run = await cliRun(session, provider, [
      '--task-id', markerFor(provider, 'ATTACHMENT_TASK'),
      '--attach-file', file,
      '--prompt', `Read the attached file and reply with exactly its marker: ${marker}`,
    ], 360_000, ({ page }) => waitForExactText(page, name, 180_000))
    const upload = responseResult(run.payload, 'file.upload')
    assert.ok(upload?.attachments?.some((attachment) => attachment.name === name))
    assert.equal(run.observerResult, true, `${provider} observer must see the submitted attachment`)
    assert.match(responseResult(run.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(marker)))
    assert.equal(await pageContains(run.page, marker, 2), true)
  } finally {
    await fs.rm(file, { force: true })
  }
}

async function submitRead({ provider, session }) {
  const marker = markerFor(provider, 'RESPONSE')
  const run = await cliRun(session, provider, [
    '--task-id', markerFor(provider, 'TASK'),
    '--prompt', `Reply with exactly this marker and nothing else: ${marker}`,
  ])
  const result = responseResult(run.payload, 'response.read')
  assert.match(result?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.equal(await pageContains(run.page, marker, 2), true, `${provider} observer must see prompt and response markers`)
}

async function citations({ provider, session }) {
  const marker = markerFor(provider, 'CITATION')
  const run = await cliRun(session, provider, [
    '--task-id', markerFor(provider, 'CITATION_TASK'),
    '--prompt', `Find the current official homepage for Node.js. Include the marker ${marker} and cite the official source.`,
  ])
  const result = responseResult(run.payload, 'response.read')
  assert.match(result?.text ?? '', new RegExp(escapeRegExp(marker)))
  assert.ok(Array.isArray(result?.citations) && result.citations.length > 0, `${provider} must return normalized real citations`)
  assert.ok(await visibleCitationCount(run.page, result.citations) > 0, `${provider} observer must see a returned citation link`)
}

async function conversationContinuation({ provider, session }) {
  const taskId = markerFor(provider, 'CONTINUATION_TASK')
  const firstMarker = markerFor(provider, 'TURN_ONE_ACK')
  const contextSecret = markerFor(provider, 'CONTEXT_SECRET')
  const first = await cliRun(session, provider, [
    '--task-id', taskId,
    '--workspace-mode', 'conversation',
    '--project-name', taskId,
    '--prompt', `Remember this secret for my next message: ${contextSecret}. Reply with exactly ${firstMarker} and do not include the secret.`,
  ])
  const firstUrl = canonicalPageUrl(first.page.url())
  const firstText = responseResult(first.payload, 'response.read')?.text ?? ''
  assert.match(firstText, new RegExp(escapeRegExp(firstMarker)))
  assert.doesNotMatch(firstText, new RegExp(escapeRegExp(contextSecret)))
  await first.close()

  const second = await cliRun(session, provider, [
    '--task-id', taskId,
    '--workspace-mode', 'conversation',
    '--project-name', taskId,
    '--prompt', 'Reply with exactly the secret from my previous message and no other text.',
  ])
  const secondText = responseResult(second.payload, 'response.read')?.text ?? ''
  assert.match(secondText, new RegExp(escapeRegExp(contextSecret)))
  assert.equal(canonicalPageUrl(second.page.url()), firstUrl, `${provider} both CLI processes must share one exact conversation`)
  assertTaskConversationMapping(provider, taskId, firstUrl, second.payload)
}

async function conversationWorkspace({ provider, session }) {
  const name = markerFor(provider, 'CONVERSATION_WORKSPACE')
  const taskId = markerFor(provider, 'CONVERSATION_WORKSPACE_TASK')
  const responseMarker = markerFor(provider, 'CONVERSATION_WORKSPACE_RESPONSE')
  const ensured = await cliRun(session, provider, [
    '--task-id', taskId,
    '--project-name', name,
    '--workspace-mode', 'conversation',
    '--prompt', `Reply with exactly this marker: ${responseMarker}`,
  ])
  const result = responseResult(ensured.payload, 'workspace.ensure')
  assert.equal(result?.mode, 'conversation')
  assert.equal(result?.resource?.kind, 'conversation')
  assert.equal(result?.resource?.native, false)
  assert.equal(result?.resource?.disposition, 'fallback')
  assert.match(responseResult(ensured.payload, 'response.read')?.text ?? '', new RegExp(escapeRegExp(responseMarker)))
  const conversationUrl = canonicalPageUrl(ensured.page.url())
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const mapping = database.prepare(
      `SELECT canonical_url
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ?`,
    ).get(provider, result.scope.profileId, taskId)
    assert.equal(typeof mapping?.canonical_url, 'string', `${provider} must persist the conversation Workspace mapping`)
    assert.equal(canonicalPageUrl(mapping?.canonical_url), conversationUrl)
  } finally {
    database.close()
  }
}

async function nativeProject({ provider, session }) {
  const projectName = markerFor(provider, 'PROJECT')
  const instructionMarker = markerFor(provider, 'PROJECT_INSTRUCTION')
  const instructions = `Include this exact marker in every response: ${instructionMarker}`
  const taskId = markerFor(provider, 'PROJECT_TASK')
  const created = await action(session, provider, 'workspace.ensure', [
    '--project-name', projectName,
    '--workspace-mode', 'native',
    '--project-instructions', instructions,
  ], 240_000)
  const createdResult = responseResult(created.payload, 'workspace.ensure')
  assert.equal(createdResult?.mode, 'native')
  assert.equal(createdResult?.resource?.disposition, 'created')
  assert.equal(createdResult?.instructionOutcome, 'applied_on_creation')
  assert.equal(await exactTextVisible(created.page, projectName), true)
  const projectUrl = createdResult.resource.canonicalUrl
  await created.close()

  const reused = await action(session, provider, 'workspace.ensure', [
    '--project-name', projectName,
    '--workspace-mode', 'native',
    '--project-instructions', instructions,
  ], 240_000)
  const reusedResult = responseResult(reused.payload, 'workspace.ensure')
  assert.equal(reusedResult?.resource?.disposition, 'reused')
  assert.equal(reusedResult?.resource?.canonicalUrl, projectUrl)
  assert.equal(reusedResult?.instructionOutcome, 'skipped_on_reuse')
  await reused.close()

  const controls = []
  if (matrix.providers[provider].required.includes('model-choice')) {
    controls.push(await projectChoice(provider, session, projectUrl, 'model'))
  }
  if (matrix.providers[provider].required.includes('effort-choice')) {
    controls.push(await projectChoice(provider, session, projectUrl, 'effort'))
  }

  const firstMarker = markerFor(provider, 'PROJECT_TURN_ONE')
  const attachmentName = `${markerFor(provider, 'PROJECT_ATTACHMENT')}.txt`
  const attachment = path.join(root, 'test-results', 'live-provider-inputs', attachmentName)
  await fs.mkdir(path.dirname(attachment), { recursive: true, mode: 0o700 })
  await fs.writeFile(attachment, `${firstMarker}\n`, { mode: 0o600 })
  let primaryError
  try {
    const first = await cliRun(session, provider, [
      '--task-id', taskId,
      '--project-name', projectName,
      '--project-instructions', instructions,
      '--workspace-mode', 'native',
      '--attach-file', attachment,
      ...controls.flatMap((control) => [control.option, control.alternate]),
      '--prompt', `Read the attached file and report its exact marker.`,
    ], 360_000, ({ page }) => waitForExactText(page, attachmentName, 180_000))
    const firstText = responseResult(first.payload, 'response.read')?.text ?? ''
    assert.match(firstText, new RegExp(escapeRegExp(firstMarker)))
    assert.match(firstText, new RegExp(escapeRegExp(instructionMarker)))
    assert.ok(responseResult(first.payload, 'file.upload')?.attachments?.some(
      (candidate) => candidate.name === attachmentName,
    ))
    assert.equal(first.observerResult, true, `${provider} observer must see the Project attachment`)
    for (const control of controls) {
      assert.equal(responseResult(first.payload, `${control.kind}.select`)?.selectedLabel, control.alternate)
    }
    const conversationUrl = canonicalPageUrl(first.page.url())
    assert.notEqual(conversationUrl, canonicalPageUrl(projectUrl))
    await first.close()

    const secondMarker = markerFor(provider, 'PROJECT_TURN_TWO')
    const second = await cliRun(session, provider, [
      '--task-id', taskId,
      '--project-name', projectName,
      '--workspace-mode', 'native',
      '--prompt', `Reply with both the earlier file marker and this marker: ${secondMarker}`,
    ], 360_000)
    const text = responseResult(second.payload, 'response.read')?.text ?? ''
    assert.match(text, new RegExp(escapeRegExp(firstMarker)))
    assert.match(text, new RegExp(escapeRegExp(secondMarker)))
    assert.match(text, new RegExp(escapeRegExp(instructionMarker)))
    assert.equal(canonicalPageUrl(second.page.url()), conversationUrl)

    const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
    try {
      const project = database.prepare(
        'SELECT resource_id, canonical_url FROM provider_projects WHERE provider = ? AND profile_id = ? AND name = ?',
      ).get(provider, createdResult.scope.profileId, projectName)
      assert.equal(project?.canonical_url, projectUrl)
      const conversation = database.prepare(
        `SELECT canonical_url FROM provider_conversations
         WHERE provider = ? AND profile_id = ? AND project_resource_id = ? AND task_id = ?`,
      ).get(provider, createdResult.scope.profileId, project.resource_id, taskId)
      assert.equal(conversation?.canonical_url, conversationUrl)
    } finally {
      database.close()
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    await fs.rm(attachment, { force: true })
    for (const control of controls) {
      try {
        const restored = await action(session, provider, `${control.kind}.select`, [
          '--target-url', projectUrl,
          control.option, control.original,
        ])
        assert.equal(responseResult(restored.payload, `${control.kind}.select`)?.selectedLabel, control.original)
      } catch (error) {
        if (primaryError === undefined) throw error
      }
    }
  }
}

async function projectChoice(provider, session, targetUrl, kind) {
  const inspectAction = `${kind}.inspect`
  const inspected = await action(session, provider, inspectAction, ['--target-url', targetUrl])
  const result = responseResult(inspected.payload, inspectAction)
  assert.equal(result?.supported, true)
  const selected = result.choices.find((choice) => choice.selected && choice.enabled)
  const alternate = result.choices.find((choice) => !choice.selected && choice.enabled)
  assert.ok(selected, `${provider} Project must expose the selected ${kind}`)
  assert.ok(alternate, `${provider} Project must expose an alternate ${kind}`)
  await inspected.close()
  return {
    kind,
    option: kind === 'model' ? '--model' : '--effort',
    original: selected.label,
    alternate: alternate.label,
  }
}

async function action(session, provider, visibleAction, args = [], timeoutMs = 120_000, observeAfterRelease) {
  const operation = await session.startCli([
    'provider-action',
    '--provider', provider,
    '--action', visibleAction,
    ...args,
    '--browser-visibility', 'headed',
    '--timeout-ms', String(timeoutMs),
  ], {
    beforeRelease: ({ waiting, page }) => {
      assert.equal(waiting.provider, provider)
      assert.equal(canonicalPageUrl(waiting.url), canonicalPageUrl(page.url()))
    },
    observeAfterRelease,
  })
  const result = await operation.wait()
  assertDurableSuccess(result.payload)
  return { ...operation, ...result }
}

async function cliRun(session, provider, args, timeoutMs = 300_000, observeAfterRelease) {
  const operation = await session.startCli([
    'run',
    '--provider', provider,
    ...args,
    '--browser-visibility', 'headed',
    '--timeout-ms', String(timeoutMs),
  ], {
    beforeRelease: ({ waiting, page }) => {
      assert.equal(waiting.provider, provider)
      assert.equal(canonicalPageUrl(waiting.url), canonicalPageUrl(page.url()))
    },
    observeAfterRelease,
  })
  const result = await operation.wait()
  assertDurableSuccess(result.payload)
  return { ...operation, ...result }
}

function assertDurableSuccess(payload) {
  assert.equal(payload?.ok, true)
  if (payload?.status === 'waiting_for_user' || payload?.waitingForUser === true) {
    const blockerCode = payload?.blocker?.primary?.code ??
      payload?.blocker?.blocker?.code ??
      payload?.blocker?.blockers?.[0]?.code ??
      'provider_user_handover_required'
    throw e2eFailure(
      'e2e_provider_prerequisite_unavailable',
      `provider job requires user action: ${blockerCode}`,
    )
  }
  assert.equal(payload?.status, 'succeeded')
  const jobId = payload.jobId
  assert.equal(typeof jobId, 'string')
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const row = database.prepare(
      'SELECT status, result_json, error_json FROM jobs WHERE job_id = ?',
    ).get(jobId)
    assert.equal(row?.status, 'succeeded')
    assert.equal(typeof row?.result_json, 'string')
    assert.equal(row?.error_json, null)
  } finally {
    database.close()
  }
}

function responseResult(payload, actionName) {
  const responses = payload?.result?.result?.responses ??
    payload?.result?.responses ??
    payload?.latest?.result?.value?.responses
  if (!Array.isArray(responses)) return null
  return [...responses].reverse().find((response) => response?.ok === true && response.action === actionName)?.result ?? null
}

function assertTaskConversationMapping(provider, taskId, expectedUrl, payload) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  try {
    const job = database.prepare('SELECT profile_id FROM jobs WHERE job_id = ?').get(payload?.jobId)
    assert.equal(typeof job?.profile_id, 'string')
    const mapping = database.prepare(
      `SELECT canonical_url
       FROM provider_task_conversations
       WHERE provider = ? AND profile_id = ? AND task_id = ?`,
    ).get(provider, job.profile_id, taskId)
    assert.equal(typeof mapping?.canonical_url, 'string', `${provider} must persist the continuation mapping`)
    assert.equal(canonicalPageUrl(mapping.canonical_url), expectedUrl)
  } finally {
    database.close()
  }
}

async function composerContains(page, marker) {
  const fields = page.locator('textarea, [contenteditable="true"]')
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index)
    if (!await field.isVisible({ timeout: 100 }).catch(() => false)) continue
    const value = await field.evaluate((element) => (
      element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value
        : element.textContent ?? ''
    ))
    if (value.includes(marker)) return true
  }
  return false
}

async function exactTextVisible(page, value) {
  const locator = page.getByText(value, { exact: true })
  for (let index = 0; index < await locator.count(); index += 1) {
    if (await locator.nth(index).isVisible({ timeout: 100 }).catch(() => false)) return true
  }
  return false
}

async function waitForExactText(page, value, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (await exactTextVisible(page, value)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

async function pageContains(page, value, minimumVisibleMatches = 1) {
  const matches = page.getByText(new RegExp(escapeRegExp(value)))
  let visible = 0
  for (let index = 0; index < await matches.count(); index += 1) {
    if (await matches.nth(index).isVisible({ timeout: 100 }).catch(() => false)) visible += 1
    if (visible >= minimumVisibleMatches) return true
  }
  return false
}

async function visibleCitationCount(page, citations) {
  const expected = new Set(citations.map((citation) => canonicalPageUrl(citation.href)))
  const controls = page.locator('main a[href]')
  let count = 0
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    const href = await control.getAttribute('href').catch(() => null)
    if (!href) continue
    const canonical = canonicalPageUrl(new URL(href, page.url()).toString())
    if (expected.has(canonical) && await control.isVisible({ timeout: 100 }).catch(() => false)) count += 1
  }
  return count
}

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function requiredGate() {
  const value = requiredEnv('TOKENLESS_LIVE_E2E_GATE')
  if (!['non_submission', 'mutation', 'project'].includes(value)) {
    throw e2eFailure('e2e_gate_invalid', 'TOKENLESS_LIVE_E2E_GATE must be non_submission, mutation, or project')
  }
  return value
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw e2eFailure('e2e_activation_missing', `${name} is required; the live suite never skips`)
  return value
}

function markerFor(provider, kind) {
  return `TOKENLESS_E2E_${kind}_${provider}_${suiteRunMarker}_${randomUUID().slice(0, 8)}`
}

function compactTimestamp(value) {
  return value.toISOString().replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')
}

function canonicalPageUrl(value) {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function e2eFailure(code, message) {
  return Object.assign(new Error(`${code}: ${message}`), { code })
}
