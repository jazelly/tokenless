#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const revisionPath = path.join(root, 'benchmarks', 'featurebench', 'revision.json')
const adapterPath = path.join(root, 'benchmarks', 'featurebench', 'tokenless.py')
const upstreamPatchPath = path.join(root, 'benchmarks', 'featurebench', 'upstream.patch')
const revision = JSON.parse(await fs.readFile(revisionPath, 'utf8'))
const [command = 'help', ...argv] = process.argv.slice(2)

try {
  if (command === 'inspect') {
    output({ ok: true, ...revision })
  } else if (command === 'prepare') {
    output({ ok: true, prepared: await prepare(argv) })
  } else if (command === 'gold') {
    output({ ok: true, evaluation: await evaluateGold(argv) })
  } else if (command === 'wiring' || command === 'fast' || command === 'full') {
    output({ ok: true, run: await runBenchmark(command, argv) })
  } else if (command === 'eval') {
    output({ ok: true, evaluation: await evaluatePredictions(argv) })
  } else if (command === 'report') {
    output({ ok: true, report: await writeRunReport(argv) })
  } else if (command === 'compare') {
    output({ ok: true, comparison: await compareReports(argv) })
  } else if (command === 'showcase') {
    output({ ok: true, showcase: await createShowcase(argv) })
  } else if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(featureBenchHelpText())
  } else {
    throw new Error(`Unknown FeatureBench command: ${command}`)
  }
} catch (error) {
  const payload = { ok: false, error: { message: error instanceof Error ? error.message : String(error) } }
  if (argv.includes('--json')) output(payload)
  else process.stderr.write(`Error: ${payload.error.message}\n`)
  process.exitCode = 1
}

async function prepare(args, { includeAgentPackage = true } = {}) {
  const checkout = await pinnedCheckout(args)
  await installUpstreamAdapter(checkout)
  const cacheDir = path.resolve(option(args, '--cache-dir') ?? path.join(checkout, 'download_cache', 'tokenless'))
  await fs.mkdir(cacheDir, { recursive: true })
  const packagePath = includeAgentPackage ? await packBuiltCli(cacheDir) : null
  const configPath = path.resolve(option(args, '--config') ?? path.join(checkout, 'tokenless-config.toml'))
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  const taskTimeoutSeconds = positiveInteger(option(args, '--timeout') ?? '7200', '--timeout', 1, 86_400)
  const providerTurnTimeoutMs = positiveInteger(option(args, '--provider-turn-timeout-ms') ?? '600000', '--provider-turn-timeout-ms', 30_000, 1_800_000)
  const defaultChannelLifetimeMs = Math.min(86_400_000, Math.max(60_000, taskTimeoutSeconds * 1_000 + 600_000))
  const channelLifetimeMs = positiveInteger(option(args, '--channel-lifetime-ms') ?? String(defaultChannelLifetimeMs), '--channel-lifetime-ms', 60_000, 86_400_000)
  const config = featureBenchConfig({
    cacheDir: featureBenchRuntimePath(cacheDir),
    packagePath,
    provider: includeAgentPackage ? requiredOption(args, '--provider') : null,
    executionMode: executionMode(args),
    maxSteps: positiveInteger(option(args, '--max-steps') ?? '40', '--max-steps', 1, 200),
    toolTimeoutMs: positiveInteger(option(args, '--tool-timeout-ms') ?? '120000', '--tool-timeout-ms', 1_000, 1_800_000),
    providerTurnTimeoutMs,
    channelLifetimeMs,
    effort: option(args, '--effort'),
  })
  await fs.writeFile(configPath, config, { encoding: 'utf8', mode: 0o600 })
  return {
    checkout,
    benchmarkCommit: revision.benchmarkCommit,
    datasetRevision: revision.datasetRevision,
    configPath,
    cacheDir,
    packagePath,
  }
}

async function installUpstreamAdapter(checkout) {
  const agentsDir = path.join(checkout, 'featurebench', 'infer', 'agents')
  await fs.access(path.join(agentsDir, 'base.py'))
  const target = path.join(agentsDir, 'tokenless.py')
  const source = await fs.readFile(adapterPath, 'utf8')
  const existing = await fs.readFile(target, 'utf8').catch(() => null)
  if (existing !== source) await fs.writeFile(target, source, 'utf8')

  const check = await run('git', ['-C', checkout, 'apply', '--check', upstreamPatchPath], { capture: true, allowFailure: true })
  if (check.code === 0) {
    await run('git', ['-C', checkout, 'apply', upstreamPatchPath])
    return
  }
  const reverse = await run('git', ['-C', checkout, 'apply', '--reverse', '--check', upstreamPatchPath], { capture: true, allowFailure: true })
  if (reverse.code !== 0) {
    throw new Error(`Pinned FeatureBench checkout cannot accept the Tokenless adapter patch.\n${check.stderr || reverse.stderr}`)
  }
}

async function packBuiltCli(cacheDir) {
  await runNpm(['run', 'build', '--workspace', 'packages/cli'], { cwd: root })
  const before = new Set((await fs.readdir(cacheDir)).filter((name) => /^tokenless-.*\.tgz$/.test(name)))
  await runNpm(['pack', path.join(root, 'packages', 'cli'), '--pack-destination', cacheDir], { cwd: root })
  const packages = (await fs.readdir(cacheDir)).filter((name) => /^tokenless-.*\.tgz$/.test(name))
  const created = packages.filter((name) => !before.has(name))
  const selected = created.at(-1) ?? packages.sort().at(-1)
  if (!selected) throw new Error('npm pack did not produce a Tokenless package.')
  return path.join(cacheDir, selected)
}

async function evaluateGold(args) {
  const prepared = await prepare(args, { includeAgentPackage: false })
  const split = splitOption(args, 'full')
  const taskIds = repeatedOptions(args, '--task')
  const commandArgs = [
    'run', '--project', prepared.checkout, 'fb', 'eval',
    '--config-path', prepared.configPath,
    '--predictions-path', 'gold',
    '--dataset', revision.dataset,
    '--split', split,
    '--n-concurrent', option(args, '--n-concurrent') ?? '1',
  ]
  if (taskIds.length > 0) commandArgs.push('--task-id', ...taskIds)
  await runFeatureBench(commandArgs, {
    cwd: prepared.checkout,
    hfOffline: args.includes('--offline-cache'),
  })
  return { kind: 'gold', split, taskIds, reportPath: path.join(prepared.checkout, 'runs', 'gold', 'report.json') }
}

async function runBenchmark(kind, args) {
  const prepared = await prepare(args)
  const split = kind === 'fast' ? 'fast' : splitOption(args, 'full')
  const taskIds = kind === 'wiring'
    ? (repeatedOptions(args, '--task').length > 0 ? repeatedOptions(args, '--task') : [revision.wiringTasks[0]])
    : repeatedOptions(args, '--task')
  const outputRoot = path.resolve(option(args, '--output-dir') ?? path.join(prepared.checkout, 'runs'))
  await fs.mkdir(outputRoot, { recursive: true })
  const before = new Set(await directoryNames(outputRoot))
  const runId = option(args, '--run-id') ?? `tokenless_${new Date().toISOString().replace(/[-:.TZ]/g, '')}_${randomUUID().slice(0, 8)}`
  const hostHome = path.resolve(requiredOption(args, '--home'))
  const hostCli = path.join(root, 'packages', 'cli', 'dist', 'src', 'tokenless.mjs')
  await fs.access(hostCli)
  const hostDaemon = await ensureFeatureBenchHostDaemon({
    homeDir: hostHome,
    explicitDaemonUrl: option(args, '--daemon-url'),
  })
  const inferArgs = [
    'run', '--project', prepared.checkout, 'fb', 'infer',
    '--config-path', prepared.configPath,
    '--agent', 'tokenless',
    '--model', option(args, '--model') ?? 'provider-default',
    '--dataset', revision.dataset,
    '--split', split,
    '--n-attempts', '1',
    '--n-concurrent', option(args, '--n-concurrent') ?? '1',
    '--timeout', option(args, '--timeout') ?? '7200',
    '--output-dir', outputRoot,
  ]
  if (taskIds.length > 0) inferArgs.push('--task-id', ...taskIds)
  await runFeatureBench(inferArgs, {
    cwd: prepared.checkout,
    hfOffline: args.includes('--offline-cache'),
    env: {
      ...process.env,
      TOKENLESS_FEATUREBENCH_HOST_NODE: featureBenchRuntimePath(process.execPath),
      TOKENLESS_FEATUREBENCH_HOST_CLI: hostCli,
      TOKENLESS_FEATUREBENCH_HOST_CWD: featureBenchRuntimePath(path.dirname(hostCli)),
      TOKENLESS_FEATUREBENCH_HOST_HOME: hostHome,
      TOKENLESS_FEATUREBENCH_RUN_ID: runId,
      TOKENLESS_FEATUREBENCH_CHANNEL_HOST: option(args, '--channel-host') ?? defaultChannelHost(),
      ...(option(args, '--profile') ? { TOKENLESS_FEATUREBENCH_HOST_PROFILE: option(args, '--profile') } : {}),
      TOKENLESS_FEATUREBENCH_HOST_DAEMON_URL: hostDaemon.url,
    },
  })
  const runDir = await newestNewDirectory(outputRoot, before)
  const predictionsPath = path.join(runDir, 'output.jsonl')
  await evaluatePredictions([
    '--checkout', prepared.checkout,
    '--config', prepared.configPath,
    '--predictions', predictionsPath,
    '--split', split,
    '--n-concurrent', option(args, '--eval-concurrent') ?? '1',
    ...(args.includes('--offline-cache') ? ['--offline-cache'] : []),
    ...taskIds.flatMap((task) => ['--task', task]),
  ])
  const report = await writeRunReport([
    '--run-dir', runDir,
    '--provider', requiredOption(args, '--provider'),
    '--model', option(args, '--model') ?? 'provider-default',
    '--execution-mode', executionMode(args),
    '--split', split,
    '--run-id', runId,
    '--timeout', option(args, '--timeout') ?? '7200',
    '--max-steps', option(args, '--max-steps') ?? '40',
    '--tool-timeout-ms', option(args, '--tool-timeout-ms') ?? '120000',
    '--provider-turn-timeout-ms', option(args, '--provider-turn-timeout-ms') ?? '600000',
    '--channel-lifetime-ms', option(args, '--channel-lifetime-ms') ?? String(Math.min(86_400_000, Math.max(60_000, Number(option(args, '--timeout') ?? '7200') * 1_000 + 600_000))),
    '--n-concurrent', option(args, '--n-concurrent') ?? '1',
    '--scope', kind,
    ...(option(args, '--effort') ? ['--effort', option(args, '--effort')] : []),
    ...taskIds.flatMap((task) => ['--task', task]),
  ])
  return { kind, split, runDir, predictionsPath, report }
}

async function ensureFeatureBenchHostDaemon({ homeDir, explicitDaemonUrl }) {
  const runtimeEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'index.js')
  const runtime = await import(pathToFileURL(runtimeEntry).href)
  const config = await runtime.readTokenlessConfig(homeDir)
  return await runtime.ensureDaemonReady({
    homeDir,
    daemonUrl: runtime.daemonUrl(explicitDaemonUrl ?? config.daemonUrl ?? undefined),
  })
}

async function evaluatePredictions(args) {
  const checkout = await pinnedCheckout(args)
  const predictions = path.resolve(requiredOption(args, '--predictions'))
  const configPath = path.resolve(requiredOption(args, '--config'))
  const split = splitOption(args, 'full')
  const taskIds = repeatedOptions(args, '--task')
  const evalArgs = [
    'run', '--project', checkout, 'fb', 'eval',
    '--config-path', configPath,
    '--predictions-path', predictions,
    '--dataset', revision.dataset,
    '--split', split,
    '--include-failed',
    '--n-concurrent', option(args, '--n-concurrent') ?? '1',
  ]
  if (taskIds.length > 0) evalArgs.push('--task-id', ...taskIds)
  await runFeatureBench(evalArgs, {
    cwd: checkout,
    hfOffline: args.includes('--offline-cache'),
  })
  return { predictions, split, taskIds, reportPath: path.join(path.dirname(predictions), 'report.json') }
}

async function writeRunReport(args) {
  const runDir = path.resolve(requiredOption(args, '--run-dir'))
  const destination = path.join(runDir, 'tokenless-run.json')
  if (await exists(destination)) throw new Error(`Refusing to overwrite existing FeatureBench run report: ${destination}`)
  const [metadata, outputRows, official, tokenlessCommit, dirty] = await Promise.all([
    readJson(path.join(runDir, 'run_metadata.json')),
    readJsonLines(path.join(runDir, 'output.jsonl')),
    readJson(path.join(runDir, 'report.json')),
    gitValue(['rev-parse', 'HEAD']),
    gitValue(['status', '--porcelain']).then((value) => value.length > 0),
  ])
  const split = splitOption(args, String(metadata.split ?? 'full'))
  const requestedTasks = repeatedOptions(args, '--task')
  const splitTasks = revision.splits[split]?.tasks ?? null
  const totalTasks = requestedTasks.length > 0 ? requestedTasks.length : splitTasks ?? outputRows.length
  const officialAttempt = official.attempt_1 ?? {}
  const failureCounts = await classifyFailures(runDir, outputRows)
  const missingTasks = Math.max(totalTasks - outputRows.length, 0)
  const images = unique(outputRows.map((row) => row?.task_metadata?.image_name).filter((value) => typeof value === 'string'))
  const imageDigests = await inspectImageDigests(images)
  const report = {
    schema: 'tokenless.featurebench-run.v1',
    runId: requiredOption(args, '--run-id'),
    benchmark: revision.benchmark,
    benchmarkCommit: revision.benchmarkCommit,
    dataset: revision.dataset,
    datasetRevision: revision.datasetRevision,
    split,
    scope: option(args, '--scope') ?? 'custom',
    officialFullRun: split === 'full' && requestedTasks.length === 0 && outputRows.length === revision.splits.full.tasks && officialAttempt.total_instances === revision.splits.full.tasks,
    requestedTasks,
    attemptsPerTask: 1,
    scaffold: option(args, '--scaffold') ?? revision.scaffold,
    tokenlessCommit,
    tokenlessWorkingTreeDirty: dirty,
    provider: requiredOption(args, '--provider'),
    model: requiredOption(args, '--model'),
    effort: option(args, '--effort'),
    providerUsage: null,
    executionMode: executionModeLabel(executionMode(args)),
    limits: {
      taskTimeoutSeconds: positiveInteger(requiredOption(args, '--timeout'), '--timeout', 1, 86_400),
      maxAgentSteps: positiveInteger(requiredOption(args, '--max-steps'), '--max-steps', 1, 200),
      toolTimeoutMs: positiveInteger(requiredOption(args, '--tool-timeout-ms'), '--tool-timeout-ms', 1_000, 1_800_000),
      providerTurnTimeoutMs: positiveInteger(requiredOption(args, '--provider-turn-timeout-ms'), '--provider-turn-timeout-ms', 30_000, 1_800_000),
      channelLifetimeMs: positiveInteger(requiredOption(args, '--channel-lifetime-ms'), '--channel-lifetime-ms', 60_000, 86_400_000),
      concurrentTasks: positiveInteger(requiredOption(args, '--n-concurrent'), '--n-concurrent', 1, 200),
    },
    expectedTasks: totalTasks,
    recordedTasks: outputRows.length,
    completedTasks: outputRows.length,
    agentSucceededTasks: outputRows.filter((row) => row.success === true).length,
    missingTasks,
    totalTasks,
    passedPercent: percent(officialAttempt.pass_rate),
    resolvedPercent: percent(officialAttempt.resolved_rate),
    officialReport: path.relative(runDir, path.join(runDir, 'report.json')),
    predictions: path.relative(runDir, path.join(runDir, 'output.jsonl')),
    agentFailures: failureCounts.agent,
    providerFailures: failureCounts.provider,
    infrastructureFailures: failureCounts.infrastructure + missingTasks,
    failureCategories: {
      providerTurn: failureCounts.provider,
      actionValidation: failureCounts.actionValidation,
      toolExecution: failureCounts.toolExecution,
      agentRuntime: failureCounts.agentRuntime,
      infrastructure: failureCounts.infrastructure + missingTasks,
    },
    officialEvaluation: {
      totalInstances: officialAttempt.total_instances ?? null,
      submittedInstances: officialAttempt.submitted_instances ?? null,
      completedInstances: officialAttempt.completed_instances ?? null,
      resolvedInstances: officialAttempt.resolved_instances ?? null,
      unresolvedInstances: officialAttempt.unresolved_instances ?? null,
      errorInstances: officialAttempt.error_instances ?? null,
      notAppliedPatchEmptyInstances: officialAttempt.not_applied_patch_empty_instances ?? null,
      notAppliedPatchOtherInstances: officialAttempt.not_applied_patch_other_instances ?? null,
    },
    images: imageDigests,
    startedAt: metadata.start_time ?? null,
    finishedAt: metadata.end_time ?? null,
  }
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { path: destination, ...report }
}

async function compareReports(args) {
  const paths = repeatedOptions(args, '--report').map((value) => path.resolve(value))
  if (paths.length < 2) throw new Error('compare requires at least two --report files.')
  const reports = await Promise.all(paths.map(readJson))
  const baseline = reports[0]
  const keys = ['benchmarkCommit', 'datasetRevision', 'split', 'attemptsPerTask']
  for (const report of reports.slice(1)) {
    for (const key of keys) {
      if (report[key] !== baseline[key]) throw new Error(`Reports are not comparable: ${key} differs.`)
    }
    if (JSON.stringify(report.limits) !== JSON.stringify(baseline.limits)) throw new Error('Reports are not comparable: limits differ.')
  }
  return {
    schema: 'tokenless.featurebench-comparison.v1',
    benchmarkCommit: baseline.benchmarkCommit,
    datasetRevision: baseline.datasetRevision,
    split: baseline.split,
    attemptsPerTask: baseline.attemptsPerTask,
    limits: baseline.limits,
    rows: reports.map((report) => ({
      runId: report.runId,
      scaffold: report.scaffold,
      provider: report.provider,
      model: report.model,
      effort: report.effort ?? null,
      executionMode: report.executionMode,
      recordedTasks: report.recordedTasks,
      passedPercent: report.passedPercent,
      resolvedPercent: report.resolvedPercent,
      agentFailures: report.agentFailures,
      providerFailures: report.providerFailures,
      infrastructureFailures: report.infrastructureFailures,
    })),
  }
}

async function createShowcase(args) {
  const runDir = path.resolve(requiredOption(args, '--run-dir'))
  const task = requiredOption(args, '--task')
  const eventsPath = path.join(runDir, 'run_outputs', task, 'attempt-1', 'tokenless-events.jsonl')
  const verdictPath = path.join(runDir, 'eval_outputs', task, 'attempt-1', 'report.json')
  const events = (await readJsonLines(eventsPath))
    .filter((event) => ['provider.turn.completed', 'tool.call', 'tool.result', 'run.completed', 'run.failed'].includes(event.type))
    .map((event) => ({
      sequence: event.sequence,
      type: event.type,
      at: event.at,
      ...(event.jobId ? { jobId: event.jobId } : {}),
      ...(event.action ? { action: event.action } : {}),
      ...(event.tool ? { tool: event.tool, ok: event.ok, durationMs: event.durationMs, output: event.output } : {}),
      ...(event.summary ? { summary: event.summary } : {}),
      ...(event.category ? { category: event.category, code: event.code } : {}),
    }))
  return {
    schema: 'tokenless.featurebench-showcase.v1',
    task,
    timeline: events,
    officialVerdict: await readJson(verdictPath),
  }
}

async function pinnedCheckout(args) {
  const checkout = path.resolve(requiredOption(args, '--checkout'))
  await fs.access(path.join(checkout, 'pyproject.toml'))
  const head = await gitValue(['-C', checkout, 'rev-parse', 'HEAD'])
  if (head !== revision.benchmarkCommit) {
    throw new Error(`FeatureBench checkout must be pinned to ${revision.benchmarkCommit}; found ${head}.`)
  }
  return checkout
}

function featureBenchConfig({ cacheDir, packagePath, provider, executionMode, maxSteps, toolTimeoutMs, providerTurnTimeoutMs, channelLifetimeMs, effort }) {
  const containerPackage = packagePath ? `/download/${path.basename(packagePath)}` : ''
  return `[env_vars]
FEATUREBENCH_DATASET_REVISION = ${tomlString(revision.datasetRevision)}

[infer]
download_cache_dir = ${tomlString(cacheDir)}

[infer_config.tokenless]
TOKENLESS_FEATUREBENCH_PACKAGE = ${tomlString(containerPackage)}
TOKENLESS_FEATUREBENCH_PROVIDER = ${tomlString(provider ?? '')}
TOKENLESS_FEATUREBENCH_EXECUTION_MODE = ${tomlString(executionMode)}
TOKENLESS_FEATUREBENCH_MAX_STEPS = ${tomlString(String(maxSteps))}
TOKENLESS_FEATUREBENCH_TOOL_TIMEOUT_MS = ${tomlString(String(toolTimeoutMs))}
TOKENLESS_FEATUREBENCH_PROVIDER_TURN_TIMEOUT_MS = ${tomlString(String(providerTurnTimeoutMs))}
TOKENLESS_FEATUREBENCH_CHANNEL_LIFETIME_MS = ${tomlString(String(channelLifetimeMs))}
TOKENLESS_FEATUREBENCH_EFFORT = ${tomlString(effort ?? '')}
`
}

async function inspectImageDigests(images) {
  const results = []
  for (const image of images) {
    const inspected = await run(dockerCommand(), ['image', 'inspect', image, '--format', '{{json .RepoDigests}}'], { capture: true, allowFailure: true })
    results.push({
      image,
      digests: inspected.code === 0 ? JSON.parse(inspected.stdout.trim() || '[]') : [],
      available: inspected.code === 0,
    })
  }
  return results
}

async function classifyFailures(runDir, rows) {
  let agent = 0
  let provider = 0
  let infrastructure = 0
  let actionValidation = 0
  let toolExecution = 0
  let agentRuntime = 0
  for (const row of rows) {
    if (row.success === true) continue
    const failure = await readRunFailure(runDir, row)
    if (failure?.category === 'provider_turn') {
      provider += 1
      continue
    }
    if (failure) {
      if (failure.category === 'action_validation') actionValidation += 1
      else if (failure.category === 'tool_execution') toolExecution += 1
      else agentRuntime += 1
      agent += 1
      continue
    }
    const error = String(row.error ?? '')
    if (/container|docker|image|runtime initialization|install/i.test(error)) infrastructure += 1
    else agent += 1
  }
  return { agent, provider, infrastructure, actionValidation, toolExecution, agentRuntime }
}

async function readRunFailure(runDir, row) {
  const instanceId = typeof row.instance_id === 'string' ? row.instance_id : ''
  if (!instanceId || path.basename(instanceId) !== instanceId) return null
  const attempt = Number.isInteger(row.n_attempt) && row.n_attempt > 0 ? row.n_attempt : 1
  const eventsPath = path.join(runDir, 'run_outputs', instanceId, `attempt-${attempt}`, 'tokenless-events.jsonl')
  try {
    const events = await readJsonLines(eventsPath)
    return events.findLast((event) => event.type === 'run.failed') ?? null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function newestNewDirectory(parent, before) {
  const entries = await fs.readdir(parent, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || before.has(entry.name)) continue
    const full = path.join(parent, entry.name)
    candidates.push({ full, mtime: (await fs.stat(full)).mtimeMs })
  }
  candidates.sort((a, b) => b.mtime - a.mtime)
  if (!candidates[0]) throw new Error('FeatureBench infer did not create a run directory.')
  return candidates[0].full
}

async function directoryNames(parent) {
  return (await fs.readdir(parent, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
}

async function gitValue(args) {
  const result = await run('git', args, { cwd: root, capture: true })
  return result.stdout.trim()
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const capture = options.capture === true
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
    }
    child.once('error', reject)
    child.once('close', (code, signal) => {
      const result = { code: code ?? 1, signal, stdout, stderr }
      if (result.code === 0 || options.allowFailure) resolve(result)
      else reject(new Error(`${command} ${args.join(' ')} failed with ${signal ?? `exit code ${result.code}`}${stderr.trim() ? `\n${stderr.trim()}` : ''}`))
    })
  })
}

function runFeatureBench(args, options = {}) {
  const { hfOffline = false, ...runOptions } = options
  if (process.platform !== 'win32') {
    return run(uvCommand(), args, runOptions)
  }
  const distribution = process.env.TOKENLESS_FEATUREBENCH_WSL_DISTRIBUTION?.trim() || 'Ubuntu'
  const forwardedEnvironment = Object.entries(runOptions.env ?? {})
    .filter(([name, value]) => name.startsWith('TOKENLESS_FEATUREBENCH_') && value !== undefined)
    .map(([name, value]) => `${name}=${String(value)}`)
  const offlineEnvironment = hfOffline || process.env.TOKENLESS_FEATUREBENCH_HF_OFFLINE?.trim() === '1'
    ? ['HF_HUB_OFFLINE=1']
    : []
  return run('wsl.exe', [
    '-d', distribution,
    '--cd', featureBenchRuntimePath(runOptions.cwd ?? root),
    '--exec', '/usr/bin/env',
    'HF_HUB_DISABLE_XET=1',
    ...offlineEnvironment,
    'UV_PROJECT_ENVIRONMENT=.venv-tokenless-wsl',
    'UV_PYTHON_PREFERENCE=only-managed',
    'UV_LINK_MODE=copy',
    ...forwardedEnvironment,
    'bash', '-lc', 'exec "$HOME/.local/bin/uv" "$@"', 'tokenless-featurebench',
    ...args.map(featureBenchRuntimePath),
  ], {
    ...runOptions,
    cwd: root,
    env: process.env,
  })
}

function featureBenchRuntimePath(value) {
  if (process.platform !== 'win32' || typeof value !== 'string' || !path.win32.isAbsolute(value)) {
    return value
  }
  const parsed = path.win32.parse(value)
  const drive = parsed.root.slice(0, 1).toLowerCase()
  const relative = value.slice(parsed.root.length).replaceAll('\\', '/')
  return `/mnt/${drive}/${relative}`
}

function option(args, name) {
  const index = args.lastIndexOf(name)
  return index === -1 ? null : args[index + 1] ?? null
}

function repeatedOptions(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) values.push(args[index + 1])
  }
  return values
}

function requiredOption(args, name) {
  const value = option(args, name)?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function splitOption(args, fallback) {
  const split = option(args, '--split') ?? fallback
  if (split !== 'fast' && split !== 'full') throw new Error('--split must be fast or full.')
  return split
}

function executionMode(args) {
  const mode = option(args, '--execution-mode') ?? 'browser'
  if (mode !== 'browser' && mode !== 'direct') throw new Error('--execution-mode must be browser or direct.')
  return mode
}

function executionModeLabel(mode) {
  return mode === 'browser' ? 'visible-browser' : 'direct-protocol'
}

function positiveInteger(value, name, min, max) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be an integer from ${min} through ${max}.`)
  return number
}

function percent(value) {
  return typeof value === 'number' ? Math.round(value * 10_000) / 100 : null
}

function unique(values) {
  return [...new Set(values)]
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll('\\', '/'))
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

async function readJsonLines(file) {
  return (await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
}

async function exists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

function runNpm(args, options = {}) {
  if (process.platform !== 'win32') return run('npm', args, options)
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return run(process.execPath, [npmCli, ...args], options)
}

function uvCommand() {
  return process.env.TOKENLESS_FEATUREBENCH_UV_COMMAND?.trim() || (process.platform === 'win32' ? 'uv.bat' : 'uv')
}

function defaultChannelHost() {
  return process.platform === 'linux' ? '172.17.0.1' : 'host.docker.internal'
}

function dockerCommand() {
  return process.platform === 'win32' ? 'docker.exe' : 'docker'
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function featureBenchHelpText() {
  return `FeatureBench agent runtime evaluation

Pinned benchmark commit: ${revision.benchmarkCommit}
Pinned dataset revision: ${revision.datasetRevision}

Usage:
  npm run benchmark:featurebench -- inspect
  npm run benchmark:featurebench -- prepare --checkout <path> --provider <provider> [options]
  npm run benchmark:featurebench -- gold --checkout <path> [--split full] [--task <id>] [--offline-cache]
  npm run benchmark:featurebench -- wiring --checkout <path> --home <dir> --provider <provider> [options]
  npm run benchmark:featurebench -- fast --checkout <path> --home <dir> --provider <provider> [options]
  npm run benchmark:featurebench -- full --checkout <path> --home <dir> --provider <provider> [options]
  npm run benchmark:featurebench -- eval --checkout <path> --config <path> --predictions <output.jsonl> --split <fast|full> [--offline-cache]
  npm run benchmark:featurebench -- report --run-dir <path> --run-id <id> [--scaffold <name>] --provider <provider> --model <model> --execution-mode <browser|direct> --split <fast|full> --timeout <seconds> --max-steps <count> --tool-timeout-ms <ms> --provider-turn-timeout-ms <ms> --channel-lifetime-ms <ms> --n-concurrent <count>
  npm run benchmark:featurebench -- compare --report <tokenless-run.json> --report <reference-run.json>
  npm run benchmark:featurebench -- showcase --run-dir <path> --task <instance-id>

Options:
  --offline-cache  Reuse a complete pinned Hugging Face dataset cache without remote metadata checks.
`
}
