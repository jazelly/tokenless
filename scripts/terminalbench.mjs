#!/usr/bin/env node
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const benchmarkRoot = path.join(root, 'benchmarks', 'terminalbench')
const revision = JSON.parse(await fs.readFile(path.join(benchmarkRoot, 'revision.json'), 'utf8'))
const [command = 'help', ...argv] = process.argv.slice(2)

try {
  if (command === 'inspect') {
    output({ ok: true, ...revision })
  } else if (command === 'prepare') {
    output({ ok: true, prepared: await prepare(argv) })
  } else if (command === 'oracle') {
    output({ ok: true, run: await runOracle(argv) })
  } else if (command === 'wiring' || command === 'full') {
    output({ ok: true, run: await runDeepSeekLane(command, argv) })
  } else if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText())
  } else {
    throw new Error(`Unknown Terminal-Bench command: ${command}`)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (argv.includes('--json')) output({ ok: false, error: { message } })
  else process.stderr.write(`Error: ${message}\n`)
  process.exitCode = 1
}

async function prepare(args) {
  const dshCheckout = path.resolve(option(args, '--dsh-checkout') ?? path.join(root, '..', 'deepseek-harness'))
  await assertPinnedCheckout(dshCheckout)
  const cacheDir = path.resolve(option(args, '--cache-dir') ?? path.join(benchmarkRoot, 'cache'))
  const dshArtifacts = path.join(cacheDir, 'dsh')
  const vendorArtifacts = path.join(cacheDir, 'vendor')
  const tokenlessArtifacts = path.join(cacheDir, 'tokenless')
  await fs.mkdir(cacheDir, { recursive: true })

  const packageManagerEnvironment = cleanPackageManagerEnvironment()
  await run('npm', ['run', 'build:lib'], { cwd: dshCheckout, env: packageManagerEnvironment, captureFailure: true })
  const packEnvironment = { ...packageManagerEnvironment, CI: 'true', npm_config_ignore_scripts: 'true' }
  await run('pnpm', ['tsx', 'scripts/release/pack.ts', '--family', 'vendor', '--out', vendorArtifacts], { cwd: dshCheckout, env: packEnvironment, captureFailure: true })
  await run('pnpm', ['tsx', 'scripts/release/pack.ts', '--family', 'dsh', '--out', dshArtifacts], { cwd: dshCheckout, env: packEnvironment, captureFailure: true })

  await fs.rm(tokenlessArtifacts, { recursive: true, force: true })
  await fs.mkdir(tokenlessArtifacts, { recursive: true })
  await run('npm', ['run', 'build', '--workspace', 'packages/cli'], { cwd: root, captureFailure: true })
  await run('npm', ['pack', path.join(root, 'packages', 'cli'), '--pack-destination', tokenlessArtifacts], { cwd: root, captureFailure: true })
  const packages = (await fs.readdir(tokenlessArtifacts)).filter((name) => /^tokenless-.*\.tgz$/.test(name)).sort()
  if (packages.length !== 1) throw new Error(`Expected one packed Tokenless API package, found ${packages.length}.`)
  const tokenlessPackage = path.join(tokenlessArtifacts, packages[0])
  const runtimeArchive = await createRuntimeArchive({
    cacheDir,
    dshCheckout,
    dshArtifacts,
    vendorArtifacts,
    tokenlessPackage,
  })
  await assertPinnedCheckout(dshCheckout)
  return {
    dshCheckout,
    dshRevision: revision.deepseekHarnessRevision,
    dshArtifacts,
    vendorArtifacts,
    tokenlessPackage,
    runtimeArchive,
  }
}

function cleanPackageManagerEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toLowerCase().startsWith('npm_')))
}

async function createRuntimeArchive({ cacheDir, dshCheckout, dshArtifacts, vendorArtifacts, tokenlessPackage }) {
  const runtimeArtifacts = path.join(cacheDir, 'runtime')
  const archiveName = 'deepseek-harness-tokenless-runtime-linux-amd64.tar.gz'
  const archivePath = path.join(runtimeArtifacts, archiveName)
  await fs.rm(runtimeArtifacts, { recursive: true, force: true })
  await fs.mkdir(runtimeArtifacts, { recursive: true })

  const packages = await localPackageClosure(dshCheckout, '@deepseek-ai/dsh')
  const artifactDirectories = [dshArtifacts, vendorArtifacts]
  const artifacts = []
  for (const packageValue of packages) {
    const artifact = await packageArtifact(packageValue, artifactDirectories)
    if (artifact !== null) artifacts.push(artifact)
  }
  artifacts.push(tokenlessPackage)
  const containerArtifacts = artifacts.map((artifact) => {
    const relative = path.relative(cacheDir, artifact)
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Runtime artifact is outside the benchmark cache: ${artifact}`)
    }
    return `/artifacts/${relative.split(path.sep).join('/')}`
  })
  const buildScript = [
    'set -euo pipefail',
    'rm -rf /tmp/tokenless-runtime',
    'mkdir -p /tmp/tokenless-runtime/bin',
    'apt-get update >/dev/null',
    'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends cmake >/dev/null',
    'npm install --prefix /tmp/tokenless-runtime --no-audit --no-fund --package-lock=false "$@"',
    'helper=$(find /tmp/tokenless-runtime/node_modules/node-pty -type f -name spawn-helper -print -quit)',
    'test -n "$helper"',
    'chmod 755 "$helper"',
    'cp /usr/local/bin/node /tmp/tokenless-runtime/bin/node',
    '/tmp/tokenless-runtime/bin/node /tmp/tokenless-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js --version',
    `tar -C /tmp/tokenless-runtime -czf /output/${archiveName} .`,
  ].join('; ')
  await run('docker', [
    'run', '--rm',
    '--platform', revision.runtimePlatform,
    '--volume', `${cacheDir}:/artifacts:ro`,
    '--volume', `${runtimeArtifacts}:/output`,
    revision.runtimeImage,
    'bash', '-lc', buildScript, 'bash', ...containerArtifacts,
  ], { cwd: root })
  if (!await exists(archivePath)) throw new Error(`Runtime archive was not created: ${archivePath}`)
  return archivePath
}

async function localPackageClosure(checkout, rootPackageName) {
  const manifests = new Map()
  for (const manifestPath of await packageManifestPaths(checkout)) {
    const manifest = await readJson(manifestPath)
    if (typeof manifest.name === 'string' && !manifests.has(manifest.name)) {
      manifests.set(manifest.name, manifest)
    }
  }
  if (!manifests.has(rootPackageName)) throw new Error(`DeepSeek Harness package is missing: ${rootPackageName}`)
  const selected = new Set()
  const pending = [rootPackageName]
  while (pending.length > 0) {
    const packageName = pending.pop()
    if (selected.has(packageName)) continue
    selected.add(packageName)
    const manifest = manifests.get(packageName)
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    }
    for (const dependencyName of Object.keys(dependencies)) {
      if (manifests.has(dependencyName) && !selected.has(dependencyName)) pending.push(dependencyName)
    }
  }
  return [...selected]
    .sort()
    .map((packageName) => ({ name: packageName, version: manifests.get(packageName).version }))
}

async function packageManifestPaths(directory) {
  const paths = []
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) paths.push(...await packageManifestPaths(target))
    else if (entry.isFile() && entry.name === 'package.json') paths.push(target)
  }
  return paths
}

async function packageArtifact(packageValue, directories) {
  if (typeof packageValue.version !== 'string' || packageValue.version.trim() === '') {
    throw new Error(`Local package has no version: ${packageValue.name}`)
  }
  const filename = `${packageValue.name.replace(/^@/, '').replace('/', '-')}-${packageValue.version}.tgz`
  const matches = []
  for (const directory of directories) {
    if (await exists(path.join(directory, filename))) matches.push(path.join(directory, filename))
  }
  if (matches.length === 0) return null
  if (matches.length !== 1) {
    throw new Error(`Expected one packed artifact for ${packageValue.name}@${packageValue.version}, found ${matches.length}.`)
  }
  return matches[0]
}

async function runOracle(args) {
  const jobsDir = jobsDirectory(args)
  const task = option(args, '--task') ?? revision.wiringTask
  const jobName = option(args, '--job-name') ?? uniqueJobName('oracle')
  const jobDir = path.join(jobsDir, jobName)
  await refuseExisting(jobDir)
  await fs.mkdir(jobsDir, { recursive: true })
  const result = await run(harborCommand(), [
    ...harborPrefix(),
    'run',
    '-d', datasetIdentity(),
    '-a', 'oracle',
    '-i', task,
    '-n', '1',
    '-k', '1',
    '--max-retries', '0',
    '--job-name', jobName,
    '--jobs-dir', jobsDir,
    '--yes',
  ], { cwd: root, allowFailure: true })
  const report = await writeRunReport({
    jobDir,
    kind: 'oracle',
    provider: null,
    profile: null,
    task,
    attemptsPerTask: 1,
    expectedTrials: 1,
  })
  if (result.code !== 0) throw new Error(`Harbor oracle exited ${result.code}; evidence is preserved at ${jobDir}.`)
  assertComplete(report, 1)
  return report
}

async function runDeepSeekLane(kind, args) {
  const homeDir = path.resolve(requiredOption(args, '--home'))
  const provider = requiredOption(args, '--provider')
  const profile = requiredOption(args, '--profile')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(provider)) throw new Error('--provider is invalid.')
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('--profile is invalid.')
  if (kind === 'full' && option(args, '--task') !== undefined) throw new Error('The full command always runs the unchanged 89-task dataset.')

  const prepared = await prepare(args)
  const daemon = await ensureHostDaemon(homeDir, option(args, '--daemon-url'))
  const jobsDir = jobsDirectory(args)
  const jobName = option(args, '--job-name') ?? uniqueJobName(kind)
  const jobDir = path.join(jobsDir, jobName)
  await refuseExisting(jobDir)
  await fs.mkdir(jobsDir, { recursive: true })
  const task = kind === 'wiring' ? (option(args, '--task') ?? revision.wiringTask) : null
  const attemptsPerTask = kind === 'full' ? revision.attemptsPerTask : 1
  const expectedTrials = kind === 'full' ? revision.taskCount * attemptsPerTask : attemptsPerTask

  const harborArgs = [
    ...harborPrefix(),
    'run',
    '-d', datasetIdentity(),
    '-a', revision.agent,
    '-m', `tokenless/${provider}`,
    '-n', '1',
    '-k', String(attemptsPerTask),
    '--max-retries', '0',
    '--allow-agent-host', 'host.docker.internal',
    '--agent-include-logs', 'deep-integration.jsonl',
    '--agent-include-logs', 'dsh-tokenless-summary.json',
    '--agent-include-logs', 'dsh-error.txt',
    '--ak', `runtime_archive=${prepared.runtimeArchive}`,
    '--ak', `proxy_script=${path.join(benchmarkRoot, 'channel_proxy.py')}`,
    '--ak', `tokenless_home=${homeDir}`,
    '--ak', `daemon_url=${daemon.url}`,
    '--ak', `provider=${provider}`,
    '--ak', `profile=${profile}`,
    '--job-name', jobName,
    '--jobs-dir', jobsDir,
    '--yes',
  ]
  if (task !== null) harborArgs.push('-i', task)
  const result = await run(harborCommand(), harborArgs, {
    cwd: root,
    allowFailure: true,
    env: harborEnvironment(),
  })
  const report = await writeRunReport({
    jobDir,
    kind,
    provider,
    profile,
    task,
    attemptsPerTask,
    expectedTrials,
  })
  if (result.code !== 0) throw new Error(`Harbor ${kind} run exited ${result.code}; evidence is preserved at ${jobDir}.`)
  assertComplete(report, expectedTrials)
  if (report.deepIntegration.completeChains === 0) {
    throw new Error(`The ${kind} run observed no complete DSH parent -> Tokenless Harness provider -> child tool result -> DSH parent chain; evidence is preserved at ${jobDir}.`)
  }
  return report
}

async function ensureHostDaemon(homeDir, explicitDaemonUrl) {
  const runtimeEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'index.js')
  const runtime = await import(pathToFileURL(runtimeEntry).href)
  const config = await runtime.readTokenlessConfig(homeDir)
  return await runtime.ensureDaemonReady({
    homeDir,
    daemonUrl: runtime.daemonUrl(explicitDaemonUrl ?? config.daemonUrl ?? undefined),
  })
}

async function writeRunReport({ jobDir, kind, provider, profile, task, attemptsPerTask, expectedTrials }) {
  const destination = path.join(jobDir, 'tokenless-run.json')
  await refuseExisting(destination)
  const official = await readJson(path.join(jobDir, 'result.json'))
  const jobConfig = await readJson(path.join(jobDir, 'config.json'))
  const trialDirectories = (await fs.readdir(jobDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(jobDir, entry.name))
    .filter(async (directory) => exists(path.join(directory, 'result.json')))
  const trialResults = []
  const deepTrials = []
  for (const directory of trialDirectories) {
    if (!await exists(path.join(directory, 'result.json'))) continue
    trialResults.push(await readJson(path.join(directory, 'result.json')))
    const auditPath = path.join(directory, 'agent', 'deep-integration.jsonl')
    if (!await exists(auditPath)) continue
    const auditEvents = []
    for (const line of (await fs.readFile(auditPath, 'utf8')).split(/\r?\n/u)) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.protocol !== revision.auditProtocol) throw new Error(`Unexpected deep-integration audit protocol in ${auditPath}.`)
      auditEvents.push(event)
    }
    deepTrials.push(deepIntegrationStats(auditEvents))
  }
  validateResolvedRun({ official, jobConfig, trialResults, kind, task, attemptsPerTask, expectedTrials })
  const rewards = trialResults
    .map((trial) => trial?.verifier_result?.rewards?.reward)
    .filter((value) => typeof value === 'number')
  const [tokenlessRevision, tokenlessDirty] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
    capture('git', ['status', '--porcelain'], { cwd: root }),
  ])
  const stats = official.stats ?? {}
  const report = {
    schema: 'tokenless.terminalbench-run.v1',
    benchmark: revision.benchmark,
    harborVersion: revision.harborVersion,
    dataset: revision.dataset,
    datasetRef: revision.datasetRef,
    taskCount: kind === 'full' ? revision.taskCount : 1,
    task,
    attemptsPerTask,
    expectedTrials,
    completedTrials: stats.n_completed_trials ?? 0,
    erroredTrials: stats.n_errored_trials ?? 0,
    cancelledTrials: stats.n_cancelled_trials ?? 0,
    retries: stats.n_retries ?? 0,
    rewards: {
      count: rewards.length,
      mean: rewards.length === 0 ? null : rewards.reduce((sum, value) => sum + value, 0) / rewards.length,
      passed: rewards.filter((value) => value === 1).length,
    },
    agent: kind === 'oracle' ? 'oracle' : 'deepseek-harness-tokenless-deep',
    model: provider === null ? null : `tokenless/${provider}`,
    provider,
    profile,
    deepseekHarnessRevision: revision.deepseekHarnessRevision,
    tokenlessRevision: tokenlessRevision.trim(),
    tokenlessWorktreeDirty: tokenlessDirty.trim().length > 0,
    deepIntegration: aggregateDeepIntegration(deepTrials),
    jobDir,
  }
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return report
}

function validateResolvedRun({ official, jobConfig, trialResults, kind, task, attemptsPerTask, expectedTrials }) {
  if (official.n_total_trials !== expectedTrials || trialResults.length !== expectedTrials) {
    throw new Error(`Harbor resolved ${String(official.n_total_trials)} total trials and wrote ${trialResults.length}; expected ${expectedTrials}.`)
  }
  if (!Array.isArray(jobConfig.datasets) || jobConfig.datasets.length !== 1) {
    throw new Error('Harbor job config must resolve exactly one dataset.')
  }
  const dataset = jobConfig.datasets[0]
  const expectedTaskCount = kind === 'full' ? revision.taskCount : 1
  if (
    dataset.name !== revision.dataset
    || dataset.ref !== revision.datasetRef
    || !Array.isArray(dataset.task_names)
    || dataset.task_names.length !== expectedTaskCount
    || new Set(dataset.task_names).size !== expectedTaskCount
    || (task !== null && (dataset.task_names.length !== 1 || dataset.task_names[0] !== task))
  ) {
    throw new Error('Harbor did not resolve the pinned Terminal-Bench dataset and task manifest.')
  }
  const taskCounts = new Map(dataset.task_names.map((taskName) => [taskName, 0]))
  const taskRefs = new Map()
  const trialNames = new Set()
  for (const trial of trialResults) {
    const taskName = trial.task_name
    const taskRef = trial.task_id?.ref
    if (!taskCounts.has(taskName) || typeof taskRef !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(taskRef)) {
      throw new Error('A trial does not belong to the resolved pinned task manifest.')
    }
    if (taskRefs.has(taskName) && taskRefs.get(taskName) !== taskRef) {
      throw new Error(`Harbor resolved multiple task refs for ${taskName}.`)
    }
    taskRefs.set(taskName, taskRef)
    taskCounts.set(taskName, taskCounts.get(taskName) + 1)
    if (typeof trial.trial_name !== 'string' || trialNames.has(trial.trial_name)) {
      throw new Error('Harbor trial names must be present and unique.')
    }
    trialNames.add(trial.trial_name)
    validateUnmodifiedTrialConfig(trial.config)
  }
  if (taskRefs.size !== expectedTaskCount || [...taskCounts.values()].some((count) => count !== attemptsPerTask)) {
    throw new Error(`Harbor did not produce exactly k=${attemptsPerTask} trials for every resolved task.`)
  }
}

function validateUnmodifiedTrialConfig(config) {
  const environment = config?.environment
  const agent = config?.agent
  const verifier = config?.verifier
  if (
    config?.timeout_multiplier !== 1
    || config?.agent_timeout_multiplier !== null
    || config?.verifier_timeout_multiplier !== null
    || config?.agent_setup_timeout_multiplier !== null
    || config?.environment_build_timeout_multiplier !== null
    || agent?.override_timeout_sec !== null
    || agent?.override_setup_timeout_sec !== null
    || agent?.max_timeout_sec !== null
    || verifier?.override_timeout_sec !== null
    || verifier?.max_timeout_sec !== null
    || environment?.override_cpus !== null
    || environment?.override_memory_mb !== null
    || environment?.override_storage_mb !== null
    || environment?.override_gpus !== null
    || environment?.override_tpu !== null
  ) {
    throw new Error('A Harbor trial changed an official task timeout or resource limit.')
  }
}

function deepIntegrationStats(events) {
  const validTypes = new Set([
    'harness.started',
    'api.completion.request',
    'provider.turn.started',
    'child.tool_result',
    'harness.settled',
    'dsh.parent.completed',
  ])
  for (const [index, event] of events.entries()) {
    if (!validTypes.has(event.type) || event.sequence !== index + 1) {
      throw new Error('Deep integration audit events are invalid or out of sequence.')
    }
  }
  const started = events.filter((event) => event.type === 'harness.started')
  let completeChains = 0
  for (const start of started) {
    const settled = events.find((event) => (
      event.type === 'harness.settled'
      && event.runId === start.runId
      && event.status === 'succeeded'
      && event.sequence > start.sequence
    ))
    if (!settled) continue
    const providerTurn = events.some((event) => (
      event.type === 'provider.turn.started'
      && event.sequence > start.sequence
      && event.sequence < settled.sequence
      && event.status < 400
    ))
    const toolResult = events.some((event) => (
      event.type === 'child.tool_result'
      && event.runId === start.runId
      && event.status === 'succeeded'
      && event.sequence > start.sequence
      && event.sequence < settled.sequence
    ))
    const parentCompleted = events.some((event) => event.type === 'dsh.parent.completed' && event.sequence > settled.sequence)
    if (providerTurn && toolResult && parentCompleted) completeChains += 1
  }
  return {
    started: started.length,
    providerTurns: events.filter((event) => event.type === 'provider.turn.started' && event.status < 400).length,
    toolResults: events.filter((event) => event.type === 'child.tool_result').length,
    succeededToolResults: events.filter((event) => event.type === 'child.tool_result' && event.status === 'succeeded').length,
    settled: events.filter((event) => event.type === 'harness.settled').length,
    succeeded: events.filter((event) => event.type === 'harness.settled' && event.status === 'succeeded').length,
    parentCompleted: events.filter((event) => event.type === 'dsh.parent.completed').length,
    completeChains,
  }
}

function aggregateDeepIntegration(trials) {
  const fields = ['started', 'providerTurns', 'toolResults', 'succeededToolResults', 'settled', 'succeeded', 'parentCompleted', 'completeChains']
  return {
    protocol: revision.auditProtocol,
    trialsWithCompleteChain: trials.filter((trial) => trial.completeChains > 0).length,
    ...Object.fromEntries(fields.map((field) => [field, trials.reduce((sum, trial) => sum + trial[field], 0)])),
  }
}

function assertComplete(report, expectedTrials) {
  if (
    report.completedTrials !== expectedTrials
    || report.erroredTrials !== 0
    || report.cancelledTrials !== 0
    || report.retries !== 0
    || report.rewards.count !== expectedTrials
  ) {
    throw new Error(`Terminal-Bench run is incomplete; evidence is preserved at ${report.jobDir}.`)
  }
}

async function assertPinnedCheckout(checkout) {
  const [revisionValue, dirty] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: checkout }),
    capture('git', ['status', '--porcelain'], { cwd: checkout }),
  ])
  if (revisionValue.trim() !== revision.deepseekHarnessRevision) {
    throw new Error(`DeepSeek Harness must be pinned to ${revision.deepseekHarnessRevision}; found ${revisionValue.trim()}.`)
  }
  if (dirty.trim()) throw new Error('DeepSeek Harness tracked files must be clean; source patches are not allowed.')
}

function harborCommand() {
  return 'uvx'
}

function harborPrefix() {
  return ['--from', `harbor==${revision.harborVersion}`, 'harbor']
}

function harborEnvironment() {
  return {
    ...process.env,
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  }
}

function datasetIdentity() {
  return `${revision.dataset}@${revision.datasetRef}`
}

function jobsDirectory(args) {
  return path.resolve(option(args, '--jobs-dir') ?? path.join(benchmarkRoot, 'runs'))
}

function uniqueJobName(kind) {
  return `tokenless-tb2-${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
}

async function refuseExisting(target) {
  if (await exists(target)) throw new Error(`Refusing to overwrite existing benchmark evidence: ${target}`)
}

async function exists(target) {
  return fs.access(target).then(() => true, () => false)
}

async function readJson(target) {
  return JSON.parse(await fs.readFile(target, 'utf8'))
}

function option(args, name) {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value.`)
  return value
}

function requiredOption(args, name) {
  const value = option(args, name)
  if (value === undefined || value.trim() === '') throw new Error(`${name} is required.`)
  return value
}

function run(commandName, args, { cwd, allowFailure = false, env = process.env, captureFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd,
      stdio: captureFailure ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env,
    })
    let diagnostics = ''
    if (captureFailure) {
      const append = (chunk) => {
        diagnostics = `${diagnostics}${chunk.toString('utf8')}`.slice(-20_000)
      }
      child.stdout.on('data', append)
      child.stderr.on('data', append)
    }
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      const exitCode = code ?? 1
      if (!allowFailure && exitCode !== 0) {
        const detail = diagnostics.trim() === '' ? '' : `\n${diagnostics.trim()}`
        reject(new Error(`${commandName} exited ${exitCode}${signal ? ` (${signal})` : ''}.${detail}`))
      }
      else resolve({ code: exitCode, signal })
    })
  })
}

function capture(commandName, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) reject(new Error(`${commandName} exited ${String(code)}: ${stderr.trim()}`))
      else resolve(stdout)
    })
  })
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function helpText() {
  return `Terminal-Bench 2.0 DeepSeek Harness lane\n\n` +
    `Commands:\n` +
    `  inspect\n` +
    `  prepare --dsh-checkout <path>\n` +
    `  oracle [--task terminal-bench/<name>] [--jobs-dir <path>]\n` +
    `  wiring --home <path> --dsh-checkout <path> --provider <id> --profile <id> [--task terminal-bench/<name>]\n` +
    `  full --home <path> --dsh-checkout <path> --provider <id> --profile <id>\n\n` +
    `The full command is fixed to Harbor ${revision.harborVersion}, the 89-task Terminal-Bench 2.0 dataset, k=5, one concurrent trial, and zero agent retries.\n`
}
