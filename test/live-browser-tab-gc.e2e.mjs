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


// The user explicitly requested verification across the existing registered
// profiles and daemon restarts. This never creates or changes a browser profile.
export async function verifyTabSupervision({ packageRoot, nodeExecutable, residentBaseline = [], log = () => {} }) {
  const fs = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { DatabaseSync } = await import('node:sqlite')
  const target = await resolveConfiguredBrowserTarget()
  const { ManagedProfileRegistry } = await import(pathToFileURL(path.join(packageRoot, 'dist/server/src/browser/profiles/registry.js')).href)
  const profiles = await new ManagedProfileRegistry(target.homeDir).listProfiles()
  assert.ok(profiles.length >= 2, 'multi-profile acceptance requires two existing registered profiles')
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('TOKENLESS_AGENT_') || key === 'CODEX_THREAD_ID') delete env[key]
  const cli = async (args) => {
    const { stdout } = await promisify(execFile)(nodeExecutable, [path.join(packageRoot, 'dist/src/tokenless.mjs'), ...args, '--home', target.homeDir, '--json'],
      { env, timeout: 200000, maxBuffer: 2000000 }).catch((error) => {
      let result
      try { result = JSON.parse(error.stdout) } catch {}
      throw new Error(JSON.stringify({ code: error.code, error: result?.error }))
    })
    const result = JSON.parse(stdout)
    assert.equal(result.ok, true)
    return result
  }
  const status = async () => {
    const token = (await fs.readFile(path.join(target.homeDir, 'daemon.token'), 'utf8')).trim()
    return await (await fetch(`${target.config.daemonUrl}/v1/private/control/browser-runtime/status`, { headers: { authorization: `Bearer ${token}` } })).json()
  }
  const tabs = async (profile) => {
    const port = (await fs.readFile(path.join(profile.directory, 'DevToolsActivePort'), 'utf8')).split('\n')[0]
    return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((tab) => tab.type === 'page')
  }
  const until = async (check, timeout, message) => {
    const deadline = Date.now() + timeout
    while (!await check()) {
      assert.ok(Date.now() < deadline, message)
      await delay(1000)
    }
  }
  const sweep = target.config.browserTabGc.sweepIntervalSeconds * 1000
  const ttl = target.config.browserTabGc.idleTimeoutSeconds * 1000
  await until(async () => (await status()).tabGc.profiles.filter((profile) => profile.status === 'attached').length === profiles.length,
    sweep * 2 + 10000, 'all resident registered profiles must attach without explicit profile-open calls')
  log({ check: 'all resident profiles automatically supervised', passed: true, profiles: profiles.map((profile) => profile.slug) })
  if (residentBaseline.length) {
    await until(async () => {
      for (const before of residentBaseline) {
        const profile = profiles.find((profile) => profile.slug === before.profile)
        assert.ok(profile)
        if ((await tabs(profile)).some((tab) => before.mapped.includes(tab.id))) return false
      }
      return true
    }, ttl + sweep * 3 + 15000, 'the known idle conversations left by the previous daemon must be reclaimed')
    log({ check: 'previous daemon conversation tabs reclaimed', passed: true, count: residentBaseline.reduce((count, profile) => count + profile.mapped.length, 0), runtime: await status() })
  }
  const database = new DatabaseSync(path.join(target.homeDir, 'tokenless.sqlite3'), { readOnly: true })
  const cases = []
  try {
    for (const profile of profiles.slice(0, 2)) {
      const id = `gc-supervision-${randomUUID()}`
      const code = randomUUID().slice(0, 8)
      const common = ['--profile', profile.slug, '--provider', 'chatgpt', '--task-id', id, '--page-ref', id]
      const result = await cli(['run', ...common, '--chat-surface', 'chat', '--prompt', `For this conversation only, the verification code is ${code}. Do not update saved memory. Reply with only the code.`, '--timeout-ms', '180000'])
      const url = database.prepare('SELECT canonical_url FROM provider_task_conversations WHERE profile_id=? AND task_id=?').get(profile.slug, id)?.canonical_url
      assert.ok(url)
      const tab = (await tabs(profile)).find((tab) => tab.url === url)
      assert.ok(tab)
      cases.push({ profile, id, code, common, url, targetId: tab.id })
      log({ check: 'real profile conversation completed', profile: profile.slug, jobId: result.jobId })
    }
    const [draft, idle] = cases
    await cli(['provider-action', ...draft.common, '--action', 'prompt.input', '--prompt', 'UNSENT GC VERIFICATION DRAFT'])
    const before = await status()
    assert.equal(before.activeJobCount, 0)
    await cli(['daemon', 'stop'])
    await cli(['dashboard', '--no-open'])
    await until(async () => (await status()).tabGc.profiles.filter((profile) => profile.status === 'attached').length === profiles.length,
      sweep * 2 + 10000, 'daemon restart must restore all resident profiles')
    for (const item of cases) assert.ok((await tabs(item.profile)).some((tab) => tab.id === item.targetId), 'daemon restart must preserve the browser targets')
    log({ check: 'daemon restart restored both profiles and preserved targets', passed: true })
    await until(async () => !(await tabs(idle.profile)).some((tab) => tab.id === idle.targetId), ttl + sweep * 2 + 15000,
      'idle conversation in the second profile must be reclaimed after restart')
    assert.ok((await tabs(draft.profile)).some((tab) => tab.id === draft.targetId), 'an unsent draft must survive the complete idle window')
    log({ check: 'second profile reclaimed while draft remained protected', passed: true, runtime: await status() })
    await cli(['provider-action', ...draft.common, '--action', 'prompt.clear'])
    await until(async () => (await status()).tabGc.profiles.find((profile) => profile.profileId === draft.profile.slug)?.idlePages === 1,
      sweep * 2 + 10000, 'clearing the draft must start a new idle window')
    await delay(Math.floor(ttl * 0.6))
    const { PersistentContextManager } = await import(pathToFileURL(path.join(packageRoot, 'dist/server/src/browser/browser/context-manager.js')).href)
    const inspector = new PersistentContextManager({ browser: {
      id: target.runtime.browserId, executablePath: target.runtime.executablePath,
      runtimeId: target.runtime.runtimeId, launchPolicy: target.runtime.launchPolicy,
    } })
    try {
      const context = await inspector.ensureContext(draft.profile, 'auto', true)
      const page = context.browserContext.pages().find((page) => page.url() === draft.url)
      assert.ok(page, 'the known test conversation must still be present before reload')
      await page.reload({ waitUntil: 'domcontentloaded' })
    } finally { await inspector.detach() }
    await delay(Math.ceil(ttl * 0.4) + sweep + 1000)
    assert.ok((await tabs(draft.profile)).some((tab) => tab.id === draft.targetId), 'reloading the conversation must reset its idle clock')
    log({ check: 'same-URL reload reset the idle clock', passed: true })
    await until(async () => !(await tabs(draft.profile)).some((tab) => tab.id === draft.targetId), ttl + sweep * 2 + 15000,
      'previously retained page must become collectible once the draft is cleared')
    log({ check: 'retained draft page reobserved and reclaimed after becoming idle', passed: true })
    const resumed = await cli(['run', ...idle.common, '--chat-surface', 'chat', '--prompt', 'What verification code appeared earlier in this conversation? Reply only with the code. Do not update saved memory.', '--timeout-ms', '180000'])
    const text = resumed.result?.result?.responses?.find((response) => response.action === 'response.read')?.result?.text
    assert.ok(text?.includes(idle.code))
    const reopened = (await tabs(idle.profile)).find((tab) => tab.url === idle.url)
    assert.ok(reopened)
    assert.notEqual(reopened.id, idle.targetId)
    log({ check: 'second profile original conversation resumed after restart and collection', passed: true, jobId: resumed.jobId })
  } finally { database.close() }
}
