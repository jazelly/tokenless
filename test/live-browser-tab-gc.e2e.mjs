import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

// Run through ego-browser nodejs; all browser mutations use the packaged
// production page manager. These are browser lifecycle checks, not provider replicas.
export async function verifyTabGcLifecycle({ packageRoot = path.resolve('packages/cli'), log = () => {} } = {}) {
  const target = await resolveConfiguredBrowserTarget()
  const { PersistentContextManager } = await import(pathToFileURL(path.join(packageRoot, 'dist/server/src/browser/browser/context-manager.js')).href)
  const manager = new PersistentContextManager({
    tabGc: target.config.browserTabGc,
    browser: {
      id: target.runtime.browserId,
      executablePath: target.runtime.executablePath,
      runtimeId: target.runtime.runtimeId,
      launchPolicy: target.runtime.launchPolicy,
    },
  })
  const uses = []
  try {
    const context = await manager.ensureContext(target.profile, target.config.browserVisibility)
    const baseline = context.browserContext.pages()
    const count = target.config.browserTabGc.maxTabsPerProfile
    assert.ok(count >= 3, 'GC acceptance needs capacity for three work tabs')
    const prefix = `page:tab-gc:${randomUUID()}`
    const userPage = await context.acquireProviderPage({
      provider: 'chatgpt', pageRef: `${prefix}:user`, purpose: 'user',
      matchesExistingPage: (page) => baseline.includes(page) && page.url() === 'about:blank',
    })
    userPage.release(true)
    const acquire = async (ref) => {
      const use = await context.acquireProviderPage({ provider: 'chatgpt', pageRef: ref })
      uses.push(use)
      return use
    }
    const initial = await Promise.all(Array.from({ length: count }, (_, i) => acquire(`${prefix}:${i}`)))
    await assert.rejects(acquire(`${prefix}:full`), { code: 'browser_tab_capacity_reached' })
    assert.equal(initial.some((use) => use.page.isClosed()), false)
    initial[0].release(true)
    const replacement = await acquire(`${prefix}:replacement`)
    assert.equal(initial[0].page.isClosed(), true)
    assert.equal(initial[1].page.isClosed(), false)
    assert.equal(manager.tabGcStatus().capacity, 1)
    log({ check: 'capacity and busy protection', passed: true, profile: target.profile.slug, visibility: context.effectiveBrowserVisibility, workTabs: count })

    const busy = initial[1]
    const reset = initial[2]
    for (const use of [...initial.slice(2), replacement]) use.release(true)
    const ttl = target.config.browserTabGc.idleTimeoutSeconds * 1000
    const sweep = target.config.browserTabGc.sweepIntervalSeconds * 1000
    await delay(Math.floor(ttl * 0.6))
    assert.equal(reset.page.isClosed(), false)
    const reused = await acquire(`${prefix}:2`)
    assert.equal(reused.page, reset.page)
    reused.release(true)
    log({ check: 'idle page reused before expiry', passed: true })
    await delay(Math.ceil(ttl * 0.4) + sweep + 1000)
    assert.equal(busy.page.isClosed(), false)
    assert.equal(reset.page.isClosed(), false, 'a new use must reset the idle clock')
    assert.equal(replacement.page.isClosed(), true)
    assert.ok(manager.tabGcStatus().expired >= count - 2)
    assert.equal(userPage.page.isClosed(), false, 'user pages must be preserved')
    log({ check: 'expiry, reset clock, busy and user-page protection', passed: true, status: manager.tabGcStatus() })

    busy.release(true)
    const deadline = Date.now() + ttl + sweep + 5000
    while (uses.some((use) => !use.page.isClosed()) && Date.now() < deadline) await delay(1000)
    assert.ok(uses.every((use) => use.page.isClosed()), 'the production collector must release the test work tabs')
    assert.equal(manager.tabGcStatus().profiles[0].workPages, 0)
    log({ check: 'all idle test pages reclaimed', passed: true, status: manager.tabGcStatus() })
  } finally {
    for (const use of uses) use.release(false)
    await manager.detach()
  }
}

export async function verifyTabGcConversation({ packageRoot = path.resolve('packages/cli'), nodeExecutable = 'node', log = () => {} } = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const fs = await import('node:fs/promises')
  const { DatabaseSync } = await import('node:sqlite')
  const target = await resolveConfiguredBrowserTarget()
  const id = `tab-gc-${randomUUID()}`
  const code = randomUUID().slice(0, 8)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TOKENLESS_AGENT_') || key === 'CODEX_THREAD_ID') delete env[key]
  const run = async (prompt) => {
    const started = Date.now()
    const { stdout } = await promisify(execFile)(nodeExecutable, [
      path.join(packageRoot, 'dist/src/tokenless.mjs'), 'run', '--home', target.homeDir,
      '--profile', target.profile.slug, '--provider', 'chatgpt', '--chat-surface', 'chat',
      '--task-id', id, '--page-ref', id, '--prompt', prompt, '--timeout-ms', '180000', '--json',
    ], { env, timeout: 200000, maxBuffer: 2000000 }).catch((error) => {
      let result
      try { result = JSON.parse(error.stdout) } catch {}
      throw new Error(JSON.stringify({ check: 'CLI provider turn', code: error.code, killed: error.killed, signal: error.signal, status: result?.status, error: result?.error }))
    })
    const result = JSON.parse(stdout)
    assert.equal(result.status, 'succeeded')
    const answer = result.result?.result?.responses?.find((response) => response.action === 'response.read')?.result?.text
    assert.equal(typeof answer, 'string')
    assert.ok(answer.includes(code), 'the provider must return the verification code from this conversation')
    log({ check: 'provider turn completed', jobId: result.jobId, elapsedMs: Date.now() - started })
    return result
  }
  const targets = async () => {
    const lines = (await fs.readFile(path.join(target.profile.directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
    const response = await fetch(`http://127.0.0.1:${Number(lines[0])}/json/list`, { signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200)
    return await response.json()
  }
  const first = await run(`For this conversation only, the verification code is ${code}. Do not update saved memory. Reply with just that code.`)
  const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
  let url
  try {
    url = database.prepare('SELECT canonical_url FROM provider_task_conversations WHERE provider = ? AND profile_id = ? AND task_id = ?').get('chatgpt', target.profile.slug, id)?.canonical_url
  } finally { database.close() }
  assert.ok(url?.startsWith('https://chatgpt.com/c/'))
  const findTab = async () => (await targets()).find((tab) => tab.type === 'page' && tab.url === url)
  const original = await findTab()
  assert.ok(original, 'completed conversation must remain open during idle retention')
  await run('What verification code appeared earlier in this conversation? Reply with only the code. Do not update saved memory.')
  assert.equal((await findTab())?.id, original.id, 'continuation inside the retention window must reuse the tab')
  log({ check: 'real conversation reuses idle tab', passed: true })
  const started = Date.now()
  const ttl = target.config.browserTabGc.idleTimeoutSeconds * 1000
  const deadline = started + ttl + target.config.browserTabGc.sweepIntervalSeconds * 1000 + 15000
  while (await findTab()) {
    assert.ok(Date.now() < deadline, 'idle conversation was not reclaimed within the collection window')
    await delay(1000)
  }
  assert.ok(Date.now() - started >= ttl - 5000, 'collector closed the idle tab too early')
  log({ check: 'real conversation tab expired', passed: true, elapsedMs: Date.now() - started })
  await run('What verification code appeared earlier in this conversation? Reply with only the code. Do not update saved memory.')
  const reopened = await findTab()
  assert.ok(reopened, 'continuation must reopen the saved conversation URL')
  assert.notEqual(reopened.id, original.id)
  log({ check: 'original conversation reopened after GC', passed: true, firstJobId: first.jobId })
}
