import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const cliEntry = path.join(root, 'packages/cli/dist/src/tokenless.mjs')
const protocol = 'tokenless.e2e-browser-inspection.v2'
const pollMs = 50
const daemonStopTimeoutMs = 60_000

export async function createLiveBrowserInspectionSession(options) {
  const homeDir = path.resolve(requiredString(options.homeDir, 'homeDir'))
  const profileSlug = requiredString(options.profileSlug, 'profileSlug')
  const daemonUrl = options.daemonUrl === undefined ? undefined : requiredString(options.daemonUrl, 'daemonUrl')
  const runId = `e2e-${randomUUID()}`
  const nonce = randomBytes(32).toString('base64url')
  const startedAt = Date.now()
  const env = {
    ...process.env,
    TOKENLESS_PROVIDER: '',
    TOKENLESS_E2E_BROWSER_INSPECTION: '1',
    TOKENLESS_E2E_RUN_ID: runId,
    TOKENLESS_E2E_NONCE: nonce,
    TOKENLESS_E2E_OBSERVER_TIMEOUT_MS: String(options.observerTimeoutMs ?? 30_000),
  }
  const barrierRoot = path.join(homeDir, 'e2e', 'browser-inspection', runId)
  const runKey = createHash('sha256').update(runId).digest('base64url').slice(0, 16)
  const jobPrefix = `tlp_e2e_${runKey}_`
  const seenJobs = new Set()
  const observers = new Set()

  await stopExistingDaemons({ homeDir, daemonUrl })

  return {
    runId,
    homeDir,
    profileSlug,
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
      const waiting = await waitForWaitingBarrier({
        barrierRoot,
        nonce,
        jobPrefix,
        seenJobs,
        childOutput: output,
        timeoutMs: startOptions.startTimeoutMs ?? 120_000,
      })
      seenJobs.add(waiting.jobId)
      const observer = await connectObserver(waiting, startedAt)
      observers.add(observer.browser)
      await startOptions.beforeRelease?.({ waiting, page: observer.page })
      const observation = startOptions.observeAfterRelease === undefined
        ? Promise.resolve(undefined)
        : Promise.resolve().then(() => startOptions.observeAfterRelease({ waiting, page: observer.page }))
      await releaseBarrier({ barrierRoot, waiting, runId, nonce })
      return {
        waiting,
        page: observer.page,
        async wait() {
          const [result, observerResult] = await Promise.all([output.exit, observation])
          return {
            ...result,
            payload: parseJsonOutput(result),
            observerResult,
          }
        },
        async close() {
          await observer.browser.close()
          observers.delete(observer.browser)
        },
      }
    },
    async close() {
      const canceledJobs = cancelRunJobs({ homeDir, daemonUrl, env, jobPrefix })
      await Promise.allSettled([...observers].map((browser) => browser.close()))
      observers.clear()
      const result = runCliSync([
        'daemon', 'stop',
        '--home', homeDir,
        ...(daemonUrl ? ['--daemon-url', daemonUrl] : []),
        '--timeout-ms', String(daemonStopTimeoutMs),
        '--json',
      ], env)
      await fs.rm(barrierRoot, { recursive: true, force: true }).catch(() => undefined)
      assertCliSuccess(result, 'stop the E2E inspection daemon')
      for (const canceled of canceledJobs) {
        assertCliSuccess(canceled.result, `cancel E2E inspection job ${canceled.jobId}`)
      }
      return { ...result, canceledJobs }
    },
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
    const exited = options.childOutput.settled()
    const waiting = await findWaitingBarrier(options.barrierRoot, options.seenJobs, options.jobPrefix)
    if (waiting) {
      assert.equal(waiting.protocol, protocol)
      assert.equal(waiting.nonce, options.nonce)
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

async function findWaitingBarrier(barrierRoot, seenJobs, jobPrefix) {
  let entries
  try {
    entries = await fs.readdir(barrierRoot, { withFileTypes: true })
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(jobPrefix) || seenJobs.has(entry.name)) continue
    const waitingPath = path.join(barrierRoot, entry.name, 'waiting.json')
    try {
      return JSON.parse(await fs.readFile(waitingPath, 'utf8'))
    } catch (error) {
      if (isMissingFileError(error) || error instanceof SyntaxError) continue
      throw error
    }
  }
  return null
}

async function connectObserver(waiting, sessionStartedAt) {
  const endpointFile = path.join(path.resolve(waiting.profileDirectory), 'DevToolsActivePort')
  const deadline = Date.now() + 30_000
  let endpoint
  while (Date.now() <= deadline) {
    try {
      const stat = await fs.stat(endpointFile)
      if (stat.mtimeMs + 2_000 < sessionStartedAt) {
        throw new Error('DevToolsActivePort predates the current E2E inspection session.')
      }
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
  const browser = await chromium.connectOverCDP(endpoint)
  const contexts = browser.contexts()
  assert.equal(contexts.length, 1, 'managed persistent browser must expose exactly one CDP context')
  const expectedUrl = canonicalObservedUrl(waiting.url)
  const page = await waitForExpectedPage(contexts[0], waiting.targetId, expectedUrl)
  if (!page) {
    await browser.close()
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

async function waitForExpectedPage(context, expectedTargetId, expectedUrl) {
  const deadline = Date.now() + 10_000
  while (Date.now() <= deadline) {
    for (const page of context.pages()) {
      if (await pageTargetId(context, page) !== expectedTargetId) continue
      if (canonicalObservedUrl(page.url()) !== expectedUrl) {
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
