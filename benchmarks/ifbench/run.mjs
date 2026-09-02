#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const benchmarkRoot = path.join(root, 'benchmarks', 'ifbench')
const resultsRoot = path.join(benchmarkRoot, 'results')
const revision = JSON.parse(await fs.readFile(path.join(benchmarkRoot, 'revision.json'), 'utf8'))
const NLTK_RESOURCES = [
  { package: 'punkt', path: 'tokenizers/punkt' },
  { package: 'punkt_tab', path: 'tokenizers/punkt_tab' },
  { package: 'stopwords', path: 'corpora/stopwords' },
  { package: 'averaged_perceptron_tagger_eng', path: 'taggers/averaged_perceptron_tagger_eng' },
]
const [command = 'help', ...argv] = process.argv.slice(2)

try {
  if (command === 'inspect') {
    output({ ok: true, ...revision })
  } else if (command === 'prepare') {
    output({ ok: true, prepared: await prepare(argv) })
  } else if (command === 'wiring' || command === 'full') {
    output({ ok: true, run: await runBenchmark(command, argv) })
  } else if (command === 'score') {
    output({ ok: true, score: await scoreExisting(argv) })
  } else if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText())
  } else {
    throw new Error(`Unknown IFBench command: ${command}`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (argv.includes('--json')) output({ ok: false, error: { message } })
  else process.stderr.write(`Error: ${message}\n`)
  process.exitCode = 1
}

async function prepare(args) {
  const checkout = resolveCheckout(args)
  const pinned = await validateCheckout(checkout)
  const result = await runCommand('uv', ['sync', '--frozen'], {
    cwd: checkout,
    capture: true,
  })
  if (result.code !== 0) {
    throw new Error(`IFBench uv.lock installation failed in ${checkout}. Run uv sync --frozen there and inspect the local tool output.`)
  }
  const nltkData = path.join(checkout, '.nltk_data')
  await installNltkData(checkout, nltkData)
  return {
    checkout,
    benchmarkCommit: pinned.benchmarkCommit,
    dataset: pinned.dataset,
    datasetDigest: pinned.datasetDigest,
    taskCount: pinned.taskCount,
    upstreamLockDigest: pinned.upstreamLockDigest,
    installedWith: 'uv sync --frozen',
    nltkData,
    nltkResources: [...NLTK_RESOURCES],
  }
}

async function installNltkData(checkout, nltkData) {
  await fs.mkdir(nltkData, { recursive: true })
  const script = [
    'import nltk',
    'from pathlib import Path',
    `root = Path(${JSON.stringify(nltkData)})`,
    'root.mkdir(parents=True, exist_ok=True)',
    'nltk.data.path[:] = [str(root)]',
    `resources = ${JSON.stringify(NLTK_RESOURCES.map((resource) => [resource.package, resource.path]))}`,
    'for package, resource in resources:',
    '    try:',
    '        nltk.data.find(resource)',
    '    except LookupError:',
    '        if not nltk.download(package, download_dir=str(root), quiet=True):',
    '            raise SystemExit(f"failed to download NLTK resource {package}")',
    '        nltk.data.find(resource)',
  ].join('\n')
  const result = await runCommand('uv', ['run', '--frozen', 'python', '-c', script], {
    cwd: checkout,
    capture: true,
    env: { ...process.env, NLTK_DATA: nltkData },
  })
  if (result.code !== 0) {
    throw new Error(`IFBench local NLTK data preparation failed in ${nltkData}. Required resources: ${NLTK_RESOURCES.map((resource) => resource.package).join(', ')}.`)
  }
}

async function runBenchmark(kind, args) {
  const checkout = resolveCheckout(args)
  await prepare(args)
  const pinned = await validateCheckout(checkout)
  const home = resolveHome(args)
  const daemonToken = await readDaemonToken(home)
  const provider = requiredProvider(args)
  const model = `tokenless/${provider}`
  const apiBase = normalizeApiBase(requiredOption(args, '--api-base'))
  const timeoutMs = timeoutOption(args)
  const tasks = await selectedTasks(pinned.tasks, kind, args)
  const advertisedModels = await assertApiProxy(apiBase, model, daemonToken)
  const runDir = await createResultDirectory(kind, args)
  const startedAt = new Date().toISOString()
  const responseRows = []
  const taskResults = []

  for (let index = 0; index < tasks.length; index += 1) {
    const task = tasks[index]
    process.stderr.write(`IFBench ${kind}: task ${String(task.key)} (${index + 1}/${tasks.length})\n`)
    const result = await requestTask({ apiBase, model, task, timeoutMs, daemonToken })
    responseRows.push({ prompt: task.prompt, response: result.response })
    taskResults.push({
      key: String(task.key),
      status: result.ok ? 'succeeded' : 'failed',
      httpStatus: result.httpStatus,
      elapsedMs: result.elapsedMs,
      jobId: result.jobId,
      ...(result.routing === null ? {} : { routing: result.routing }),
      ...(result.errorCode === null ? {} : { errorCode: result.errorCode }),
    })
  }

  const responsesPath = path.join(runDir, 'responses.jsonl')
  await writeJsonl(responsesPath, responseRows)
  const official = await evaluateOfficial({
    checkout,
    datasetPath: pinned.datasetPath,
    responsesPath,
    outputDir: runDir,
    tasks,
  })
  const finishedAt = new Date().toISOString()
  const failedTaskCount = taskResults.filter((task) => task.status === 'failed').length
  const report = {
    schema: 'tokenless.ifbench-run.v1',
    benchmark: revision.benchmark,
    kind,
    benchmarkCommit: revision.benchmarkCommit,
    dataset: revision.dataset,
    datasetDigest: revision.datasetDigest,
    taskCount: tasks.length,
    expectedTaskCount: kind === 'full' ? revision.taskCount : 1,
    actualTaskCount: responseRows.length,
    model,
    provider,
    apiBase,
    executionMode: 'browser',
    concurrency: revision.concurrency,
    retryLimit: revision.retryLimit,
    requestTimeoutMs: timeoutMs,
    samplingControls: 'not sent; Tokenless browser API controls are not benchmark-controllable',
    startedAt,
    finishedAt,
    failedTaskCount,
    responses: path.relative(runDir, responsesPath),
    official,
    tasks: taskResults,
    revision: { ...revision },
    apiProxy: {
      preflight: 'GET /models succeeded',
      advertisedModel: advertisedModels.includes(model),
    },
  }
  const reportPath = path.join(runDir, 'tokenless-run.json')
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  if (failedTaskCount > 0) {
    throw new Error(`IFBench ${kind} recorded ${failedTaskCount} failed task(s); official evidence is preserved at ${runDir}. No retries were attempted.`)
  }
  return report
}

async function scoreExisting(args) {
  const checkout = resolveCheckout(args)
  await prepare(args)
  const pinned = await validateCheckout(checkout)
  const responsesPath = path.resolve(requiredOption(args, '--responses'))
  await fs.access(responsesPath)
  const tasks = await selectedTasks(pinned.tasks, 'score', args)
  const outputDir = option(args, '--output-dir')
    ? path.resolve(option(args, '--output-dir'))
    : await createResultDirectory('score', args)
  await fs.mkdir(outputDir, { recursive: true })
  const responseLineCount = await countJsonl(responsesPath)
  const official = await evaluateOfficial({
    checkout,
    datasetPath: pinned.datasetPath,
    responsesPath,
    outputDir,
    tasks,
  })
  const result = {
    schema: 'tokenless.ifbench-score.v1',
    benchmark: revision.benchmark,
    benchmarkCommit: revision.benchmarkCommit,
    dataset: revision.dataset,
    datasetDigest: revision.datasetDigest,
    taskCount: tasks.length,
    actualTaskCount: tasks.length,
    responseLineCount,
    responses: responsesPath,
    outputDir,
    official,
    revision: { ...revision },
  }
  const scorePath = path.join(outputDir, 'score.json')
  await fs.writeFile(scorePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { ...result, scorePath }
}

async function validateCheckout(checkout) {
  await fs.access(path.join(checkout, 'run_eval.py'))
  const datasetPath = path.join(checkout, revision.dataset)
  const lockPath = path.join(checkout, revision.upstreamLock)
  await fs.access(datasetPath)
  await fs.access(lockPath)

  const headResult = await runCommand('git', ['-C', checkout, 'rev-parse', 'HEAD'], { capture: true })
  if (headResult.code !== 0) throw new Error(`IFBench checkout is not a readable Git worktree: ${checkout}`)
  const benchmarkCommit = headResult.stdout.trim()
  if (benchmarkCommit !== revision.benchmarkCommit) {
    throw new Error(`IFBench checkout revision mismatch: expected ${revision.benchmarkCommit}, found ${benchmarkCommit} at ${checkout}`)
  }

  const datasetDigest = `sha256:${await sha256File(datasetPath)}`
  if (datasetDigest !== revision.datasetDigest) {
    throw new Error(`IFBench dataset digest mismatch: expected ${revision.datasetDigest}, found ${datasetDigest} at ${datasetPath}`)
  }
  const upstreamLockDigest = `sha256:${await sha256File(lockPath)}`
  if (upstreamLockDigest !== revision.upstreamLockDigest) {
    throw new Error(`IFBench uv.lock digest mismatch: expected ${revision.upstreamLockDigest}, found ${upstreamLockDigest} at ${lockPath}`)
  }
  const tasks = await readJsonl(datasetPath)
  if (tasks.length !== revision.taskCount) {
    throw new Error(`IFBench task count mismatch: expected ${revision.taskCount}, found ${tasks.length} at ${datasetPath}`)
  }
  const seenKeys = new Set()
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task) || task.key === undefined || typeof task.prompt !== 'string') {
      throw new Error(`IFBench dataset contains a task without a key and prompt at ${datasetPath}`)
    }
    const key = String(task.key)
    if (seenKeys.has(key)) throw new Error(`IFBench dataset contains duplicate task key ${key}`)
    seenKeys.add(key)
  }
  return {
    checkout,
    datasetPath,
    benchmarkCommit,
    dataset: revision.dataset,
    datasetDigest,
    upstreamLockDigest,
    taskCount: tasks.length,
    tasks,
  }
}

async function selectedTasks(tasks, kind, args) {
  const requested = repeatedOption(args, '--task')
  if (kind === 'full' && requested.length > 0) {
    throw new Error('IFBench full always runs all 300 pinned tasks; --task is not accepted.')
  }
  if (kind === 'wiring' && requested.length > 1) {
    throw new Error('IFBench wiring accepts at most one --task key.')
  }
  if (kind === 'wiring' && requested.length === 0) {
    return [taskByKey(tasks, revision.wiringTaskKey)]
  }
  if (requested.length === 0) return tasks
  return requested.map((key) => taskByKey(tasks, key))
}

function taskByKey(tasks, key) {
  const task = tasks.find((candidate) => String(candidate.key) === String(key))
  if (!task) throw new Error(`IFBench task key not found in pinned dataset: ${key}`)
  return task
}

async function evaluateOfficial({ checkout, datasetPath, responsesPath, outputDir, tasks }) {
  let selectedDatasetPath = datasetPath
  let tempDir = null
  if (tasks.length !== revision.taskCount) {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-ifbench-'))
    selectedDatasetPath = path.join(tempDir, 'IFBench_selected.jsonl')
    await writeJsonl(selectedDatasetPath, tasks)
  }
  try {
    const responseBase = path.basename(responsesPath).replace(/\.jsonl$/u, '')
    const modelName = responseBase.endsWith('-responses')
      ? responseBase.slice(0, -'-responses'.length)
      : responseBase
    const strictPath = path.join(outputDir, `${modelName}-eval_results_strict.jsonl`)
    const loosePath = path.join(outputDir, `${modelName}-eval_results_loose.jsonl`)
    const result = await runCommand('uv', [
      'run', '--frozen', 'python', '-m', 'run_eval',
      `--input_data=${selectedDatasetPath}`,
      `--input_response_data=${responsesPath}`,
      `--output_dir=${outputDir}`,
    ], {
      cwd: checkout,
      capture: true,
      env: { ...process.env, NLTK_DATA: path.join(checkout, '.nltk_data') },
    })
    if (result.code !== 0) {
      throw new Error(`Official IFBench verifier failed in ${checkout}; run the IFBench prepare command before scoring.`)
    }
    await Promise.all([
      fs.chmod(strictPath, 0o600),
      fs.chmod(loosePath, 0o600),
    ])
    const strict = await summarizeOfficialOutput(strictPath)
    const loose = await summarizeOfficialOutput(loosePath)
    if (strict.promptLevel.total !== tasks.length || loose.promptLevel.total !== tasks.length) {
      throw new Error(`Official IFBench verifier returned ${strict.promptLevel.total}/${loose.promptLevel.total} rows for ${tasks.length} selected task(s).`)
    }
    return {
      verifier: revision.officialVerifier,
      metric: revision.officialMetric,
      strict,
      loose,
      strictPath: path.relative(outputDir, strictPath),
      loosePath: path.relative(outputDir, loosePath),
    }
  } finally {
    if (tempDir !== null) await fs.rm(tempDir, { recursive: true, force: true })
  }
}

async function summarizeOfficialOutput(filePath) {
  const rows = await readJsonl(filePath)
  let promptCorrect = 0
  let instructionTotal = 0
  let instructionCorrect = 0
  for (const row of rows) {
    if (row.follow_all_instructions === true) promptCorrect += 1
    if (Array.isArray(row.follow_instruction_list)) {
      instructionTotal += row.follow_instruction_list.length
      instructionCorrect += row.follow_instruction_list.filter((value) => value === true).length
    }
  }
  return {
    promptLevel: {
      correct: promptCorrect,
      total: rows.length,
      accuracy: rows.length === 0 ? 0 : promptCorrect / rows.length,
    },
    instructionLevel: {
      correct: instructionCorrect,
      total: instructionTotal,
      accuracy: instructionTotal === 0 ? 0 : instructionCorrect / instructionTotal,
    },
    outputRows: rows.length,
  }
}

async function assertApiProxy(apiBase, model, daemonToken) {
  const result = await fetchJson(`${apiBase}/models`, 30_000, {
    headers: { authorization: `Bearer ${daemonToken}` },
  })
  if (result.error !== null) throw new Error(`Tokenless API proxy preflight failed: ${result.error}`)
  if (result.status === 503 && result.body?.error?.code === 'api_proxy_disabled') {
    throw new Error('Tokenless API proxy is disabled. Enable it through the supported Tokenless API config path before running IFBench.')
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(`Tokenless API proxy preflight returned HTTP ${result.status}.`)
  }
  const models = Array.isArray(result.body?.data) ? result.body.data : []
  const ids = models.map((entry) => entry && typeof entry.id === 'string' ? entry.id : '').filter(Boolean)
  if (!ids.includes(model)) {
    throw new Error(`Tokenless API does not advertise model ${model}; choose an enabled provider from GET ${apiBase}/models.`)
  }
  return ids
}

async function requestTask({ apiBase, model, task, timeoutMs, daemonToken }) {
  const started = Date.now()
  const result = await fetchJson(`${apiBase}/chat/completions`, timeoutMs, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${daemonToken}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: task.prompt }],
      tokenless: { execution_mode: 'browser' },
    }),
  })
  const elapsedMs = Date.now() - started
  if (result.error !== null) {
    return {
      ok: false,
      response: '',
      httpStatus: null,
      elapsedMs,
      jobId: null,
      routing: null,
      errorCode: result.error,
    }
  }
  const body = result.body
  const metadata = body && typeof body === 'object' && !Array.isArray(body) && body.tokenless && typeof body.tokenless === 'object'
    ? body.tokenless
    : null
  const jobId = metadata && typeof metadata.job_id === 'string' ? metadata.job_id : null
  const routing = safeRouting(metadata?.routing ?? safeRoutingFromHeaders(result.headers))
  if (result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      response: '',
      httpStatus: result.status,
      elapsedMs,
      jobId,
      routing,
      errorCode: safeErrorCode(body),
    }
  }
  const content = body?.choices?.[0]?.message?.content
  if (typeof content !== 'string') {
    return {
      ok: false,
      response: '',
      httpStatus: result.status,
      elapsedMs,
      jobId,
      routing,
      errorCode: 'invalid_response',
    }
  }
  return {
    ok: true,
    response: content,
    httpStatus: result.status,
    elapsedMs,
    jobId,
    routing,
    errorCode: null,
  }
}

function safeErrorCode(body) {
  const code = body?.error?.code
  return typeof code === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(code) ? code : 'api_error'
}

function safeRouting(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const routing = value
  const provider = safeId(routing.provider)
  if (provider === null) return null
  const result = {
    mode: routing.mode === 'auto' ? 'auto' : 'explicit',
    provider,
    fallbackProviders: safeIds(routing.fallbackProviders),
    exclusions: Array.isArray(routing.exclusions)
      ? routing.exclusions.slice(0, 64).flatMap((entry) => safeExclusion(entry))
      : [],
    fallbackUsed: routing.fallbackUsed === true,
    rateLimited: routing.rateLimited === true,
    attempts: Array.isArray(routing.attempts)
      ? routing.attempts.slice(0, 5).flatMap((entry) => safeAttempt(entry))
      : [],
    preferenceRequested: safeId(routing.preferenceRequested),
    preferenceHonored: routing.preferenceHonored === true,
    providerSubmitted: routing.providerSubmitted === true,
  }
  if (typeof routing.visibleProof === 'string' && routing.visibleProof.length <= 128) result.visibleProof = routing.visibleProof
  if (['minute', 'hour', 'day', 'week', 'unknown'].includes(routing.limitWindow)) result.limitWindow = routing.limitWindow
  if (Number.isFinite(routing.retryAfterSeconds)) result.retryAfterSeconds = routing.retryAfterSeconds
  return result
}

function safeRoutingFromHeaders(headers) {
  const provider = safeId(headers.get('x-tokenless-route-provider'))
  if (provider === null) return null
  const readJsonHeader = (name, fallback) => {
    const raw = headers.get(name)
    if (!raw) return fallback
    try { return JSON.parse(raw) } catch { return fallback }
  }
  return {
    mode: headers.get('x-tokenless-route-mode') === 'auto' ? 'auto' : 'explicit',
    provider,
    fallbackProviders: safeIds((headers.get('x-tokenless-route-fallback-providers') ?? '').split(',').filter(Boolean)),
    exclusions: readJsonHeader('x-tokenless-route-exclusions', []),
    fallbackUsed: headers.get('x-tokenless-route-fallback-used') === '1',
    rateLimited: headers.get('x-tokenless-route-rate-limited') === '1',
    attempts: readJsonHeader('x-tokenless-route-attempts', []),
    preferenceRequested: safeId(headers.get('x-tokenless-route-preference-requested')),
    preferenceHonored: headers.get('x-tokenless-route-preference-honored') === '1',
    providerSubmitted: headers.get('x-tokenless-route-provider-submitted') === '1',
    visibleProof: headers.get('x-tokenless-route-visible-proof') || undefined,
    limitWindow: headers.get('x-tokenless-route-limit-window') || undefined,
    retryAfterSeconds: Number(headers.get('x-tokenless-route-retry-after-seconds')),
  }
}

function safeAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const provider = safeId(value.provider)
  if (provider === null) return []
  const result = {
    provider,
    outcome: 'fallback',
    reason: typeof value.reason === 'string' && /^[a-z_]+$/u.test(value.reason) ? value.reason : 'unavailable',
    providerSubmitted: value.providerSubmitted === true,
  }
  if (typeof value.observedAt === 'string' && value.observedAt.length <= 64) result.observedAt = value.observedAt
  if (typeof value.visibleProof === 'string' && value.visibleProof.length <= 128) result.visibleProof = value.visibleProof
  if (['minute', 'hour', 'day', 'week', 'unknown'].includes(value.limitWindow)) result.limitWindow = value.limitWindow
  if (Number.isFinite(value.retryAfterSeconds)) result.retryAfterSeconds = value.retryAfterSeconds
  return [result]
}

function safeExclusion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const provider = safeId(value.provider)
  if (provider === null || !['access', 'runtime', 'capability'].includes(value.category) || typeof value.reason !== 'string') return []
  return [{ provider, category: value.category, reason: value.reason.slice(0, 128) }]
}

function safeIds(value) {
  return Array.isArray(value) ? value.flatMap((entry) => {
    const id = safeId(entry)
    return id === null ? [] : [id]
  }) : []
}

function safeId(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9-]{0,63}$/u.test(value) ? value : null
}

async function fetchJson(url, timeoutMs, options = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body = null
    if (text.trim()) {
      try { body = JSON.parse(text) } catch { return { status: response.status, headers: response.headers, body: null, error: 'invalid_json' } }
    }
    return { status: response.status, headers: response.headers, body, error: null }
  } catch (error) {
    if (error?.name === 'AbortError') return { status: null, headers: new Headers(), body: null, error: 'timeout' }
    return { status: null, headers: new Headers(), body: null, error: 'network_error' }
  } finally {
    clearTimeout(timer)
  }
}

function normalizeApiBase(value) {
  let parsed
  try { parsed = new URL(value) } catch { throw new Error('--api-base must be an absolute http(s) URL.') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('--api-base must be an absolute http(s) URL without credentials, query, or fragment.')
  }
  let pathname = parsed.pathname.replace(/\/+$/u, '')
  if (pathname.endsWith('/chat/completions')) pathname = pathname.slice(0, -'/chat/completions'.length)
  if (pathname.endsWith('/models')) pathname = pathname.slice(0, -'/models'.length)
  return `${parsed.origin}${pathname}`
}

function requiredProvider(args) {
  const provider = requiredOption(args, '--provider')
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(provider)) throw new Error('--provider must be a lowercase Tokenless provider id.')
  return provider
}

function timeoutOption(args) {
  const raw = option(args, '--timeout-ms') ?? String(revision.requestTimeoutMs)
  if (!/^\d+$/u.test(raw)) throw new Error('--timeout-ms must be an integer in milliseconds.')
  const timeoutMs = Number(raw)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 600000) throw new Error('--timeout-ms must be greater than 600000 (10 minutes); submitted IFBench turns are never retried.')
  return timeoutMs
}

async function createResultDirectory(kind, args) {
  const runId = option(args, '--run-id') ?? `${kind}-${new Date().toISOString().replace(/[-:.TZ]/gu, '')}-${randomUUID().slice(0, 8)}`
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(runId)) throw new Error('--run-id must contain 1-64 letters, numbers, dots, underscores, or hyphens.')
  const runDir = path.join(resultsRoot, runId)
  await fs.mkdir(resultsRoot, { recursive: true })
  try {
    await fs.access(runDir)
    throw new Error(`Refusing to overwrite existing IFBench result directory: ${runDir}`)
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Refusing to overwrite')) throw error
  }
  await fs.mkdir(runDir, { recursive: false })
  return runDir
}

function resolveCheckout(args) {
  return path.resolve(option(args, '--checkout') ?? path.join(root, '..', '..', 'benchmarks', 'IFBench'))
}

function resolveHome(args) {
  return path.resolve(option(args, '--home') ?? path.join(os.homedir(), '.tokenless'))
}

async function readDaemonToken(home) {
  const tokenPath = path.join(home, 'daemon.token')
  let token
  try {
    token = (await fs.readFile(tokenPath, 'utf8')).trim()
  } catch {
    throw new Error(`Cannot read the Tokenless API daemon token at ${tokenPath}; pass --home for the configured Tokenless API home.`)
  }
  if (!token) throw new Error(`The Tokenless API daemon token is empty at ${tokenPath}.`)
  return token
}

function requiredOption(args, name) {
  const value = option(args, name)
  if (value === undefined) throw new Error(`${name} is required.`)
  return value
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function repeatedOption(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
    values.push(value)
  }
  return values
}

async function readJsonl(filePath) {
  const content = await fs.readFile(filePath, 'utf8')
  const rows = []
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    try { rows.push(JSON.parse(line)) } catch { throw new Error(`Invalid JSONL at ${filePath}:${index + 1}`) }
  }
  return rows
}

async function countJsonl(filePath) {
  return (await readJsonl(filePath)).length
}

async function writeJsonl(filePath, rows) {
  const content = rows.map((row) => JSON.stringify(row)).join('\n')
  await fs.writeFile(filePath, `${content}\n`, { encoding: 'utf8', mode: 0o600 })
}

async function sha256File(filePath) {
  const hash = createHash('sha256')
  hash.update(await fs.readFile(filePath))
  return hash.digest('hex')
}

function runCommand(commandName, args, { cwd, capture = false, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd,
      env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }))
  })
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function helpText() {
  return `IFBench precise instruction-following evaluation / IFBench 精确指令遵循评测

Pinned commit: ${revision.benchmarkCommit}
Dataset: ${revision.taskCount} tasks, ${revision.datasetDigest}
Official metric: ${revision.officialMetric}

Usage / 用法:
  npm run benchmark:ifbench -- inspect
  npm run benchmark:ifbench -- prepare [--checkout <IFBench checkout>]
  npm run benchmark:ifbench -- wiring --home <Tokenless API home> --api-base <status endpoint> --provider <provider> [--task <key>] [--checkout <path>] [--run-id <id>]
  npm run benchmark:ifbench -- full --home <Tokenless API home> --api-base <status endpoint> --provider <provider> [--checkout <path>] [--run-id <id>]
  npm run benchmark:ifbench -- score --responses <responses.jsonl> [--task <key>] [--checkout <path>] [--output-dir <path>]
  npm run benchmark:ifbench -- help

wiring defaults to official key ${revision.wiringTaskKey} and is only an end-to-end wiring smoke test; full is the 300-task score.
wiring 默认官方 key ${revision.wiringTaskKey}，仅用于端到端 wiring 冒烟验证；full 才是 300 题分数。
The API proxy must already be enabled through Tokenless API config. Read api-base from tokenless api-proxy status --home <home> --json (.apiProxy.endpoints.openaiDefault). Requests are serial, use zero retries, and send no sampling controls; browser execution ignores sampling controls.
API proxy 必须预先通过 Tokenless API 配置启用。从 tokenless api-proxy status --home <home> --json 的 .apiProxy.endpoints.openaiDefault 读取 api-base。请求单并发、零重试，且不发送 sampling controls；browser 执行会忽略这些控制项。
Raw official-compatible responses and official verifier JSONL stay under benchmarks/ifbench/results/ (gitignored); tokenless-run.json contains metadata only.
原始 official-compatible responses 与官方 verifier JSONL 保存在 gitignored 的 benchmarks/ifbench/results/ 下；tokenless-run.json 只包含元数据。
`
}
