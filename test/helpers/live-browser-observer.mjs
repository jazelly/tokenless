import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import { getProviderInstanceForUrl } from '../../packages/cli/dist/src/playwright/index.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const daemonEntry = path.join(root, 'packages/cli/dist/src/daemon/daemon-entry.mjs')
const protocol = 'tokenless.e2e-browser-inspection.v3'
const pollMs = 50
const daemonStopTimeoutMs = 60_000
const defaultDaemonUrl = 'http://127.0.0.1:7331'

export async function createLiveBrowserInspectionSession(options) {
  const homeDir = path.resolve(requiredString(options.homeDir, 'homeDir'))
  const profileSlug = requiredString(options.profileSlug, 'profileSlug')
  const requestedDaemonUrl = options.daemonUrl === undefined ? undefined : requiredString(options.daemonUrl, 'daemonUrl')
  const daemonUrl = requestedDaemonUrl ?? await configuredDaemonUrl(homeDir) ?? defaultDaemonUrl
  const runId = `e2e-${randomUUID()}`
  const nonce = randomBytes(32).toString('base64url')
  const env = {
    ...process.env,
    TOKENLESS_PROVIDER: '',
    TOKENLESS_E2E_BROWSER_INSPECTION: '1',
    TOKENLESS_E2E_RUN_ID: runId,
    TOKENLESS_E2E_NONCE: nonce,
    TOKENLESS_E2E_OBSERVER_TIMEOUT_MS: String(options.observerTimeoutMs ?? 30_000),
  }
  for (const name of [
    'CODEX_THREAD_ID',
    'TOKENLESS_AGENT_KIND',
    'TOKENLESS_AGENT_SESSION_ID',
    'TOKENLESS_AGENT_SESSION_TREE_ID',
    'TOKENLESS_AGENT_TOOL_CALL_ID',
    'TOKENLESS_AGENT_TURN_ID',
  ]) delete env[name]
  const barrierRoot = path.join(homeDir, 'e2e', 'browser-inspection', runId)
  const runKey = createHash('sha256').update(runId).digest('base64url').slice(0, 16)
  const jobPrefix = `tlp_e2e_${runKey}_`
  const seenBarriers = new Set()
  const observerBrowsers = new Map()

  await stopExistingDaemons({ homeDir, daemonUrl })
  const daemon = spawnInspectionDaemon({ homeDir, daemonUrl, env })
  const daemonOutput = collectChildOutput(daemon)
  try {
    await waitForInspectionDaemon({ homeDir, daemonUrl, daemonOutput })
  } catch (error) {
    await stopInspectionDaemon(daemon, daemonOutput)
    throw error
  }

  const observeNextAttempt = async (observeOptions = {}) => {
    const waiting = await waitForWaitingBarrier({
      barrierRoot,
      nonce,
      jobPrefix,
      seenBarriers,
      expectedJobId: observeOptions.jobId,
      childOutput: observeOptions.childOutput,
      timeoutMs: observeOptions.timeoutMs ?? 120_000,
    })
    seenBarriers.add(barrierIdentity(waiting))
    const observer = await connectObserver(waiting, observerBrowsers)
    await observeOptions.beforeRelease?.({ waiting, page: observer.page })
    const observation = observeOptions.observeAfterRelease === undefined
      ? Promise.resolve(undefined)
      : Promise.resolve().then(() => observeOptions.observeAfterRelease({ waiting, page: observer.page }))
    await releaseBarrier({ barrierRoot, waiting, runId, nonce })
    return {
      waiting,
      page: observer.page,
      async wait() {
        return await observation
      },
      async close() {
        // Keep one observer connection per managed browser endpoint for the journey.
        // Closing a connectOverCDP Browser can terminate Cloak's persistent context.
      },
    }
  }

  return {
    runId,
    homeDir,
    daemonUrl,
    profileSlug,
    environment: Object.freeze({ ...env }),
    createJobId() {
      return `${jobPrefix}${randomUUID()}`
    },
    observeNextAttempt,
    async startCli(args, startOptions = {}) {
      const commandArgs = [
        ...args,
        '--profile', profileSlug,
        '--home', homeDir,
        ...(daemonUrl ? ['--daemon-url', daemonUrl] : []),
        '--json',
      ]
      const child = spawn(process.execPath, [cliEntry, ...commandArgs], {
        cwd: root,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      const output = collectChildOutput(child)
      const attempt = await observeNextAttempt({
        childOutput: output,
        timeoutMs: startOptions.startTimeoutMs ?? 120_000,
        beforeRelease: startOptions.beforeRelease,
        observeAfterRelease: startOptions.observeAfterRelease,
      })
      return {
        waiting: attempt.waiting,
        page: attempt.page,
        async wait() {
          const [result, observerResult] = await Promise.all([output.exit, attempt.wait()])
          return {
            ...result,
            payload: parseJsonOutput(result),
            observerResult,
          }
        },
        async close() {
          await attempt.close()
        },
      }
    },
    async close() {
      const canceledJobs = cancelRunJobs({ homeDir, daemonUrl, env, jobPrefix })
      for (const browser of observerBrowsers.values()) unrefCdpObserver(browser)
      observerBrowsers.clear()
      const result = runCliSync([
        'daemon', 'stop',
        '--home', homeDir,
        ...(daemonUrl ? ['--daemon-url', daemonUrl] : []),
        '--timeout-ms', String(daemonStopTimeoutMs),
        '--json',
      ], env)
      await stopInspectionDaemon(daemon, daemonOutput)
      await fs.rm(barrierRoot, { recursive: true, force: true }).catch(() => undefined)
      assertCliSuccess(result, 'stop the E2E inspection daemon')
      for (const canceled of canceledJobs) {
        assertCliSuccess(canceled.result, `cancel E2E inspection job ${canceled.jobId}`)
      }
      return { ...result, canceledJobs }
    },
  }
}

function unrefCdpObserver(browser) {
  try {
    const implementation = browser?._connection?.toImpl?.(browser)
    const socket = implementation?._connection?._transport?._ws?._socket
    if (socket && typeof socket.unref === 'function') socket.unref()
  } catch {
    // A browser that already disconnected has no observer socket to unref.
  }
}

function cancelRunJobs({ homeDir, daemonUrl, env, jobPrefix }) {
  const database = new DatabaseSync(path.join(homeDir, 'tokenless.sqlite3'), { readOnly: true })
  let rows
  try {
    rows = database.prepare(
      `SELECT job_id
       FROM jobs
       WHERE substr(job_id, 1, length(?)) = ?
         AND status IN ('queued', 'claimed', 'running', 'waiting_for_user')
       ORDER BY created_at, job_id`,
    ).all(jobPrefix, jobPrefix)
  } finally {
    database.close()
  }
  return rows.map(({ job_id: jobId }) => ({
    jobId,
    result: runCliSync([
      'cancel',
      '--job-id', jobId,
      '--home', homeDir,
      ...(daemonUrl ? ['--daemon-url', daemonUrl] : []),
      '--json',
    ], env),
  }))
}

async function waitForWaitingBarrier(options) {
  const deadline = Date.now() + options.timeoutMs
  while (Date.now() <= deadline) {
    const exited = options.childOutput?.settled()
    const waiting = await findWaitingBarrier(
      options.barrierRoot,
      options.seenBarriers,
      options.jobPrefix,
      options.expectedJobId,
    )
    if (waiting) {
      assert.equal(waiting.protocol, protocol)
      assert.equal(waiting.nonce, options.nonce)
      assert.equal(Number.isSafeInteger(waiting.daemonPid), true)
      assert.match(waiting.pageRefHash ?? '', /^[A-Za-z0-9_-]{20}$/)
      assert.equal(typeof waiting.reusedPageBinding, 'boolean')
      assert.equal(typeof waiting.jobId, 'string')
      assert.equal(typeof waiting.profileId, 'string')
      assert.equal(typeof waiting.profileDirectory, 'string')
      assert.equal(typeof waiting.provider, 'string')
      assert.equal(typeof waiting.url, 'string')
      assert.match(waiting.targetId ?? '', /^[A-Fa-f0-9]{16,128}$/)
      return waiting
    }
    if (exited) {
      throw new Error(`CLI exited before reaching the browser observer barrier:\n${summarizeProcess(exited)}`)
    }
    await delay(pollMs)
  }
  throw new Error(`Timed out after ${options.timeoutMs}ms waiting for the browser observer barrier.`)
}

async function findWaitingBarrier(barrierRoot, seenBarriers, jobPrefix, expectedJobId) {
  let entries
  try {
    entries = await fs.readdir(barrierRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(jobPrefix)) continue
    if (expectedJobId !== undefined && entry.name !== expectedJobId) continue
    const waitingPath = path.join(barrierRoot, entry.name, 'waiting.json')
    try {
      const waiting = JSON.parse(await fs.readFile(waitingPath, 'utf8'))
      if (seenBarriers.has(barrierIdentity(waiting))) continue
      return waiting
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) continue
      throw error
    }
  }
  return null
}

function barrierIdentity(waiting) {
  return `${String(waiting?.jobId ?? '')}:${String(waiting?.waitingAt ?? '')}`
}

async function connectObserver(waiting, observerBrowsers) {
  const endpointFile = path.join(path.resolve(waiting.profileDirectory), 'DevToolsActivePort')
  const deadline = Date.now() + 30_000
  let endpoint
  while (Date.now() <= deadline) {
    try {
      const [port, websocketPath] = (await fs.readFile(endpointFile, 'utf8')).trim().split(/\r?\n/u)
      assert.match(port ?? '', /^\d+$/)
      assert.match(websocketPath ?? '', /^\/devtools\/browser\/[A-Za-z0-9-]+$/)
      endpoint = `http://127.0.0.1:${port}`
      break
    } catch (error) {
      if (!isMissingFileError(error)) throw error
    }
    await delay(pollMs)
  }
  if (!endpoint) throw new Error('Current DevToolsActivePort was not available for E2E inspection.')
  let browser = observerBrowsers.get(endpoint)
  if (!browser?.isConnected()) {
    browser = await chromium.connectOverCDP(endpoint)
    observerBrowsers.set(endpoint, browser)
  }
  const contexts = browser.contexts()
  assert.equal(contexts.length, 1, 'managed persistent browser must expose exactly one CDP context')
  const expectedUrl = canonicalObservedUrl(waiting.url)
  const page = await waitForExpectedPage(contexts[0], waiting.targetId, expectedUrl, waiting.provider)
  if (!page) {
    throw new Error(`CDP observer did not find the product page at ${expectedUrl}.`)
  }
  return { browser, page }
}

async function releaseBarrier({ barrierRoot, waiting, runId, nonce }) {
  const target = path.join(barrierRoot, waiting.jobId, 'release.json')
  const temporary = `${target}.${process.pid}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify({
    protocol,
    runId,
    jobId: waiting.jobId,
    nonce,
  }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  await fs.rename(temporary, target)
}

async function stopExistingDaemons({ homeDir, daemonUrl }) {
  const configured = await configuredDaemonUrl(homeDir)
  const targets = [...new Set([daemonUrl, configured].filter(Boolean))]
  if (targets.length === 0) targets.push(undefined)
  for (const target of targets) {
    const result = runCliSync([
      'daemon', 'stop',
      '--home', homeDir,
      ...(target ? ['--daemon-url', target] : []),
      '--timeout-ms', String(daemonStopTimeoutMs),
      '--json',
    ])
    if (result.status !== 0) {
      throw new Error(`Unable to stop the existing Tokenless daemon before E2E inspection:\n${summarizeProcess(result)}`)
    }
  }
}

async function configuredDaemonUrl(homeDir) {
  try {
    const config = JSON.parse(await fs.readFile(path.join(homeDir, 'config.json'), 'utf8'))
    return typeof config.daemonUrl === 'string' && config.daemonUrl ? config.daemonUrl : undefined
  } catch (error) {
    if (isMissingFileError(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}

function spawnInspectionDaemon({ homeDir, daemonUrl, env }) {
  const address = localDaemonAddress(daemonUrl)
  return spawn(process.execPath, [
    daemonEntry,
    '--home', homeDir,
    'serve',
    '--host', address.host,
    '--port', String(address.port),
  ], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function localDaemonAddress(daemonUrl) {
  const parsed = new URL(daemonUrl)
  const host = parsed.hostname
  const port = parsed.port === '' ? 80 : Number(parsed.port)
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(host) ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('Live browser inspection requires a loopback HTTP daemon URL.')
  }
  return { host, port }
}

async function waitForInspectionDaemon({ homeDir, daemonUrl, daemonOutput }) {
  const deadline = Date.now() + 10_000
  let latestError
  while (Date.now() <= deadline) {
    const exited = daemonOutput.settled()
    if (exited) {
      throw new Error(`E2E inspection daemon exited before readiness:\n${summarizeProcess(exited)}`)
    }
    try {
      const challenge = randomBytes(32).toString('base64url')
      const response = await fetch(`${daemonUrl}/ready?challenge=${challenge}`)
      const body = await response.json().catch(() => null)
      if (response.ok && body?.ready === true && body?.home_dir === homeDir) return
    } catch (error) {
      latestError = error
    }
    await delay(pollMs)
  }
  throw new Error(`E2E inspection daemon did not become ready: ${latestError?.message ?? latestError ?? 'unknown'}`)
}

async function stopInspectionDaemon(child, daemonOutput) {
  if (daemonOutput.settled()) return
  const graceful = await Promise.race([
    daemonOutput.exit.then(() => true),
    delay(5_000).then(() => false),
  ])
  if (graceful) return
  child.kill('SIGTERM')
  const terminated = await Promise.race([
    daemonOutput.exit.then(() => true),
    delay(5_000).then(() => false),
  ])
  if (terminated) return
  child.kill('SIGKILL')
  await daemonOutput.exit
}

function collectChildOutput(child) {
  let stdout = ''
  let stderr = ''
  let settled = null
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exit = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (status, signal) => {
        settled = { status, signal, stdout, stderr }
        resolve(settled)
      })
    })
  return {
    exit,
    settled() {
      return settled
    },
  }
}

function runCliSync(args, env = process.env) {
  const result = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: daemonStopTimeoutMs + 10_000,
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

function assertCliSuccess(result, action) {
  if (result.status !== 0) {
    throw new Error(`Unable to ${action}:\n${summarizeProcess(result)}`)
  }
  let payload
  try {
    payload = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`Unable to ${action}: CLI did not return JSON: ${error.message}\n${summarizeProcess(result)}`)
  }
  if (payload?.ok !== true) {
    throw new Error(`Unable to ${action}: CLI did not confirm success:\n${summarizeProcess(result)}`)
  }
}

function parseJsonOutput(result) {
  if (result.status !== 0) {
    throw new Error(`CLI failed:\n${summarizeProcess(result)}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(`CLI did not return JSON: ${error.message}\n${summarizeProcess(result)}`)
  }
}

function canonicalObservedUrl(value) {
  const parsed = new URL(value)
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

async function waitForExpectedPage(context, expectedTargetId, expectedUrl, expectedProvider) {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    for (const page of context.pages()) {
      if (await pageTargetId(context, page) !== expectedTargetId) continue
      const observedUrl = canonicalObservedUrl(page.url())
      if (
        observedUrl !== expectedUrl &&
        getProviderInstanceForUrl(observedUrl)?.id !== expectedProvider
      ) {
        throw new Error(`CDP target ${expectedTargetId} resolved to an unexpected page URL.`)
      }
      return page
    }
    await delay(pollMs)
  }
  return null
}

async function pageTargetId(context, page) {
  if (page.isClosed()) return null
  const session = await context.newCDPSession(page).catch(() => null)
  if (!session) return null
  try {
    return (await session.send('Target.getTargetInfo')).targetInfo.targetId
  } catch {
    return null
  } finally {
    await session.detach().catch(() => undefined)
  }
}

function summarizeProcess(result) {
  return JSON.stringify({
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    stdout: truncate(result.stdout),
    stderr: truncate(result.stderr),
  }, null, 2)
}

function truncate(value) {
  return typeof value === 'string' && value.length > 2_000 ? `${value.slice(0, 2_000)}...[truncated]` : value
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`)
  return value.trim()
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isMissingFileError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
