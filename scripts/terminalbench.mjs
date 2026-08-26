#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const benchmarkRoot = path.join(root, 'benchmarks', 'terminalbench')
const revision = JSON.parse(await fs.readFile(path.join(benchmarkRoot, 'revision.json'), 'utf8'))
const SEMANTIC_MANIFEST_SCHEMA = 'tokenless.terminalbench-semantic-manifest.v1'
const SEMANTIC_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u
const SEMANTIC_COMPLEXITIES = new Set(['low', 'medium', 'high'])
const [command = 'help', ...argv] = process.argv.slice(2)

try {
  if (command === 'inspect') {
    const manifest = await validateTaskManifest()
    output({
      ok: true,
      ...revision,
      taskManifest: {
        path: manifest.path,
        datasetRef: manifest.datasetRef,
        instructionDigest: manifest.instructionDigest,
        taskRefDigest: manifest.taskRefDigest,
        taskCount: manifest.taskCount,
      },
    })
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
  const taskManifest = path.resolve(root, revision.taskManifest)
  const manifest = await validateTaskManifest(taskManifest)
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
    taskManifest,
    taskManifestDigest: manifest.instructionDigest,
  })
  await assertPinnedCheckout(dshCheckout)
  return {
    dshCheckout,
    dshRevision: revision.deepseekHarnessRevision,
    dshArtifacts,
    vendorArtifacts,
    tokenlessPackage,
    runtimeArchive,
    taskManifest,
    taskManifestDigest: manifest.instructionDigest,
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
  const profile = requiredOption(args, '--profile')
  const semanticManifest = await validateSemanticManifest(path.resolve(requiredOption(args, '--semantic-manifest')))
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('--profile is invalid.')
  if (kind === 'full' && option(args, '--task') !== undefined) throw new Error('The full command always runs the unchanged 89-task dataset.')
  const task = kind === 'wiring' ? (option(args, '--task') ?? revision.wiringTask) : null
  const taskManifestIdentity = await validateTaskManifest()
  if (task !== null) {
    const taskName = task.startsWith('terminal-bench/') ? task.slice('terminal-bench/'.length) : ''
    if (taskManifestIdentity.taskRefs[taskName] === undefined) {
      throw new Error('The wiring task is not in the pinned Terminal-Bench task manifest.')
    }
  }

  const prepared = await prepare(args)
  const daemon = await ensureHostDaemon(homeDir, option(args, '--daemon-url'))
  const jobsDir = jobsDirectory(args)
  const jobName = option(args, '--job-name') ?? uniqueJobName(kind)
  const jobDir = path.join(jobsDir, jobName)
  await refuseExisting(jobDir)
  await fs.mkdir(jobsDir, { recursive: true })
  const attemptsPerTask = kind === 'full' ? revision.attemptsPerTask : 1
  const expectedTrials = kind === 'full' ? revision.taskCount * attemptsPerTask : attemptsPerTask

  const harborArgs = [
    ...harborPrefix(),
    'run',
    '-d', datasetIdentity(),
    '-a', revision.agent,
    '-m', revision.model,
    '-n', '1',
    '-k', String(attemptsPerTask),
    '--max-retries', '0',
    '--allow-agent-host', 'host.docker.internal',
    '--agent-include-logs', 'deep-integration.jsonl',
    '--agent-include-logs', 'dsh-tokenless-summary.json',
    '--agent-include-logs', 'dsh-classification.json',
    '--ak', `runtime_archive=${prepared.runtimeArchive}`,
    '--ak', `proxy_script=${path.join(benchmarkRoot, 'channel_proxy.py')}`,
    '--ak', `tokenless_home=${homeDir}`,
    '--ak', `daemon_url=${daemon.url}`,
    '--ak', `profile=${profile}`,
    '--ak', `task_manifest=${prepared.taskManifest}`,
    '--ak', `semantic_manifest=${semanticManifest.path}`,
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
    profile,
    task,
    attemptsPerTask,
    expectedTrials,
    runtimeArchive: prepared.runtimeArchive,
    proxyScript: path.join(benchmarkRoot, 'channel_proxy.py'),
    tokenlessHome: homeDir,
    daemonUrl: daemon.url,
    taskManifest: prepared.taskManifest,
    semanticManifest,
  })
  if (result.code !== 0) throw new Error(`Harbor ${kind} run exited ${result.code}; evidence is preserved at ${jobDir}.`)
  assertComplete(report, expectedTrials)
  if (report.deepIntegration.trialsWithCompleteChain !== expectedTrials) {
    throw new Error(`The ${kind} run is missing complete host-observed DSH parent -> child Tokenless Harness provider-turn evidence for every trial; evidence is preserved at ${jobDir}.`)
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

async function writeRunReport({
  jobDir,
  kind,
  profile,
  task,
  attemptsPerTask,
  expectedTrials,
  runtimeArchive,
  proxyScript,
  tokenlessHome,
  daemonUrl,
  taskManifest,
  semanticManifest = null,
}) {
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
    if (!await exists(auditPath)) {
      if (kind !== 'oracle') throw new Error(`Missing deep-integration.jsonl for non-oracle trial ${directory}.`)
      continue
    }
    const auditEvents = []
    for (const line of (await fs.readFile(auditPath, 'utf8')).split(/\r?\n/u)) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.protocol !== revision.auditProtocol) throw new Error(`Unexpected deep-integration audit protocol in ${auditPath}.`)
      auditEvents.push(event)
    }
    deepTrials.push(deepIntegrationStats(auditEvents))
  }
  if (kind !== 'oracle' && deepTrials.length !== expectedTrials) {
    throw new Error(`Expected deep-integration evidence for ${expectedTrials} non-oracle trials, found ${deepTrials.length}.`)
  }
  const taskManifestIdentity = await validateTaskManifest(taskManifest)
  validateResolvedRun({
    official,
    jobConfig,
    trialResults,
    deepTrials,
    kind,
    task,
    attemptsPerTask,
    expectedTrials,
    runtimeArchive,
    proxyScript,
    tokenlessHome,
    daemonUrl,
    profile,
    taskManifest,
    taskManifestIdentity,
    semanticManifest,
  })
  const rewards = trialResults
    .map((trial) => trial?.verifier_result?.rewards?.reward)
  const [tokenlessRevision, tokenlessDirty] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
    capture('git', ['status', '--porcelain'], { cwd: root }),
  ])
  const stats = official.stats
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
    completedTrials: stats.n_completed_trials,
    erroredTrials: stats.n_errored_trials,
    cancelledTrials: stats.n_cancelled_trials,
    retries: stats.n_retries,
    rewards: {
      count: rewards.length,
      mean: rewards.length === 0 ? null : rewards.reduce((sum, value) => sum + value, 0) / rewards.length,
      passed: rewards.filter((value) => value === 1).length,
    },
    agent: kind === 'oracle' ? 'oracle' : 'deepseek-harness-tokenless-deep',
    model: kind === 'oracle' ? null : revision.model,
    routingMode: kind === 'oracle' ? null : 'auto',
    profile,
    deepseekHarnessRevision: revision.deepseekHarnessRevision,
    tokenlessRevision: tokenlessRevision.trim(),
    tokenlessWorktreeDirty: tokenlessDirty.trim().length > 0,
    deepIntegration: aggregateDeepIntegration(deepTrials),
    providerRouting: aggregateProviderRouting(deepTrials),
    taskManifest: {
      datasetRef: revision.datasetRef,
      instructionDigest: taskManifestIdentity.instructionDigest,
      taskRefDigest: taskManifestIdentity.taskRefDigest,
      taskCount: revision.taskCount,
    },
    semanticManifest: semanticManifest === null ? null : {
      schema: SEMANTIC_MANIFEST_SCHEMA,
      manifestDigest: semanticManifest.manifestDigest,
      taskCount: semanticManifest.taskCount,
    },
    jobDir,
  }
  await fs.writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return report
}

function validateResolvedRun({
  official,
  jobConfig,
  trialResults,
  deepTrials,
  kind,
  task,
  attemptsPerTask,
  expectedTrials,
  runtimeArchive,
  proxyScript,
  tokenlessHome,
  daemonUrl,
  profile,
  taskManifest,
  taskManifestIdentity,
  semanticManifest,
}) {
  if (official.n_total_trials !== expectedTrials || trialResults.length !== expectedTrials) {
    throw new Error(`Harbor resolved ${String(official.n_total_trials)} total trials and wrote ${trialResults.length}; expected ${expectedTrials}.`)
  }
  validateHarborStats(official.stats, expectedTrials)
  if (!Number.isSafeInteger(jobConfig.n_concurrent_trials) || jobConfig.n_concurrent_trials !== 1) {
    throw new Error('Harbor resolved concurrency must be exactly one trial.')
  }
  const resolvedAttempts = jobConfig.n_attempts === undefined ? 1 : jobConfig.n_attempts
  if (!Number.isSafeInteger(resolvedAttempts) || resolvedAttempts !== attemptsPerTask) {
    throw new Error(`Harbor resolved k=${String(resolvedAttempts)}; expected k=${attemptsPerTask}.`)
  }
  const resolvedMaxRetries = jobConfig.retry === undefined ? 0 : jobConfig.retry?.max_retries
  if (!Number.isSafeInteger(resolvedMaxRetries) || resolvedMaxRetries !== 0) {
    throw new Error(`Harbor resolved max retries=${String(resolvedMaxRetries)}; expected zero.`)
  }
  if (kind !== 'oracle') {
    if (deepTrials.length !== expectedTrials || deepTrials.some((trial) => trial.completeChains !== 1)) {
      throw new Error('Every non-oracle trial must have exactly one complete host-observed deep-integration chain.')
    }
    validateDeepSeekAgent(jobConfig, {
      runtime_archive: runtimeArchive,
      proxy_script: proxyScript,
      tokenless_home: tokenlessHome,
      daemon_url: daemonUrl,
      profile,
      task_manifest: taskManifest,
      semantic_manifest: semanticManifest?.path,
    })
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
  const resolvedTaskRefs = new Map()
  const trialNames = new Set()
  for (const trial of trialResults) {
    const taskName = trial.task_name
    const taskRef = trial.task_id?.ref
    const manifestTaskName = typeof taskName === 'string' && taskName.startsWith('terminal-bench/')
      ? taskName.slice('terminal-bench/'.length)
      : null
    if (
      !taskCounts.has(taskName)
      || manifestTaskName === null
      || taskManifestIdentity.taskRefs[manifestTaskName] !== taskRef
    ) {
      throw new Error('A trial does not belong to the resolved pinned task manifest.')
    }
    if (resolvedTaskRefs.has(taskName) && resolvedTaskRefs.get(taskName) !== taskRef) {
      throw new Error(`Harbor resolved multiple task refs for ${taskName}.`)
    }
    resolvedTaskRefs.set(taskName, taskRef)
    taskCounts.set(taskName, taskCounts.get(taskName) + 1)
    if (typeof trial.trial_name !== 'string' || trialNames.has(trial.trial_name)) {
      throw new Error('Harbor trial names must be present and unique.')
    }
    if (typeof trial?.verifier_result?.rewards?.reward !== 'number' || !Number.isFinite(trial.verifier_result.rewards.reward)) {
      throw new Error(`Harbor trial ${String(trial.trial_name)} is missing its verifier reward.`)
    }
    trialNames.add(trial.trial_name)
    validateUnmodifiedTrialConfig(trial.config)
  }
  if (resolvedTaskRefs.size !== expectedTaskCount || [...taskCounts.values()].some((count) => count !== attemptsPerTask)) {
    throw new Error(`Harbor did not produce exactly k=${attemptsPerTask} trials for every resolved task.`)
  }
}

async function validateTaskManifest(manifestPath = path.resolve(root, revision.taskManifest)) {
  const manifest = await readJson(manifestPath)
  if (
    manifest.schema !== 'tokenless.terminalbench-task-manifest.v1'
    || manifest.dataset !== revision.dataset
    || manifest.datasetRef !== revision.datasetRef
    || manifest.instructionDigest !== revision.instructionDigest
    || manifest.taskRefDigest !== revision.taskRefDigest
    || manifest.instructionFile !== 'instruction.md'
    || manifest.taskCount !== revision.taskCount
    || !manifest.tasks
    || typeof manifest.tasks !== 'object'
    || Array.isArray(manifest.tasks)
    || !manifest.taskRefs
    || typeof manifest.taskRefs !== 'object'
    || Array.isArray(manifest.taskRefs)
  ) {
    throw new Error('Terminal-Bench task manifest does not match the pinned official dataset.')
  }
  const taskNames = Object.keys(manifest.tasks)
  const taskRefNames = Object.keys(manifest.taskRefs)
  const sortedTaskNames = [...taskNames].sort()
  if (
    taskNames.length !== revision.taskCount
    || taskNames.some((name, index) => name !== sortedTaskNames[index])
    || taskRefNames.length !== taskNames.length
    || taskRefNames.some((name, index) => name !== taskNames[index])
    || taskNames.some((name) => !/^[-a-z0-9]+$/u.test(name))
    || taskNames.some((name) => typeof manifest.tasks[name] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(manifest.tasks[name]))
    || taskNames.some((name) => typeof manifest.taskRefs[name] !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(manifest.taskRefs[name]))
  ) {
    throw new Error(`Terminal-Bench task manifest must contain exactly ${revision.taskCount} sorted instruction digests.`)
  }
  const instructionDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.tasks)).digest('hex')}`
  if (manifest.instructionDigest !== instructionDigest) {
    throw new Error('Terminal-Bench task manifest instruction digest is invalid.')
  }
  const taskRefDigest = `sha256:${createHash('sha256').update(JSON.stringify(manifest.taskRefs)).digest('hex')}`
  if (manifest.taskRefDigest !== taskRefDigest) {
    throw new Error('Terminal-Bench task manifest task ref digest is invalid.')
  }
  const wiringTaskName = typeof revision.wiringTask === 'string' && revision.wiringTask.startsWith('terminal-bench/')
    ? revision.wiringTask.slice('terminal-bench/'.length)
    : ''
  if (manifest.taskRefs[wiringTaskName] === undefined) {
    throw new Error('Terminal-Bench wiring task is not in the pinned task manifest.')
  }
  return {
    path: manifestPath,
    datasetRef: manifest.datasetRef,
    instructionDigest,
    taskRefDigest,
    taskRefs: Object.freeze({ ...manifest.taskRefs }),
    taskCount: taskNames.length,
  }
}

async function validateSemanticManifest(manifestPath) {
  const manifest = await readJson(manifestPath)
  const officialPath = path.resolve(root, revision.taskManifest)
  const official = await readJson(officialPath)
  await validateTaskManifest(officialPath)
  const expectedKeys = ['schema', 'dataset', 'datasetRef', 'officialInstructionDigest', 'entries', 'manifestDigest']
  if (
    !manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !sameStringSet(Object.keys(manifest), expectedKeys)
    || manifest.schema !== SEMANTIC_MANIFEST_SCHEMA
    || manifest.dataset !== revision.dataset
    || manifest.datasetRef !== revision.datasetRef
    || manifest.officialInstructionDigest !== official.instructionDigest
    || !Array.isArray(manifest.entries)
    || manifest.entries.length !== revision.taskCount
    || typeof manifest.manifestDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(manifest.manifestDigest)
  ) {
    throw new Error('Terminal-Bench semantic manifest does not match the pinned official task hash manifest.')
  }
  const officialDigests = Object.values(official.tasks)
  const entries = manifest.entries
  const sortedEntries = [...entries].sort((left, right) => {
    const leftDigest = String(left?.instructionDigest)
    const rightDigest = String(right?.instructionDigest)
    return leftDigest < rightDigest ? -1 : leftDigest > rightDigest ? 1 : 0
  })
  if (entries.some((entry, index) => entry !== sortedEntries[index])) {
    throw new Error('Terminal-Bench semantic manifest entries must be sorted by full instruction digest.')
  }
  const seen = new Set()
  for (const entry of entries) {
    if (
      !entry || typeof entry !== 'object' || Array.isArray(entry)
      || !sameStringSet(Object.keys(entry), ['instructionDigest', 'preferredProvider', 'taskType', 'complexity', 'truncated'])
      || typeof entry.instructionDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(entry.instructionDigest)
      || !officialDigests.includes(entry.instructionDigest)
      || seen.has(entry.instructionDigest)
      || typeof entry.preferredProvider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(entry.preferredProvider)
      || typeof entry.taskType !== 'string'
      || !SEMANTIC_TASK_TYPE_PATTERN.test(entry.taskType)
      || !SEMANTIC_COMPLEXITIES.has(entry.complexity)
      || typeof entry.truncated !== 'boolean'
    ) {
      throw new Error('Terminal-Bench semantic manifest entry is invalid or not an official instruction digest.')
    }
    seen.add(entry.instructionDigest)
  }
  if (seen.size !== officialDigests.length || officialDigests.some((digest) => !seen.has(digest))) {
    throw new Error('Terminal-Bench semantic manifest must cover every official task instruction exactly once.')
  }
  const canonical = {
    schema: manifest.schema,
    dataset: manifest.dataset,
    datasetRef: manifest.datasetRef,
    officialInstructionDigest: manifest.officialInstructionDigest,
    entries,
  }
  const manifestDigest = `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`
  if (manifest.manifestDigest !== manifestDigest) {
    throw new Error('Terminal-Bench semantic manifest digest is invalid.')
  }
  return {
    path: manifestPath,
    manifestDigest,
    taskCount: entries.length,
  }
}

function validateHarborStats(stats, expectedTrials) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) {
    throw new Error('Harbor result is missing resolved trial stats.')
  }
  for (const field of [
    'n_completed_trials',
    'n_errored_trials',
    'n_running_trials',
    'n_pending_trials',
    'n_cancelled_trials',
    'n_retries',
  ]) {
    if (!Number.isSafeInteger(stats[field]) || stats[field] < 0) {
      throw new Error(`Harbor result is missing a valid stats.${field} field.`)
    }
  }
  if (
    stats.n_completed_trials !== expectedTrials
    || stats.n_errored_trials !== 0
    || stats.n_cancelled_trials !== 0
    || stats.n_running_trials !== 0
    || stats.n_pending_trials !== 0
    || stats.n_retries !== 0
    || stats.n_completed_trials + stats.n_errored_trials + stats.n_cancelled_trials !== expectedTrials
  ) {
    throw new Error('Harbor result stats are not a settled, zero-retry result for the resolved trial count.')
  }
}

function validateDeepSeekAgent(jobConfig, expected) {
  if (!expected || Object.values(expected).some((value) => typeof value !== 'string')) {
    throw new Error('Terminal-Bench runtime launch values are incomplete.')
  }
  if (!Array.isArray(jobConfig.agents) || jobConfig.agents.length !== 1) {
    throw new Error('Harbor must resolve exactly one DeepSeek Harness agent.')
  }
  const agent = jobConfig.agents[0]
  if (!agent || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error('Harbor resolved an invalid DeepSeek Harness agent record.')
  }
  if (
    agent.name !== revision.agent
    || (agent.import_path !== undefined && agent.import_path !== null)
    || agent.model_name !== revision.model
    || !agent.kwargs
    || typeof agent.kwargs !== 'object'
    || Array.isArray(agent.kwargs)
    || !sameStringSet(Object.keys(agent.kwargs), Object.keys(expected))
    || Object.entries(expected).some(([key, value]) => agent.kwargs[key] !== value)
    || (agent.env !== undefined && agent.env !== null)
    || hasProviderPin(agent.kwargs)
  ) {
    throw new Error('Harbor did not resolve the provider-neutral DeepSeek Harness agent configuration.')
  }
}

function hasProviderPin(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && Object.keys(value).some((key) => /provider/iu.test(key))
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value))
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
    'api.completion.request',
    'child.turn.started',
    'provider.routing',
    'dsh.parent.completed',
  ])
  let nextParentOrdinal = 1
  for (const [index, event] of events.entries()) {
    if (!validTypes.has(event.type) || event.sequence !== index + 1) {
      throw new Error('Deep integration audit events are invalid or out of sequence.')
    }
    if (event.type === 'api.completion.request') {
      if (
        Object.keys(event).some((key) => !['protocol', 'sequence', 'type', 'ordinal', 'forcedSubagent'].includes(key))
        || event.ordinal !== nextParentOrdinal
        || !Number.isSafeInteger(event.ordinal)
        || event.ordinal < 1
        || event.forcedSubagent !== true && event.forcedSubagent !== false
      ) {
        throw new Error('Host parent completion evidence is invalid.')
      }
      nextParentOrdinal += 1
    } else if (event.type === 'child.turn.started') {
      if (
        Object.keys(event).some((key) => !['protocol', 'sequence', 'type', 'mode'].includes(key))
        || (event.mode !== 'bootstrap' && event.mode !== 'continuation')
      ) {
        throw new Error('Host child turn evidence is invalid.')
      }
    } else if (event.type === 'provider.routing') {
      validateProviderRoutingEvent(event)
    } else if (Object.keys(event).some((key) => !['protocol', 'sequence', 'type'].includes(key))) {
      throw new Error('Host DSH process evidence is invalid.')
    }
  }

  const parentRequests = events.filter((event) => event.type === 'api.completion.request')
  const childStarts = events.filter((event) => event.type === 'child.turn.started')
  const routing = events.filter((event) => event.type === 'provider.routing')
  const forcedParents = parentRequests.filter((event) => event.forcedSubagent === true)
  if (forcedParents.length !== 1) {
    throw new Error('Deep integration requires exactly one successful forced parent subagent dispatch.')
  }
  const firstForcedParent = forcedParents[0]
  const nextParentRequestAfterForced = firstForcedParent
    ? parentRequests.find((event) => event.sequence > firstForcedParent.sequence)
    : undefined
  const firstParentRoute = firstForcedParent
    ? routing.find((event) => (
      event.scope === 'parent'
      && event.outcome === 'completed'
      && event.sequence > firstForcedParent.sequence
      && (nextParentRequestAfterForced === undefined || event.sequence < nextParentRequestAfterForced.sequence)
    ))
    : undefined
  const childWindowEnd = nextParentRequestAfterForced?.sequence ?? Number.POSITIVE_INFINITY
  const delegatedChildStarts = firstParentRoute
    ? childStarts.filter((event) => (
      event.sequence > firstParentRoute.sequence
      && event.sequence < childWindowEnd
    ))
    : []
  const childModesValid = delegatedChildStarts.length >= 2
    && delegatedChildStarts[0]?.mode === 'bootstrap'
    && delegatedChildStarts.slice(1).every((event) => event.mode === 'continuation')
  const completedChildRoutes = childModesValid
    ? delegatedChildStarts.map((start, index) => {
      const nextStart = delegatedChildStarts[index + 1]
      const end = nextStart?.sequence ?? childWindowEnd
      return routing.find((event) => (
        event.scope === 'child'
        && event.outcome === 'completed'
        && event.sequence > start.sequence
        && event.sequence < end
      ))
    })
    : []
  const allChildRoutesComplete = completedChildRoutes.length === delegatedChildStarts.length
    && completedChildRoutes.every(Boolean)
  const finalChildRoute = allChildRoutesComplete
    ? completedChildRoutes[completedChildRoutes.length - 1]
    : undefined
  const laterParentRequest = finalChildRoute
    && nextParentRequestAfterForced
    && nextParentRequestAfterForced.sequence > finalChildRoute.sequence
    ? nextParentRequestAfterForced
    : undefined
  const nextParentRequestAfterLater = laterParentRequest
    ? parentRequests.find((event) => event.sequence > laterParentRequest.sequence)
    : undefined
  const laterParentRoute = laterParentRequest
    ? routing.find((event) => (
      event.scope === 'parent'
      && event.outcome === 'completed'
      && event.sequence > laterParentRequest.sequence
      && (nextParentRequestAfterLater === undefined || event.sequence < nextParentRequestAfterLater.sequence)
    ))
    : undefined
  const parentCompleted = laterParentRoute
    ? events.find((event) => event.type === 'dsh.parent.completed' && event.sequence > laterParentRoute.sequence)
    : undefined
  const completeChains = parentCompleted ? 1 : 0
  return {
    parentCompletionRequests: parentRequests.length,
    forcedParentCompletionRequests: parentRequests.filter((event) => event.forcedSubagent === true).length,
    childTurnStarts: childStarts.length,
    childBootstrapTurns: childStarts.filter((event) => event.mode === 'bootstrap').length,
    childContinuationTurns: childStarts.filter((event) => event.mode === 'continuation').length,
    providerRoutingEvents: routing.length,
    completedParentRouting: routing.filter((event) => event.scope === 'parent' && event.outcome === 'completed').length,
    completedChildRouting: routing.filter((event) => event.scope === 'child' && event.outcome === 'completed').length,
    parentCompleted: events.filter((event) => event.type === 'dsh.parent.completed').length,
    completeChains,
    providerRouting: providerRoutingStats(events),
  }
}

function aggregateDeepIntegration(trials) {
  const fields = [
    'parentCompletionRequests',
    'forcedParentCompletionRequests',
    'childTurnStarts',
    'childBootstrapTurns',
    'childContinuationTurns',
    'providerRoutingEvents',
    'completedParentRouting',
    'completedChildRouting',
    'parentCompleted',
    'completeChains',
  ]
  return {
    protocol: revision.auditProtocol,
    trialsWithCompleteChain: trials.filter((trial) => trial.completeChains > 0).length,
    ...Object.fromEntries(fields.map((field) => [field, trials.reduce((sum, trial) => sum + trial[field], 0)])),
  }
}

function validateProviderRoutingEvent(event) {
  if (
    Object.keys(event).some((key) => ![
      'protocol', 'sequence', 'type', 'scope', 'mode', 'provider',
      'fallbackProviders', 'fallbackUsed', 'rateLimited', 'preferenceRequested',
      'preferenceHonored', 'attempts', 'outcome',
    ].includes(key))
    ||
    event.protocol !== revision.auditProtocol
    || (event.scope !== 'parent' && event.scope !== 'child')
    || (event.mode !== 'auto' && event.mode !== 'explicit')
    || typeof event.provider !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(event.provider)
    || !Array.isArray(event.fallbackProviders)
    || event.fallbackProviders.length > 5
    || event.fallbackProviders.some((provider) => typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(provider))
    || typeof event.fallbackUsed !== 'boolean'
    || typeof event.rateLimited !== 'boolean'
    || event.preferenceRequested !== null && (
      typeof event.preferenceRequested !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(event.preferenceRequested)
    )
    || typeof event.preferenceHonored !== 'boolean'
    || event.preferenceHonored && event.preferenceRequested === null
    || !Array.isArray(event.attempts)
    || event.attempts.length > 5
    || event.attempts.some((attempt) => (
      !attempt
      || typeof attempt !== 'object'
      || Object.keys(attempt).some((key) => !['provider', 'outcome', 'reason'].includes(key))
      || typeof attempt.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(attempt.provider)
      || attempt.outcome !== 'fallback'
      || !['rate_limit', 'capacity', 'auth', 'unavailable'].includes(attempt.reason)
    ))
    || event.fallbackUsed !== (event.attempts.length > 0)
    || (event.outcome !== 'completed' && event.outcome !== 'failed')
    || event.outcome === 'completed' && event.rateLimited
  ) {
    throw new Error('Provider routing audit event is invalid.')
  }
}

function emptyProviderRoutingCounts() {
  return {
    routed: 0,
    attempted: 0,
    rateLimited: 0,
    fallbackOut: 0,
    completed: 0,
    failed: 0,
    preferenceRequested: 0,
    preferenceHonored: 0,
  }
}

function providerRoutingStats(events) {
  const scopes = { parent: {}, child: {} }
  for (const event of events) {
    if (event.type !== 'provider.routing') continue
    const providers = scopes[event.scope]
    const current = providers[event.provider] ?? emptyProviderRoutingCounts()
    current.routed += 1
    current.attempted += 1
    if (event.rateLimited) current.rateLimited += 1
    if (event.outcome === 'completed') current.completed += 1
    else current.failed += 1
    providers[event.provider] = current
    for (const attempt of event.attempts) {
      const attempted = providers[attempt.provider] ?? emptyProviderRoutingCounts()
      attempted.routed += 1
      attempted.attempted += 1
      attempted.fallbackOut += 1
      attempted.failed += 1
      if (attempt.reason === 'rate_limit') attempted.rateLimited += 1
      providers[attempt.provider] = attempted
    }
    if (event.preferenceRequested !== null) {
      const preferred = providers[event.preferenceRequested] ?? emptyProviderRoutingCounts()
      preferred.preferenceRequested += 1
      if (event.preferenceHonored) preferred.preferenceHonored += 1
      providers[event.preferenceRequested] = preferred
    }
  }
  return scopes
}

function aggregateProviderRouting(trials) {
  const scopes = { parent: { providers: {} }, child: { providers: {} } }
  for (const trial of trials) {
    for (const scope of ['parent', 'child']) {
      for (const [provider, counts] of Object.entries(trial.providerRouting?.[scope] ?? {})) {
        const current = scopes[scope].providers[provider] ?? emptyProviderRoutingCounts()
        for (const field of Object.keys(current)) current[field] += counts[field]
        scopes[scope].providers[provider] = current
      }
    }
  }
  return {
    protocol: revision.routingProtocol,
    mode: 'auto',
    tokenUsage: {
      availability: 'unavailable',
      reason: 'browser_provider_turns_do_not_expose_token_usage',
    },
    scopes,
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
    `  wiring --home <path> --dsh-checkout <path> --profile <id> --semantic-manifest <path> [--task terminal-bench/<name>]\n` +
    `  full --home <path> --dsh-checkout <path> --profile <id> --semantic-manifest <path>\n\n` +
    `The full command is fixed to Harbor ${revision.harborVersion}, the 89-task Terminal-Bench 2.0 dataset, k=5, one concurrent trial, and zero Harbor retries.\n`
}
