#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Ajv from 'ajv'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const benchmarkRoot = path.join(root, 'benchmarks', 'terminalbench')
const revision = JSON.parse(await fs.readFile(path.join(benchmarkRoot, 'revision.json'), 'utf8'))
const observationSchema = JSON.parse(await fs.readFile(path.join(benchmarkRoot, 'observation.schema.json'), 'utf8'))
const observationValidator = new Ajv({ allErrors: true, strict: true }).compile(observationSchema)
const SEMANTIC_MANIFEST_SCHEMA = 'tokenless.terminalbench-semantic-manifest.v1'
const SEMANTIC_TASK_TYPE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u
const SEMANTIC_COMPLEXITIES = new Set(['low', 'medium', 'high'])
const JOB_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const RUN_SCHEMA = 'tokenless.terminalbench-run.v2'
const START_SNAPSHOT_SCHEMA = 'tokenless.terminalbench-start-snapshot.v1'
const OBSERVATION_SCHEMA = 'tokenless.terminalbench-observation.v2'
const OBSERVATION_EXECUTION_PATH = 'Harbor -> Docker DeepSeek Harness -> loopback HTTP -> Tokenless API -> tokenless/auto -> provider'
const ORACLE_OBSERVATION_EXECUTION_PATH = 'Harbor -> Oracle agent'
const START_SNAPSHOT_FILE = 'start-snapshot.json'
const PRIVATE_EVIDENCE_PATTERN = /(?:^|\/)(?:\.env(?:\.|$)|.*(?:cookie|credential|secret|authorization|session-values|raw-provider).*|provider-turn(?:\/|$))/iu
const SAFE_METADATA_VALUE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/+\-]{0,159}$/u
const PROVIDER_MODEL_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SOURCE_EVIDENCE_FILES = [
  'benchmarks/terminalbench/run.mjs',
  'benchmarks/terminalbench/observation.schema.json',
  'benchmarks/terminalbench/dsh_tokenless_agent.py',
  'benchmarks/terminalbench/channel_proxy.py',
  'benchmarks/terminalbench/provider_response_metadata.mjs',
  'packages/harness/src/http/bootstrap.ts',
  'packages/harness/dist/src/http/bootstrap.js',
  'benchmarks/terminalbench/revision.json',
  'packages/cli/dist/server/src/browser/runner-service.js',
  'packages/cli/dist/server/src/universal-api/api-proxy.js',
  'packages/cli/dist/server/src/http/server.js',
  'packages/cli/dist/src/tokenless.mjs',
]
const [command = 'help', ...argv] = process.argv.slice(2)

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
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
    } else if (command === 'observe') {
      output({ ok: true, observation: await observeExistingJob(argv) })
    } else if (command === 'wiring' || command === 'sweep' || command === 'full') {
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
  const jobsDir = await jobsDirectory(args)
  const task = option(args, '--task') ?? revision.wiringTask
  const jobName = resolveJobName(args, 'oracle')
  const jobDir = path.join(jobsDir, jobName)
  await refuseExisting(jobDir)
  await fs.mkdir(jobsDir, { recursive: true })
  await fs.mkdir(jobDir, { recursive: true })
  await captureRunStartSnapshot({
    jobDir,
    kind: 'oracle',
    task,
    taskManifest: path.resolve(root, revision.taskManifest),
    semanticManifest: null,
    runtimeArchive: null,
    tokenlessHome: null,
    profile: null,
    daemonUrl: null,
  })
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
  ], { cwd: root, allowFailure: true, env: harborEnvironment() })
  const report = await writeRunReport({
    jobDir,
    kind: 'oracle',
    profile: null,
    task,
    attemptsPerTask: 1,
    expectedTrials: 1,
  })
  await writeRunObservation({ jobDir, report })
  if (result.code !== 0) throw new Error(`Harbor oracle exited ${result.code}; evidence is preserved at ${jobDir}.`)
  assertComplete(report, 1)
  return report
}

async function runDeepSeekLane(kind, args) {
  const jobsDir = await jobsDirectory(args)
  const jobName = resolveJobName(args, kind)
  const homeDir = path.resolve(requiredOption(args, '--home'))
  const profile = requiredOption(args, '--profile')
  const semanticManifest = await validateSemanticManifest(path.resolve(requiredOption(args, '--semantic-manifest')))
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(profile)) throw new Error('--profile is invalid.')
  if ((kind === 'full' || kind === 'sweep') && option(args, '--task') !== undefined) {
    throw new Error(`The ${kind} command always runs the unchanged ${revision.taskCount}-task dataset.`)
  }
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
  const jobDir = path.join(jobsDir, jobName)
  await refuseExisting(jobDir)
  await fs.mkdir(jobsDir, { recursive: true })
  await fs.mkdir(jobDir, { recursive: true })
  const attemptsPerTask = kind === 'full' ? revision.attemptsPerTask : 1
  const expectedTrials = kind === 'wiring' ? attemptsPerTask : revision.taskCount * attemptsPerTask
  const tokenEstimatorScript = path.join(benchmarkRoot, 'token_estimator.mjs')
  await captureRunStartSnapshot({
    jobDir,
    kind,
    task,
    taskManifest: prepared.taskManifest,
    semanticManifest: semanticManifest.path,
    runtimeArchive: prepared.runtimeArchive,
    tokenlessHome: homeDir,
    profile,
    daemonUrl: daemon.url,
  })

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
    '--ak', `token_estimator_script=${tokenEstimatorScript}`,
    '--ak', `token_estimator_node=${process.execPath}`,
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
    tokenEstimatorScript,
    tokenEstimatorNode: process.execPath,
    tokenlessHome: homeDir,
    daemonUrl: daemon.url,
    executionMode: daemon.executionMode,
    taskManifest: prepared.taskManifest,
    semanticManifest,
  })
  await writeRunObservation({ jobDir, report })
  if (result.code !== 0) throw new Error(`Harbor ${kind} run exited ${result.code}; evidence is preserved at ${jobDir}.`)
  assertComplete(report, expectedTrials)
  if (
    kind === 'sweep'
    && report.deepIntegration.trialsWithCompleteChain !== expectedTrials
  ) {
    throw new Error(`The Terminal-Bench sweep phase gate requires complete host-observed DSH parent -> child Tokenless Harness provider-turn evidence for every trial; evidence is preserved at ${jobDir}.`)
  }
  if (
    kind === 'sweep'
    && (
      report.deepIntegration.successfulDshParents !== expectedTrials
      || report.deepIntegration.failedDshParents !== 0
      || report.deepIntegration.unsettledParentCompletionRequests !== 0
      || report.deepIntegration.forcedParentCompletionRequests !== expectedTrials
    )
  ) {
    throw new Error(`The Terminal-Bench sweep phase gate requires one successful DSH parent completion, one forced subagent request, and one terminal parent routing event per trial; evidence is preserved at ${jobDir}.`)
  }
  if (kind === 'sweep' && report.rewards.passed !== expectedTrials) {
    throw new Error(`The Terminal-Bench sweep phase gate requires verifier reward 1 for all ${expectedTrials} trials; evidence is preserved at ${jobDir}.`)
  }
  return report
}

async function ensureHostDaemon(homeDir, explicitDaemonUrl) {
  const runtimeEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'index.js')
  const runtime = await import(pathToFileURL(runtimeEntry).href)
  const config = await runtime.readTokenlessConfig(homeDir)
  if (config?.apiProxy?.executionMode !== 'browser') {
    throw new Error('The DeepSeek Harness lane requires browser execution mode in the selected Tokenless API home.')
  }
  const daemonUrl = runtime.daemonUrl(explicitDaemonUrl ?? config.daemonUrl ?? undefined)
  const ready = await runtime.probeDaemonReady({ homeDir, daemonUrl, timeoutMs: 10_000 })
  const daemon = ready.ok ? ready : await runtime.ensureDaemonReady({
    homeDir,
    daemonUrl,
  })
  return { ...daemon, executionMode: config.apiProxy.executionMode }
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
  tokenEstimatorScript,
  tokenEstimatorNode,
  tokenlessHome,
  daemonUrl,
  taskManifest,
  semanticManifest = null,
  executionMode = null,
}) {
  const destination = path.join(jobDir, 'tokenless-run.json')
  await refuseExisting(destination)
  const official = await readJson(path.join(jobDir, 'result.json'))
  const jobConfig = await readJson(path.join(jobDir, 'config.json'))
  const startSnapshot = await readJson(path.join(jobDir, START_SNAPSHOT_FILE))
  validateStartSnapshot(startSnapshot)
  const trialDirectories = (await fs.readdir(jobDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(jobDir, entry.name))
    .filter(async (directory) => exists(path.join(directory, 'result.json')))
  const trialResults = []
  const verifierTests = []
  const deepTrials = []
  const preRoutingExceptions = []
  for (const directory of trialDirectories) {
    if (!await exists(path.join(directory, 'result.json'))) continue
    const trialResult = await readJson(path.join(directory, 'result.json'))
    trialResults.push(trialResult)
    verifierTests.push({ trial: trialResult.trial_name, ...await readVerifierTests(directory) })
    const auditPath = path.join(directory, 'agent', 'deep-integration.jsonl')
    if (!await exists(auditPath)) {
      if (kind !== 'oracle') {
        preRoutingExceptions.push(preRoutingException(trialResult, directory))
      }
      continue
    }
    const auditEvents = []
    for (const line of (await fs.readFile(auditPath, 'utf8')).split(/\r?\n/u)) {
      if (!line.trim()) continue
      const event = JSON.parse(line)
      if (event.protocol !== revision.auditProtocol) throw new Error(`Unexpected deep-integration audit protocol in ${auditPath}.`)
      auditEvents.push(event)
    }
    deepTrials.push({
      ...deepIntegrationStats(auditEvents, path.basename(directory)),
      events: auditEvents,
    })
  }
  if (kind !== 'oracle' && deepTrials.length + preRoutingExceptions.length !== expectedTrials) {
    throw new Error(`Expected observer or pre-routing exception evidence for ${expectedTrials} non-oracle trials, found ${deepTrials.length + preRoutingExceptions.length}.`)
  }
  const taskManifestIdentity = await validateTaskManifest(taskManifest)
  validateResolvedRun({
    official,
    jobConfig,
    trialResults,
    deepTrials,
    preRoutingExceptions,
    kind,
    task,
    attemptsPerTask,
    expectedTrials,
    runtimeArchive,
    proxyScript,
    tokenEstimatorScript,
    tokenEstimatorNode,
    tokenlessHome,
    daemonUrl,
    profile,
    taskManifest,
    taskManifestIdentity,
    semanticManifest,
  })
  const rewards = trialResults
    .map((trial) => trial?.verifier_result?.rewards?.reward)
    .filter((reward) => typeof reward === 'number' && Number.isFinite(reward))
  const providerRouting = aggregateProviderRouting(deepTrials)
  const routedProviders = new Set(Object.values(providerRouting.scopes)
    .flatMap((scope) => Object.entries(scope.providers))
    .filter(([, counts]) => counts.attempted > 0)
    .map(([provider]) => provider))
  const accountPlans = kind === 'oracle'
    ? { availability: 'not_applicable', reason: 'oracle-run', capturedAt: null, providers: {} }
    : await benchmarkProviderPlanSnapshot({
        tokenlessHome,
        daemonUrl,
        profile,
        routedProviders,
      })
  const stats = official.stats
  const endRepository = await captureRepositorySnapshot()
  const resolvedExecutionEvidence = buildResolvedExecutionEvidence({
    jobConfig,
    trialResults,
    taskPackage: startSnapshot.pinned.taskPackage,
    startSnapshot,
  })
  const executionEvidence = {
    start: startSnapshot,
    end: endRepository,
    resolved: resolvedExecutionEvidence,
  }
  const trace = buildTraceEvidence(deepTrials)
  const completeness = buildCompletenessEvidence({
    kind,
    deepTrials,
    trialResults,
    trace,
    accountPlans,
  })
  const comparability = buildComparabilityEvidence({
    kind,
    deepTrials,
    trace,
  })
  const report = {
    schema: RUN_SCHEMA,
    benchmark: revision.benchmark,
    harborVersion: revision.harborVersion,
    dataset: revision.dataset,
    datasetRef: revision.datasetRef,
    taskCount: kind === 'oracle' || kind === 'wiring' ? 1 : revision.taskCount,
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
    verifierTests,
    agent: kind === 'oracle' ? 'oracle' : 'deepseek-harness-tokenless-deep',
    model: kind === 'oracle' ? null : revision.model,
    routingMode: kind === 'oracle' ? null : 'auto',
    executionMode,
    profile,
    deepseekHarnessRevision: revision.deepseekHarnessRevision,
    tokenlessRevision: startSnapshot.source.repository.head,
    tokenlessWorktreeDirty: startSnapshot.source.repository.dirty,
    source: {
      start: startSnapshot.source,
      end: endRepository,
    },
    executionEvidence,
    completeness,
    comparability,
    deepIntegration: aggregateDeepIntegration(deepTrials),
    preRoutingExceptions: {
      count: preRoutingExceptions.length,
      trials: preRoutingExceptions,
    },
    providerRouting: {
      ...providerRouting,
      accountPlans,
    },
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

async function captureRunStartSnapshot({
  jobDir,
  kind,
  task,
  taskManifest,
  semanticManifest,
  runtimeArchive,
  tokenlessHome,
  profile,
  daemonUrl,
}) {
  const source = await captureSourceSnapshot({ semanticManifest })
  const config = await captureTokenlessConfigSnapshot(tokenlessHome, profile)
  const taskManifestEvidence = await optionalFileEvidence(taskManifest, 'task manifest')
  const semanticManifestEvidence = semanticManifest === null
    ? null
    : await optionalFileEvidence(semanticManifest, 'semantic manifest')
  const runtime = runtimeArchive === null
    ? { availability: 'not_applicable', path: null, sha256: null, bytes: null }
    : await optionalFileEvidence(runtimeArchive, 'runtime archive')
  const taskRef = task === null || task === undefined
    ? null
    : (await validateTaskManifest(taskManifest)).taskRefs[task.replace(/^terminal-bench\//u, '')] ?? null
  const taskPackage = await findTaskPackageMetadata(task, taskRef)
  const snapshot = {
    schema: START_SNAPSHOT_SCHEMA,
    capturedAt: new Date().toISOString(),
    kind,
    task: task ?? null,
    profile: profile ?? null,
    daemonOrigin: safeLoopbackOrigin(daemonUrl),
    host: {
      platform: process.platform,
      architecture: process.arch,
      nodeVersion: process.version,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      utcOffsetMinutes: -new Date().getTimezoneOffset(),
      harborTimeZone: 'UTC',
    },
    source,
    pinned: {
      benchmark: revision.benchmark,
      dataset: revision.dataset,
      datasetRef: revision.datasetRef,
      datasetVersion: revision.datasetVersion,
      instructionDigest: revision.instructionDigest,
      taskRefDigest: revision.taskRefDigest,
      harborVersion: revision.harborVersion,
      deepseekHarnessRevision: revision.deepseekHarnessRevision,
      runtimeImage: revision.runtimeImage,
      runtimePlatform: revision.runtimePlatform,
      taskRef,
      taskPackage,
    },
    artifacts: {
      runtimeArchive: runtime,
      taskManifest: taskManifestEvidence,
      semanticManifest: semanticManifestEvidence,
    },
    tokenless: config,
  }
  await fs.writeFile(
    path.join(jobDir, START_SNAPSHOT_FILE),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  return snapshot
}

async function captureSourceSnapshot({ semanticManifest }) {
  const files = []
  for (const relative of SOURCE_EVIDENCE_FILES) {
    files.push(await optionalFileEvidence(path.join(root, relative), `source file ${relative}`))
  }
  if (semanticManifest !== null) {
    files.push(await optionalFileEvidence(semanticManifest, 'semantic manifest source'))
  }
  const repository = await captureRepositorySnapshot()
  return {
    capturedAt: new Date().toISOString(),
    repository,
    files,
  }
}

async function captureRepositorySnapshot() {
  const [head, status, unstagedDiff, stagedDiff, untracked] = await Promise.all([
    capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
    capture('git', ['status', '--porcelain=v1', '-z'], { cwd: root }),
    capture('git', ['diff', '--no-ext-diff', '--binary'], { cwd: root }),
    capture('git', ['diff', '--cached', '--no-ext-diff', '--binary'], { cwd: root }),
    capture('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: root }),
  ])
  const statusBytes = Buffer.byteLength(status)
  return {
    head: head.trim(),
    dirty: statusBytes > 0,
    statusEntries: splitNullEntries(status).length,
    statusSha256: sha256Value(status),
    statusBytes,
    unstagedDiffSha256: sha256Value(unstagedDiff),
    unstagedDiffBytes: Buffer.byteLength(unstagedDiff),
    stagedDiffSha256: sha256Value(stagedDiff),
    stagedDiffBytes: Buffer.byteLength(stagedDiff),
    untrackedSha256: sha256Value(untracked),
    untrackedBytes: Buffer.byteLength(untracked),
  }
}

async function captureTokenlessConfigSnapshot(tokenlessHome, profile) {
  if (tokenlessHome === null || tokenlessHome === undefined) {
    return {
      availability: 'not_applicable',
      reason: 'oracle-run',
      sanitizedSha256: null,
      bytes: null,
      redactedFields: 0,
      router: null,
      executionMode: null,
    }
  }
  const configPath = path.join(tokenlessHome, 'config.json')
  try {
    const bytes = await fs.readFile(configPath)
    const raw = JSON.parse(bytes.toString('utf8'))
    const redaction = { count: 0 }
    const sanitized = sanitizeConfigValue(raw, redaction)
    const selectedProfile = profile !== null && profile !== undefined
      ? raw?.profiles?.[profile]
      : raw?.defaultProfile && raw?.profiles?.[raw.defaultProfile]
    const selectedProfileName = profile ?? (typeof raw?.defaultProfile === 'string' ? raw.defaultProfile : null)
    return {
      availability: 'observed',
      reason: null,
      sanitizedSha256: sha256Value(canonicalJson(sanitized)),
      bytes: bytes.byteLength,
      redactedFields: redaction.count,
      executionMode: typeof raw?.apiProxy?.executionMode === 'string' ? raw.apiProxy.executionMode : null,
      router: safeRouterMetadata(raw?.router),
      browser: typeof raw?.browser === 'string' ? raw.browser : null,
      browserVisibility: typeof raw?.browserVisibility === 'string' ? raw.browserVisibility : null,
      profileRegistry: { source: 'config.json.profiles', selected: selectedProfileName },
      profileRuntime: safeProfileRuntime(selectedProfile?.runtimeBinding)
        ? { availability: 'observed', ...safeProfileRuntime(selectedProfile.runtimeBinding) }
        : { availability: 'unavailable', reason: selectedProfile ? 'profile_runtime_binding_missing' : 'selected_profile_not_found' },
    }
  } catch (error) {
    return {
      availability: 'unavailable',
      reason: safeErrorCode(error, 'config_unavailable'),
      sanitizedSha256: null,
      bytes: null,
      redactedFields: 0,
      router: null,
      executionMode: null,
    }
  }
}

function sanitizeConfigValue(value, redaction) {
  if (Array.isArray(value)) return value.map((entry) => sanitizeConfigValue(entry, redaction))
  if (!value || typeof value !== 'object') return value
  const result = {}
  for (const [key, entry] of Object.entries(value)) {
    if (/(?:token|secret|password|cookie|credential|authorization|session|private[_-]?key)/iu.test(key)) {
      result[key] = '[redacted]'
      redaction.count += 1
    } else {
      result[key] = sanitizeConfigValue(entry, redaction)
    }
  }
  return result
}

function safeRouterMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const providers = Array.isArray(value.providers)
    ? value.providers
      .filter((provider) => provider && typeof provider === 'object' && typeof provider.id === 'string')
      .map((provider) => ({
        id: provider.id,
        suitableTasksSha256: typeof provider.suitableTasks === 'string' ? sha256Value(provider.suitableTasks) : null,
        suitableTasksCharacters: typeof provider.suitableTasks === 'string' ? provider.suitableTasks.length : null,
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
    : []
  return {
    enabled: value.enabled === true,
    engine: typeof value.engine === 'string' ? value.engine : null,
    providers,
  }
}

function safeProfileRuntime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    runtimeId: typeof value.runtimeId === 'string' ? value.runtimeId : null,
    family: typeof value.family === 'string' ? value.family : null,
    browserId: typeof value.browserId === 'string' ? value.browserId : null,
    profileFormat: Number.isSafeInteger(value.profileFormat) ? value.profileFormat : null,
  }
}

async function findTaskPackageMetadata(task, taskRef) {
  if (typeof task !== 'string' || taskRef === null) {
    return { availability: 'unavailable', reason: 'task_package_identity_unavailable', task: task ?? null, taskRef }
  }
  const taskName = task.replace(/^terminal-bench\//u, '')
  const cacheRoot = process.env.HARBOR_CACHE_DIR ?? path.join(os.homedir(), '.cache', 'harbor')
  const base = path.join(cacheRoot, 'tasks', 'packages', 'terminal-bench', taskName)
  let entries
  try {
    entries = await fs.readdir(base, { withFileTypes: true })
  } catch (error) {
    return { availability: 'unavailable', reason: safeErrorCode(error, 'task_package_cache_unavailable'), task: taskName, taskRef }
  }
  const refHex = taskRef.replace(/^sha256:/u, '')
  const candidate = entries
    .filter((entry) => entry.isDirectory() && entry.name === refHex)
    .map((entry) => path.join(base, entry.name, 'task.toml'))[0]
  if (!candidate || !await exists(candidate)) {
    return { availability: 'unavailable', reason: 'task_package_ref_not_cached', task: taskName, taskRef }
  }
  try {
    const toml = await fs.readFile(candidate, 'utf8')
    return {
      availability: 'observed',
      task: taskName,
      taskRef,
      taskTomlSha256: sha256Value(toml),
      images: [...toml.matchAll(/docker_image\s*=\s*"([^"]+)"/gu)].map((match) => match[1]),
      resources: [...toml.matchAll(/(?:cpus|memory_mb|storage_mb)\s*=\s*([^\s#]+)/gu)].map((match) => match[0]),
      network: [...toml.matchAll(/extra_allowed_hosts\s*=\s*(\[[^\n]*\])/gu)].map((match) => match[1]),
    }
  } catch (error) {
    return { availability: 'unavailable', reason: safeErrorCode(error, 'task_package_read_failed'), task: taskName, taskRef }
  }
}

function validateStartSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || snapshot.schema !== START_SNAPSHOT_SCHEMA
    || typeof snapshot.capturedAt !== 'string'
    || !snapshot.source?.repository?.head
    || !snapshot.pinned?.datasetRef
    || !snapshot.artifacts?.runtimeArchive) {
    throw new Error('The run start snapshot is missing required execution identity evidence.')
  }
}

function buildResolvedExecutionEvidence({ jobConfig, trialResults, taskPackage, startSnapshot }) {
  const agent = Array.isArray(jobConfig?.agents) ? jobConfig.agents[0] : null
  const dataset = Array.isArray(jobConfig?.datasets) ? jobConfig.datasets[0] : null
  const trials = trialResults.map((trial) => {
    const environment = trial?.config?.environment ?? {}
    const verifier = trial?.config?.verifier ?? {}
    return {
      trial: trial.trial_name,
      task: trial.task_name,
      taskRef: trial.task_id?.ref ?? null,
      environment: {
        type: environment.type ?? null,
        extraAllowedHosts: sortedStrings(environment.extra_allowed_hosts),
        resources: pickResourceLimits(environment),
      },
      verifier: {
        environmentMode: trial.verifier_environment_mode ?? null,
        resources: pickResourceLimits(verifier),
      },
    }
  }).sort((left, right) => left.trial.localeCompare(right.trial))
  return {
    schema: 'tokenless.terminalbench-execution-evidence.v1',
    capturedAt: new Date().toISOString(),
    harbor: {
      concurrency: Number.isSafeInteger(jobConfig?.n_concurrent_trials) ? jobConfig.n_concurrent_trials : null,
      attempts: Number.isSafeInteger(jobConfig?.n_attempts) ? jobConfig.n_attempts : null,
      maxRetries: Number.isSafeInteger(jobConfig?.retry?.max_retries) ? jobConfig.retry.max_retries : null,
      dataset: dataset ? { name: dataset.name ?? null, ref: dataset.ref ?? null, taskCount: Array.isArray(dataset.task_names) ? dataset.task_names.length : null } : null,
    },
    agent: {
      name: agent?.name ?? null,
      requestedModel: agent?.model_name ?? null,
      allowedHosts: sortedStrings(agent?.extra_allowed_hosts),
      kwargsKeys: agent?.kwargs && typeof agent.kwargs === 'object' ? Object.keys(agent.kwargs).sort() : [],
    },
    taskPackage,
    trials,
    runtimeArchive: startSnapshot.artifacts.runtimeArchive,
  }
}

function pickResourceLimits(value) {
  return {
    cpus: value?.cpus ?? value?.override_cpus ?? null,
    memoryMb: value?.memory_mb ?? value?.override_memory_mb ?? null,
    storageMb: value?.storage_mb ?? value?.override_storage_mb ?? null,
    gpus: value?.gpus ?? value?.override_gpus ?? null,
    tpu: value?.tpu ?? value?.override_tpu ?? null,
  }
}

function buildTraceEvidence(deepTrials) {
  const steps = []
  for (const trial of deepTrials) {
    for (const event of trial.events ?? []) {
      steps.push(projectTraceStep(event, trial.trial))
    }
  }
  steps.sort((left, right) => left.trial.localeCompare(right.trial) || left.sequence - right.sequence)
  return {
    protocol: revision.auditProtocol,
    steps,
    snapshot: {
      availability: steps.length > 0 ? 'available' : 'unavailable',
      reason: steps.length > 0 ? null : 'no-audit-events',
    },
  }
}

function projectTraceStep(event, trial) {
  const type = typeof event?.type === 'string' ? event.type : 'unknown'
  const scope = event?.scope === 'parent' || event?.scope === 'child' ? event.scope : null
  const providerEvidence = type === 'provider.routing'
    ? normalizeProviderEvidence(event.executionMetadata, event.provider)
    : null
  if (providerEvidence) providerEvidence.expectedSubmissions = (event.providerSubmitted ? 1 : 0)
    + (event.attempts ?? []).filter((attempt) => attempt.providerSubmitted).length
  const action = type === 'api.completion.request'
    ? 'completion_request'
    : type === 'child.turn.started'
      ? 'child_turn_start'
      : type === 'provider.routing'
      ? 'provider_route'
      : type === 'provider.attachment'
          ? 'attachment_upload'
          : type === 'dsh.parent.completed'
          ? 'parent_completion'
          : 'audit_event'
  return {
    trial,
    sequence: Number.isSafeInteger(event?.sequence) ? event.sequence : 0,
    type,
    scope,
    action,
    tool: typeof event?.requestedTool === 'string' ? event.requestedTool : null,
    tools: Array.isArray(event?.tools) ? projectTools(event.tools) : [],
    toolResponseStatus: event.toolResponseStatus ?? null,
    toolResponseNormalizationApplied: event.toolResponseNormalizationApplied ?? null,
    attachments: type === 'provider.attachment'
      ? [projectAttachment(event)]
      : (event.attachments ?? []).map(projectAttachment),
    provider: typeof event?.provider === 'string' ? event.provider : null,
    outcome: typeof event?.outcome === 'string' ? event.outcome : null,
    providerSubmitted: typeof event?.providerSubmitted === 'boolean' ? event.providerSubmitted : null,
    timing: traceTiming(event),
    providerEvidence,
    links: traceLinks(event),
  }
}

function projectTools(value) {
  return value
    .filter((tool) => tool && typeof tool === 'object' && !Array.isArray(tool))
    .map((tool) => ({
      callId: typeof tool.callId === 'string' ? tool.callId : null,
      toolName: typeof tool.toolName === 'string' ? tool.toolName : null,
      interactionId: typeof tool.interactionId === 'string' ? tool.interactionId : null,
      requested: typeof tool.requested === 'boolean' ? tool.requested : null,
      returned: typeof tool.returned === 'boolean' ? tool.returned : null,
      executed: typeof tool.executed === 'boolean' ? tool.executed : null,
      outcome: typeof tool.outcome === 'string' ? tool.outcome : 'unknown',
      exitCode: Number.isSafeInteger(tool.exitCode) ? tool.exitCode : null,
      arguments: digestObservation(tool.arguments),
      result: digestObservation(tool.result),
      returnedAt: tool.returnedAt ?? null,
      resultObservedAt: tool.resultObservedAt ?? null,
    }))
}

function projectAttachment(value) {
  const keys = ['stage', 'stored', 'attachmentRef', 'name', 'mediaType', 'byteLength', 'sha256',
    'declaredByteLength', 'declaredSha256', 'upload', 'providerUpload', 'outcome', 'unknownReason',
    'startedAt', 'finishedAt', 'durationMs']
  return {
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    sha256: `sha256:${value.sha256}`,
    declaredSha256: value.declaredSha256 === null ? null : `sha256:${value.declaredSha256}`,
  }
}

function digestObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { availability: 'unknown', sha256: null, bytes: null, characters: null, reason: 'not_observed' }
  }
  return {
    availability: value.availability === 'observed' ? 'observed' : 'unknown',
    sha256: typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256) ? `sha256:${value.sha256}` : null,
    bytes: Number.isSafeInteger(value.bytes) ? value.bytes : null,
    characters: Number.isSafeInteger(value.characters) ? value.characters : null,
    reason: typeof value.reason === 'string' ? value.reason : null,
  }
}

function traceTiming(event) {
  if (typeof event?.startedAt !== 'string' || typeof event?.finishedAt !== 'string' || !Number.isSafeInteger(event?.durationMs) || event.durationMs < 0) return null
  return {
    startedAt: event.startedAt,
    finishedAt: event.finishedAt,
    durationMs: event.durationMs,
    precision: 'interval',
  }
}

function traceLinks(event) {
  const links = []
  for (const [type, value] of [
    ['interaction', event?.interactionId],
    ['request', event?.requestRef],
    ['turn', event?.turnRef],
    ['conversation', event?.conversationRef],
  ]) {
    if (typeof value === 'string') links.push({ type, ref: value })
  }
  if (Number.isSafeInteger(event?.requestSequence)) links.push({ type: 'request', sequence: event.requestSequence })
  if (Number.isSafeInteger(event?.parentSequence)) links.push({ type: 'parent', sequence: event.parentSequence })
  if (Number.isSafeInteger(event?.toolSequence)) links.push({ type: 'tool', sequence: event.toolSequence })
  if (typeof event?.transportRef === 'string') links.push({ type: 'transport', ref: event.transportRef })
  return links
}

function normalizeProviderEvidence(value, provider) {
  const evidence = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const modelValue = evidence?.model && typeof evidence.model === 'object' ? evidence.model : {}
  const effortValue = evidence?.reasoningEffort && typeof evidence.reasoningEffort === 'object' ? evidence.reasoningEffort : {}
  const surfaceValue = evidence?.surface && typeof evidence.surface === 'object' ? evidence.surface.observed ?? {} : {}
  // Keep provider submission observation time separate from the route event's
  // completion time. The adapter may provide the former; a missing value stays
  // explicitly unavailable instead of being replaced with event.observedAt.
  const observedTimestamp = typeof evidence?.observedAt === 'string' ? evidence.observedAt : null
  const model = modelValue.observed?.availability === 'observed' && typeof modelValue.observed.value === 'string' ? modelValue.observed.value : null
  const effort = effortValue.observed?.availability === 'observed' && typeof effortValue.observed.value === 'string' ? effortValue.observed.value : null
  const requestedModel = modelValue.requested?.availability === 'observed' && typeof modelValue.requested.value === 'string' ? modelValue.requested.value : null
  const requestedEffort = effortValue.requested?.availability === 'observed' && typeof effortValue.requested.value === 'string' ? effortValue.requested.value : null
  const unknownReasons = [
    ...(model === null ? [modelValue.observed?.reason ?? 'observed_model_unavailable'] : []),
    ...(effort === null ? [effortValue.observed?.reason ?? 'observed_reasoning_effort_unavailable'] : []),
    ...(surfaceValue.value === undefined ? [surfaceValue.reason ?? 'observed_surface_unavailable'] : []),
    ...(observedTimestamp === null ? ['provider_submission_observed_at_unavailable'] : []),
  ].filter((reason) => typeof reason === 'string').slice(0, 16)
  return {
    availability: evidence === null ? 'unavailable' : 'observed',
    provider: provider ?? null,
    requested: {
      model: requestedModel,
      effort: requestedEffort,
    },
    observed: { model, effort },
    surface: surfaceValue.value === 'chat' || surfaceValue.value === 'work' || surfaceValue.value === 'unknown' ? surfaceValue.value : null,
    observedAt: observedTimestamp,
    jobIds: Array.isArray(evidence?.jobIds) ? [...evidence.jobIds] : [],
    jobs: Array.isArray(evidence?.jobs) ? evidence.jobs.map((job) => ({ ...job })) : [],
    submissions: Array.isArray(evidence?.submissions)
      ? evidence.submissions.map(projectProviderSubmission)
      : [],
    unknownReasons: [...new Set(unknownReasons.length > 0 ? unknownReasons : (evidence === null ? ['provider_execution_metadata_missing'] : []))],
  }
}

function projectProviderSubmission(value) {
  return {
    jobId: value.jobId,
    provider: value.provider ?? null,
    action: value.action,
    metadata: { ...value.metadata },
    submissionObservation: {
      protocol: value.submissionObservation.protocol ?? null,
      observedAt: value.submissionObservation.observedAt ?? null,
      source: value.submissionObservation.source ?? null,
      page: {
        surface: value.submissionObservation.page.surface,
        origin: value.submissionObservation.page.origin ?? null,
      },
      model: { ...value.submissionObservation.model },
      effort: { ...value.submissionObservation.effort },
    },
    responseModel: projectProviderResponseModel(value.responseModel),
  }
}

function projectProviderResponseModel(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!validateProviderResponseModel(value)) return null
  return {
    providerModelId: typeof value.providerModelId === 'string' ? value.providerModelId : null,
    status: value.status === 'observed' ? 'observed' : 'unknown',
    source: value.source,
    observedAt: value.observedAt,
    reason: typeof value.reason === 'string' ? value.reason : null,
  }
}

function buildComparabilityEvidence({ kind, deepTrials, trace }) {
  if (kind === 'oracle') {
    return {
      status: 'not_comparable',
      officialRewardIndependent: true,
      model: { status: 'not_applicable', observed: null, unknownReasons: ['oracle-run'] },
      effort: { status: 'not_applicable', observed: null, unknownReasons: ['oracle-run'] },
      reasons: ['oracle-run'],
    }
  }
  const submittedSteps = trace.steps.filter((step) => step.type === 'provider.routing' && (
    step.providerSubmitted === true
    || (step.providerEvidence?.expectedSubmissions ?? 0) > 0
    || (step.providerEvidence?.submissions.length ?? 0) > 0
    || step.tools.some((tool) => tool.requested === true)
  ))
  const records = submittedSteps.flatMap(providerSubmissionRecords)
  const models = records.map((record) => providerSubmissionLabel(record, 'model')).filter((value) => typeof value === 'string')
  const efforts = records.map((record) => providerSubmissionLabel(record, 'effort')).filter((value) => typeof value === 'string')
  const modelReasons = [...new Set(records.flatMap((record) => providerSubmissionReasons(record, 'model')))]
  const effortReasons = [...new Set(records.flatMap((record) => providerSubmissionReasons(record, 'effort')))]
  const exactModels = models.filter(isExactProviderLabel)
  const exactEfforts = efforts.filter(isExactProviderLabel)
  const completeCoverage = submittedSteps.length > 0 && submittedSteps.every(submissionCoverageComplete)
  const everyModelObserved = completeCoverage && records.length > 0 && records.every((record) => isExactProviderLabel(providerSubmissionLabel(record, 'model')))
  const everyEffortObserved = completeCoverage && records.length > 0 && records.every((record) => isExactProviderLabel(providerSubmissionLabel(record, 'effort')))
  const modelStatus = everyModelObserved && new Set(exactModels).size === 1 ? 'known' : 'unknown'
  const effortStatus = everyEffortObserved && new Set(exactEfforts).size === 1 ? 'known' : 'unknown'
  if (new Set(exactModels).size > 1) modelReasons.push('multiple_models_observed')
  if (new Set(exactEfforts).size > 1) effortReasons.push('multiple_reasoning_efforts_observed')
  if (submittedSteps.length === 0) {
    modelReasons.push('no_submitted_provider_interactions')
    effortReasons.push('no_submitted_provider_interactions')
  }
  if (models.some((value) => !isExactProviderLabel(value))) modelReasons.push('model_alias_unresolved')
  if (efforts.some((value) => !isExactProviderLabel(value))) effortReasons.push('reasoning_effort_alias_unresolved')
  const reasons = [...new Set([...modelReasons, ...effortReasons])]
  if (!completeCoverage) reasons.push('provider_submission_coverage_incomplete')
  return {
    status: modelStatus === 'known' && effortStatus === 'known' ? 'comparable' : 'not_comparable',
    officialRewardIndependent: true,
    model: { status: modelStatus, observed: new Set(exactModels).size === 1 ? [...new Set(exactModels)][0] : null, unknownReasons: modelStatus === 'known' ? [] : (modelReasons.length > 0 ? [...new Set(modelReasons)] : ['model_not_observed']) },
    effort: { status: effortStatus, observed: new Set(exactEfforts).size === 1 ? [...new Set(exactEfforts)][0] : null, unknownReasons: effortStatus === 'known' ? [] : (effortReasons.length > 0 ? [...new Set(effortReasons)] : ['effort_not_observed']) },
    reasons,
  }
}

function isExactProviderLabel(value) {
  return typeof value === 'string'
    && value.length > 0
    && !/^(?:latest|auto|default|unknown|tokenless\/auto)$/iu.test(value)
}

function providerSubmissionRecords(step) {
  return step.providerEvidence?.submissions ?? []
}

function submissionCoverageComplete(step) {
  const evidence = step.providerEvidence
  if (!evidence || evidence.jobIds.length === 0 || evidence.jobs.length !== evidence.jobIds.length) return false
  if (evidence.submissions.length < evidence.expectedSubmissions) return false
  return evidence.jobIds.every((jobId) => {
    const job = evidence.jobs.find((entry) => entry.jobId === jobId)
    const submissions = evidence.submissions.filter((entry) => entry.jobId === jobId)
    return job?.availability === 'observed'
      && typeof job.providerSubmitted === 'boolean'
      && job.submissionCount === submissions.length
      && (!job.providerSubmitted || submissions.length > 0)
      && submissions.every((entry) => entry.submissionObservation.observedAt !== null
        && entry.submissionObservation.source !== null
        && Number.isSafeInteger(entry.metadata.actionIndex))
  }) && evidence.submissions.every((entry) => evidence.jobIds.includes(entry.jobId))
}

export function providerSubmissionLabel(record, field) {
  const choice = record?.submissionObservation?.[field === 'effort' ? 'effort' : 'model']
  const label = typeof choice?.observedLabel === 'string' ? choice.observedLabel : null
  // Current user-confirmed ChatGPT mapping; retain the original label and DOM slug in the evidence.
  if (field === 'model' && record?.provider === 'chatgpt' && label === 'Latest') return 'GPT-6 / Latest'
  return label
}

function providerSubmissionReasons(record, field) {
  const label = providerSubmissionLabel(record, field)
  if (label !== null) {
    return isExactProviderLabel(label)
      ? []
      : [field === 'model' ? 'model_alias_unresolved' : 'reasoning_effort_alias_unresolved']
  }
  const choice = record?.submissionObservation?.[field === 'effort' ? 'effort' : 'model']
  const rawReason = typeof choice?.reason === 'string' ? choice.reason : null
  if (rawReason !== null) return [rawReason]
  return [field === 'model' ? 'model_not_observed' : 'effort_not_observed']
}

function metadataFieldCoverage(routeSteps, field) {
  if (routeSteps.length === 0) {
    return { status: 'unrecorded', observedLabels: [], unknownReasons: ['no_submitted_provider_interactions'] }
  }
  const states = routeSteps.flatMap(providerSubmissionRecords).map((record) => {
    const observed = providerSubmissionLabel(record, field)
    const reasons = providerSubmissionReasons(record, field)
    if (typeof observed === 'string') return { state: 'observed', observed, reasons }
    const choice = record.submissionObservation[field]
    if (choice?.status === 'unknown' && typeof choice.reason === 'string') return { state: 'recorded_unavailable', observed: null, reasons }
    return { state: 'unrecorded', observed: null, reasons: reasons.length > 0 ? reasons : ['provider_execution_metadata_missing'] }
  })
  if (routeSteps.some((step) => !submissionCoverageComplete(step))) {
    states.push({ state: 'unrecorded', observed: null, reasons: ['provider_submission_coverage_incomplete'] })
  }
  if (states.length === 0) states.push({ state: 'unrecorded', observed: null, reasons: ['no_submission_observations'] })
  const statesSet = new Set(states.map(({ state }) => state))
  const status = statesSet.size === 1
    ? [...statesSet][0]
    : statesSet.has('unrecorded')
      ? (statesSet.size === 1 ? 'unrecorded' : 'partial')
      : 'recorded_unavailable'
  return {
    status,
    observedLabels: [...new Set(states.map(({ observed }) => observed).filter((value) => typeof value === 'string'))].sort(),
    unknownReasons: [...new Set(states.flatMap(({ reasons }) => reasons).filter((reason) => typeof reason === 'string'))],
  }
}

function buildCompletenessEvidence({ kind, deepTrials, trialResults, trace, accountPlans }) {
  const routeSteps = trace.steps.filter((step) => step.type === 'provider.routing' && (
    step.providerSubmitted === true
    || (step.providerEvidence?.expectedSubmissions ?? 0) > 0
    || (step.providerEvidence?.submissions.length ?? 0) > 0
    || step.tools.some((tool) => tool.requested === true)
  ))
  const modelCoverage = metadataFieldCoverage(routeSteps, 'model')
  const effortCoverage = metadataFieldCoverage(routeSteps, 'effort')
  const actionLinked = trace.steps.length > 0
    && trace.steps.every((step) => step.action !== 'audit_event')
    && trace.steps.filter((step) => step.type !== 'provider.attachment' && step.type !== 'dsh.parent.completed').every((step) => step.links.length > 0)
    && trace.steps.filter((step) => step.type === 'provider.routing' && step.scope === 'child').every((step) => ['action_batch', 'final'].includes(step.toolResponseStatus))
    && trace.steps.flatMap((step) => step.tools).every((tool) => tool.callId !== null && tool.interactionId !== null)
  const timedSteps = trace.steps.filter((step) => step.type !== 'dsh.parent.completed')
  const timingAvailable = timedSteps.length > 0 && timedSteps.every((step) => step.timing !== null)
  const missing = []
  if (['unrecorded', 'partial'].includes(modelCoverage.status) && kind !== 'oracle') missing.push('actual_model')
  if (['unrecorded', 'partial'].includes(effortCoverage.status) && kind !== 'oracle') missing.push('actual_effort')
  if (!actionLinked && kind !== 'oracle') missing.push('action_tool_linkage')
  if (!timingAvailable && kind !== 'oracle') missing.push('step_timing')
  if (trace.snapshot.availability !== 'available' && kind !== 'oracle') missing.push('trace_snapshot')
  return {
    status: missing.length === 0 ? 'complete' : 'partial',
    missing,
    model: {
      status: kind === 'oracle' ? 'not_applicable' : modelCoverage.status,
      observedLabels: kind === 'oracle' ? [] : modelCoverage.observedLabels,
      unknownReasons: kind === 'oracle' ? [] : modelCoverage.unknownReasons,
    },
    effort: {
      status: kind === 'oracle' ? 'not_applicable' : effortCoverage.status,
      observedLabels: kind === 'oracle' ? [] : effortCoverage.observedLabels,
      unknownReasons: kind === 'oracle' ? [] : effortCoverage.unknownReasons,
    },
    actionToolLinkage: { status: kind === 'oracle' ? 'not_applicable' : (actionLinked ? 'observed' : 'partial'), reason: actionLinked ? null : 'adapter_audit_does_not_link_every_step_to_a_tool' },
    timing: { status: kind === 'oracle' ? 'not_applicable' : (timingAvailable ? 'observed' : 'partial'), reason: timingAvailable ? null : 'audit_events_have_no_interval_timestamps' },
    nativeUsage: {
      status: kind === 'oracle' ? 'not_applicable' : 'unavailable',
      reason: kind === 'oracle' ? null : 'provider_native_tokens_and_cost_not_exposed',
      inputTokens: null, outputTokens: null, reasoningTokens: null,
      cacheReadTokens: null, cacheWriteTokens: null, cost: null, currency: null,
    },
    traceSnapshot: trace.snapshot,
    accountObservation: {
      status: accountPlans?.availability ?? 'unavailable',
      capturedAt: accountPlans?.capturedAt ?? null,
      providerCount: Object.keys(accountPlans?.providers ?? {}).length,
    },
    officialRewardIndependent: true,
    trialCount: trialResults.length,
    auditTrialCount: deepTrials.length,
  }
}

async function observeExistingJob(args) {
  const jobDir = await existingJobDirectory(args)
  const report = await readJson(path.join(jobDir, 'tokenless-run.json'))
  const written = await writeRunObservation({ jobDir, report })
  return {
    schema: OBSERVATION_SCHEMA,
    jobName: path.basename(jobDir),
    path: path.relative(root, written.outputPath).split(path.sep).join('/'),
  }
}

async function writeRunObservation({ jobDir, report }) {
  const observation = await buildRunObservation({ jobDir, report })
  validateObservationArtifact(observation)
  const observationsDirectory = path.join(benchmarkRoot, 'observations')
  const jobName = path.basename(jobDir)
  const outputDirectory = path.join(observationsDirectory, jobName)
  await rejectSymlinkComponents(observationsDirectory, outputDirectory, 'observation output')
  const outputPath = path.join(outputDirectory, 'run-observation.json')
  await refuseExisting(outputPath)
  await fs.mkdir(outputDirectory, { recursive: true })
  await fs.writeFile(outputPath, `${JSON.stringify(observation, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { outputPath, observation }
}

async function buildRunObservation({ jobDir, report }) {
  if (report?.schema !== RUN_SCHEMA) {
    throw new Error('The job tokenless-run.json does not use the pinned Terminal-Bench run schema.')
  }
  const official = await readJson(path.join(jobDir, 'result.json'))
  const trialRecords = await readObservationTrials(jobDir)
  const kind = inferRunKind(report, path.basename(jobDir))
  validateObservationRunIdentity(report, trialRecords, kind)
  const execution = observationExecutionMode(report, kind)
  const stats = official?.stats
  const rewards = trialRecords
    .map(({ result }) => result?.verifier_result?.rewards?.reward)
    .filter((reward) => typeof reward === 'number' && Number.isFinite(reward))
  const completedTrials = observationCount(stats?.n_completed_trials, 'completed trials')
  const erroredTrials = observationCount(stats?.n_errored_trials, 'errored trials')
  const cancelledTrials = observationCount(stats?.n_cancelled_trials, 'cancelled trials')
  const retries = observationCount(stats?.n_retries, 'retries')
  const routing = projectObservationRouting(trialRecords, report)
  const observation = {
    schema: OBSERVATION_SCHEMA,
    identity: {
      jobName: path.basename(jobDir),
      kind,
      benchmark: observationString(report.benchmark, 'benchmark'),
      dataset: observationString(report.dataset, 'dataset'),
      datasetRef: observationSha256(report.datasetRef, 'dataset reference'),
      harborVersion: observationString(report.harborVersion, 'Harbor version'),
      deepseekHarnessRevision: observationNullableString(report.deepseekHarnessRevision),
      tokenlessRevision: observationNullableString(report.tokenlessRevision),
      model: observationNullableString(report.model),
      routingMode: observationNullableString(report.routingMode),
      profile: observationNullableString(report.profile),
      taskCount: observationCount(report.taskCount, 'task count'),
      attemptsPerTask: observationCount(report.attemptsPerTask, 'attempts per task'),
      expectedTrials: observationCount(report.expectedTrials, 'expected trials'),
      executionMode: execution.mode,
      executionModeStatus: execution.status,
      executionPath: kind === 'oracle' ? ORACLE_OBSERVATION_EXECUTION_PATH : OBSERVATION_EXECUTION_PATH,
    },
    timing: observationTiming(official, 'Harbor run'),
    officialOutcome: {
      completedTrials,
      erroredTrials,
      cancelledTrials,
      retries,
      rewards: {
        count: rewards.length,
        passed: rewards.filter((reward) => reward === 1).length,
        failed: rewards.length - rewards.filter((reward) => reward === 1).length,
        passRate: observationRate(rewards.filter((reward) => reward === 1).length, rewards.length),
      },
    },
    trials: trialRecords.map(observationTrial),
    routing,
    evidence: await observationEvidence(jobDir, trialRecords),
    executionEvidence: report.executionEvidence,
    completeness: report.completeness,
    comparability: report.comparability,
    trace: projectObservationTrace(trialRecords),
    accountObservation: report.providerRouting?.accountPlans ?? {
      availability: 'unavailable',
      reason: 'report_missing_account_observation',
      capturedAt: null,
      providers: {},
    },
  }
  return observation
}

async function readObservationTrials(jobDir) {
  const entries = (await fs.readdir(jobDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))
  const records = []
  for (const entry of entries) {
    const directory = path.join(jobDir, entry.name)
    const resultPath = path.join(directory, 'result.json')
    if (!await exists(resultPath)) continue
    const result = await readJson(resultPath)
    if (typeof result.trial_name !== 'string' || typeof result.task_name !== 'string') {
      throw new Error(`Trial result in ${entry.name} has no bounded task identity.`)
    }
    const auditPath = path.join(directory, 'agent', 'deep-integration.jsonl')
    const events = await exists(auditPath) ? await readObservationAudit(auditPath) : []
    if (events.length > 0) {
      try {
        deepIntegrationStats(events, result.trial_name)
      } catch (error) {
        throw new Error(`Invalid deep-integration evidence for ${result.trial_name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    records.push({ directory, result, events, verifierTests: await readVerifierTests(directory), auditPath: events.length > 0 ? auditPath : null })
  }
  records.sort((left, right) => left.result.trial_name.localeCompare(right.result.trial_name))
  return records
}

async function readObservationAudit(auditPath) {
  const events = []
  for (const line of (await fs.readFile(auditPath, 'utf8')).split(/\r?\n/u)) {
    if (!line.trim()) continue
    events.push(JSON.parse(line))
  }
  return events
}

function inferRunKind(report, jobName) {
  if (report.agent === 'oracle') return 'oracle'
  if (report.task !== null && report.task !== undefined) return 'wiring'
  if (report.attemptsPerTask === 1 && report.expectedTrials === revision.taskCount) return 'sweep'
  if (report.attemptsPerTask === revision.attemptsPerTask && report.expectedTrials === revision.taskCount * revision.attemptsPerTask) return 'full'
  const match = /^tokenless-tb4-(oracle|wiring|sweep|full)-/u.exec(jobName)
  return match?.[1] ?? 'unknown'
}

function validateObservationRunIdentity(report, records, kind) {
  if (kind === 'unknown') throw new Error('The result is not a recognized Terminal-Bench Harness run.')
  if (records.length !== report.expectedTrials) {
    throw new Error(`Observation found ${records.length} trials; expected ${String(report.expectedTrials)}.`)
  }
  if (kind === 'oracle') {
    if (report.agent !== 'oracle') throw new Error('The oracle observation has an invalid agent identity.')
    return
  }
  if (
    report.agent !== 'deepseek-harness-tokenless-deep'
    || report.model !== revision.model
    || report.routingMode !== 'auto'
    || typeof report.profile !== 'string'
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(report.profile)
    || report.deepIntegration?.protocol !== revision.auditProtocol
    || report.providerRouting?.protocol !== revision.routingProtocol
    || report.executionMode !== undefined && report.executionMode !== 'browser'
  ) {
    throw new Error('The result does not prove the pinned provider-neutral DeepSeek Harness lane identity.')
  }
  const exceptionTrials = new Set(
    Array.isArray(report.preRoutingExceptions?.trials)
      ? report.preRoutingExceptions.trials.map((exception) => exception?.trial)
      : [],
  )
  if (
    exceptionTrials.size !== report.preRoutingExceptions?.count
    || records.some((record) => record.events.length === 0 && !exceptionTrials.has(record.result.trial_name))
    || records.some((record) => record.events.length > 0 && exceptionTrials.has(record.result.trial_name))
  ) {
    throw new Error('Every non-oracle observation trial requires a valid audit or a proven pre-routing exception.')
  }
}

function observationExecutionMode(report, kind) {
  if (kind === 'oracle' || report.executionMode === undefined) {
    return { mode: null, status: 'unavailable' }
  }
  if (report.executionMode !== 'browser') {
    throw new Error('The DeepSeek Harness observation does not prove browser execution mode.')
  }
  return { mode: report.executionMode, status: 'proven' }
}

function observationTrial(record) {
  const result = record.result
  const reward = result?.verifier_result?.rewards?.reward
  const exceptionType = result?.exception_info?.exception_type
  if (exceptionType !== undefined && exceptionType !== null && typeof exceptionType !== 'string') {
    throw new Error(`Trial ${result.trial_name} has an invalid exception type.`)
  }
  if (reward !== undefined && reward !== null && (typeof reward !== 'number' || !Number.isFinite(reward))) {
    throw new Error(`Trial ${result.trial_name} has an invalid reward.`)
  }
  return {
    trial: result.trial_name,
    task: result.task_name,
    ...observationTiming(result, 'trial'),
    stages: {
      environmentSetup: observationStage(result.environment_setup, `${result.trial_name} environment setup`),
      agentSetup: observationStage(result.agent_setup, `${result.trial_name} agent setup`),
      agentExecution: observationStage(result.agent_execution, `${result.trial_name} agent execution`),
      verifier: observationStage(result.verifier, `${result.trial_name} verifier`),
    },
    reward: reward ?? null,
    exceptionType: exceptionType ?? null,
    verifierTests: record.verifierTests,
  }
}

async function readVerifierTests(directory) {
  const file = path.join(directory, 'verifier', 'ctrf.json')
  if (!await exists(file)) return { availability: 'unavailable', reason: 'official_ctrf_not_produced', tests: [] }
  const report = await readJson(file)
  if (!Array.isArray(report.results?.tests)) throw new Error('Official CTRF report has no tests array.')
  const tests = report.results.tests.map((test) => {
    if (typeof test.name !== 'string' || test.name.length > 512
      || !['passed', 'failed', 'skipped', 'pending', 'other'].includes(test.status)) {
      throw new Error('Official CTRF test identity or status is invalid.')
    }
    const diagnostic = typeof test.trace === 'string' ? test.trace : ''
    return {
      name: test.name,
      status: test.status,
      reportedDurationMs: Number.isFinite(test.duration) && test.duration >= 0 ? test.duration : null,
      diagnostic: diagnostic ? { sha256: sha256Value(diagnostic), characters: diagnostic.length } : null,
    }
  })
  return { availability: 'observed', reason: null, tests }
}

function observationStage(stage, label) {
  return stage === null || stage === undefined ? null : observationTiming(stage, label)
}

function observationTiming(record, label) {
  const startedAt = observationTimestamp(record?.started_at, `${label} start`)
  const finishedAt = observationTimestamp(record?.finished_at, `${label} finish`)
  if ((startedAt === null) !== (finishedAt === null)) throw new Error(`${label} has only one timestamp.`)
  if (startedAt === null) return { startedAt: null, finishedAt: null, durationMs: null }
  const started = observationTimeValue(startedAt)
  const finished = observationTimeValue(finishedAt)
  const durationMs = Math.round(finished - started)
  if (finished < started || !Number.isSafeInteger(durationMs) || durationMs < 0) throw new Error(`${label} has an invalid timestamp pair.`)
  return { startedAt, finishedAt, durationMs }
}

function observationTimestamp(value, label) {
  if (value === null || value === undefined) return null
  if (
    typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/u.test(value)
    || !Number.isFinite(observationTimeValue(value))
  ) throw new Error(`${label} is malformed.`)
  return value
}

function observationTimeValue(value) {
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/u.test(value) ? value : `${value}Z`)
}

function projectObservationRouting(records, report) {
  const events = records.flatMap((record) => record.events
    .filter((event) => event.type === 'provider.routing')
    .map((event) => projectObservationEvent(event, record)))
    .sort((left, right) => left.trial.localeCompare(right.trial) || left.sequence - right.sequence)
  const interactions = events.flatMap((event) => event.tokenEstimate.interactions.map((interaction, index) => ({
    trial: event.trial,
    task: event.task,
    eventSequence: event.sequence,
    scope: event.scope,
    provider: interaction.provider,
    outcome: interaction.outcome,
    reason: index < event.attempts.length ? event.attempts[index].reason : null,
    observedAt: interaction.observedAt,
    providerSubmitted: interaction.providerSubmitted,
    inputTokens: interaction.inputTokens,
    outputTokens: interaction.outputTokens,
    totalTokens: interaction.totalTokens,
  })))
  const limits = events.flatMap((event) => observationLimitEvents(event))
  return {
    protocol: observationString(report.providerRouting?.protocol ?? revision.routingProtocol, 'routing protocol'),
    mode: observationNullableString(report.routingMode),
    events,
    interactions,
    aggregates: observationRoutingAggregates(events, interactions),
    scopes: observationRoutingScopes(events, interactions),
    limitObservations: limits,
  }
}

function projectObservationEvent(event, record) {
  validateProviderRoutingEvent(event)
  return {
    trial: record.result.trial_name,
    task: record.result.task_name,
    sequence: event.sequence,
    scope: event.scope,
    mode: event.mode,
    preferenceRequested: event.preferenceRequested,
    preferenceHonored: event.preferenceHonored,
    exclusions: event.exclusions,
    fallbackProviders: event.fallbackProviders,
    fallbackUsed: event.fallbackUsed,
    provider: event.provider,
    outcome: event.outcome,
    providerSubmitted: event.providerSubmitted,
    rateLimited: event.rateLimited,
    visibleProof: event.visibleProof,
    limitWindow: event.limitWindow,
    retryAfterSeconds: event.retryAfterSeconds,
    attempts: event.attempts.map((attempt) => ({
      provider: attempt.provider,
      outcome: attempt.outcome,
      reason: attempt.reason,
      observedAt: attempt.observedAt,
      providerSubmitted: attempt.providerSubmitted,
      visibleProof: attempt.visibleProof ?? null,
      limitWindow: attempt.limitWindow ?? null,
      retryAfterSeconds: attempt.retryAfterSeconds ?? null,
    })),
    observedAt: event.observedAt,
    tokenEstimate: {
      availability: event.tokenEstimate.availability,
      basis: event.tokenEstimate.basis,
      estimator: event.tokenEstimate.estimator,
      estimatorRevision: event.tokenEstimate.estimatorRevision,
      inputCharacters: event.tokenEstimate.inputCharacters,
      inputTextSha256: event.tokenEstimate.inputTextSha256,
      outputCharacters: event.tokenEstimate.outputCharacters,
      outputTextSha256: event.tokenEstimate.outputTextSha256,
      interactions: event.tokenEstimate.interactions,
      totalTokens: event.tokenEstimate.totalTokens,
    },
  }
}

function observationLimitEvents(event) {
  const limits = []
  for (const [index, attempt] of event.attempts.entries()) {
    if (attempt.reason !== 'rate_limit' && attempt.visibleProof === undefined) continue
    const interaction = event.tokenEstimate.interactions[index]
    limits.push({
      trial: event.trial,
      task: event.task,
      eventSequence: event.sequence,
      scope: event.scope,
      provider: attempt.provider,
      observedAt: attempt.observedAt,
      reason: attempt.reason,
      providerSubmitted: attempt.providerSubmitted,
      visibleProof: attempt.visibleProof ?? null,
      limitWindow: attempt.limitWindow ?? null,
      retryAfterSeconds: attempt.retryAfterSeconds ?? null,
      inputTokens: interaction.inputTokens,
      outputTokens: interaction.outputTokens,
      totalTokens: interaction.totalTokens,
    })
  }
  if (event.visibleProof !== null) {
    const interaction = event.tokenEstimate.interactions.at(-1)
    limits.push({
      trial: event.trial,
      task: event.task,
      eventSequence: event.sequence,
      scope: event.scope,
      provider: event.provider,
      observedAt: event.observedAt,
      reason: event.rateLimited ? 'rate_limit' : 'capacity',
      providerSubmitted: event.providerSubmitted,
      visibleProof: event.visibleProof,
      limitWindow: event.limitWindow,
      retryAfterSeconds: event.retryAfterSeconds,
      inputTokens: interaction.inputTokens,
      outputTokens: interaction.outputTokens,
      totalTokens: interaction.totalTokens,
    })
  }
  return limits
}

function projectObservationTrace(records) {
  const steps = records.flatMap((record) => record.events.map((event) => projectTraceStep(event, record.result.trial_name)))
    .sort((left, right) => left.trial.localeCompare(right.trial) || left.sequence - right.sequence)
  return {
    protocol: revision.auditProtocol,
    steps,
    snapshot: {
      availability: steps.length > 0 ? 'available' : 'unavailable',
      reason: steps.length > 0 ? null : 'no-audit-events',
    },
  }
}

function observationRoutingAggregates(events, interactions) {
  const submitted = interactions.filter((interaction) => interaction.providerSubmitted).length
  const completed = interactions.filter((interaction) => interaction.outcome === 'completed').length
  const failed = interactions.filter((interaction) => interaction.outcome !== 'completed').length
  const fallbacks = interactions.filter((interaction) => interaction.outcome === 'fallback').length
  const estimators = new Set(events.map((event) => event.tokenEstimate.estimator))
  const revisions = new Set(events.map((event) => event.tokenEstimate.estimatorRevision))
  const bases = new Set(events.map((event) => event.tokenEstimate.basis))
  if (estimators.size > 1 || revisions.size > 1) {
    throw new Error('Observation token estimates must use one estimator and revision.')
  }
  return {
    interactions: interactions.length,
    submittedInteractions: submitted,
    submittedRate: observationRate(submitted, interactions.length),
    completed,
    completedRate: observationRate(completed, interactions.length),
    failed,
    failedRate: observationRate(failed, interactions.length),
    fallbacks,
    fallbackRate: observationRate(fallbacks, interactions.length),
    inputTokens: interactions.reduce((sum, interaction) => sum + interaction.inputTokens, 0),
    outputTokens: interactions.reduce((sum, interaction) => sum + interaction.outputTokens, 0),
    totalTokens: interactions.reduce((sum, interaction) => sum + interaction.totalTokens, 0),
    estimateStatus: events.length === 0 ? 'not_applicable' : 'estimated',
    estimator: events[0]?.tokenEstimate.estimator ?? null,
    estimatorRevision: events[0]?.tokenEstimate.estimatorRevision ?? null,
    bases: [...bases].sort(),
  }
}

function observationRoutingScopes(events, interactions) {
  const scopes = { parent: { providers: {} }, child: { providers: {} } }
  const getCounts = (scope, provider) => {
    const providers = scopes[scope].providers
    providers[provider] ??= emptyObservationProviderCounts()
    return providers[provider]
  }
  for (const interaction of interactions) {
    const counts = getCounts(interaction.scope, interaction.provider)
    counts.interactions += 1
    if (interaction.providerSubmitted) counts.submitted += 1
    if (interaction.outcome === 'completed') counts.completed += 1
    else counts.failed += 1
    if (interaction.outcome === 'fallback') counts.fallbacks += 1
    counts.inputTokens += interaction.inputTokens
    counts.outputTokens += interaction.outputTokens
    counts.totalTokens += interaction.totalTokens
  }
  for (const event of events) {
    const finalCounts = getCounts(event.scope, event.provider)
    if (event.rateLimited) finalCounts.rateLimited += 1
    if (event.preferenceRequested !== null) {
      const preferredCounts = getCounts(event.scope, event.preferenceRequested)
      preferredCounts.preferenceRequested += 1
      if (event.preferenceHonored) preferredCounts.preferenceHonored += 1
    }
    for (const attempt of event.attempts) {
      if (attempt.reason === 'rate_limit') getCounts(event.scope, attempt.provider).rateLimited += 1
    }
  }
  for (const scope of Object.values(scopes)) {
    for (const counts of Object.values(scope.providers)) {
      counts.submittedRate = observationRate(counts.submitted, counts.interactions)
      counts.completedRate = observationRate(counts.completed, counts.interactions)
      counts.failedRate = observationRate(counts.failed, counts.interactions)
      counts.fallbackRate = observationRate(counts.fallbacks, counts.interactions)
    }
  }
  return scopes
}

function emptyObservationProviderCounts() {
  return {
    interactions: 0,
    submitted: 0,
    submittedRate: null,
    completed: 0,
    completedRate: null,
    failed: 0,
    failedRate: null,
    fallbacks: 0,
    fallbackRate: null,
    rateLimited: 0,
    preferenceRequested: 0,
    preferenceHonored: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  }
}

async function observationEvidence(jobDir, records) {
  const rootFiles = []
  for (const name of ['result.json', 'config.json', 'tokenless-run.json']) {
    rootFiles.push(await observationFileEvidence(jobDir, path.join(jobDir, name)))
  }
  const trials = []
  for (const record of records) {
    const files = [await observationFileEvidence(jobDir, path.join(record.directory, 'result.json'))]
    if (record.auditPath !== null) files.push(await observationFileEvidence(jobDir, record.auditPath))
    trials.push({ trial: record.result.trial_name, task: record.result.task_name, files })
  }
  return {
    root: rootFiles,
    trials,
    artifacts: await observationArtifactIndex(jobDir),
  }
}

async function observationArtifactIndex(jobDir) {
  const files = []
  await walkEvidenceFiles(jobDir, jobDir, files)
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

async function walkEvidenceFiles(jobDir, current, output) {
  const entries = await fs.readdir(current, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(current, entry.name)
    const relative = observationRelativePath(jobDir, filePath)
    if (PRIVATE_EVIDENCE_PATTERN.test(relative)) continue
    if (entry.isDirectory()) {
      await walkEvidenceFiles(jobDir, filePath, output)
    } else if (entry.isFile()) {
      output.push(await observationFileEvidence(jobDir, filePath))
    }
  }
}

async function observationFileEvidence(jobDir, filePath) {
  const bytes = await fs.readFile(filePath)
  return {
    path: observationRelativePath(jobDir, filePath),
    sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    bytes: bytes.byteLength,
    lineCount: bytes.length === 0 ? 0 : bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim() !== '').length,
  }
}

function observationRelativePath(jobDir, filePath) {
  const relative = path.relative(jobDir, filePath)
  if (relative === '' || path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Observation evidence path is outside the job directory.')
  }
  return relative.split(path.sep).join('/')
}

function validateObservationArtifact(observation) {
  if (!observationValidator(observation)) {
    throw new Error(`Generated observation failed schema validation: ${observationValidator.errorsText(observationValidator.errors)}`)
  }
}

function observationString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Observation ${label} is missing.`)
  return value
}

function observationNullableString(value) {
  return value === null || value === undefined ? null : observationString(value, 'string field')
}

function observationSha256(value, label) {
  const normalized = observationString(value, label)
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized)) throw new Error(`Observation ${label} is invalid.`)
  return normalized
}

function observationCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Observation ${label} is invalid.`)
  return value
}

function observationRate(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function preRoutingException(trial, directory) {
  const exception = trial?.exception_info
  const stage = trial?.agent_execution === null
    ? 'before_agent_execution'
    : exception?.exception_type === 'ValueError'
      && exception?.exception_message === 'The Harbor instruction is not one of the pinned Terminal-Bench 4.0 task instructions.'
      ? 'instruction_validation'
      : null
  if (
    !exception
    || typeof exception !== 'object'
    || Array.isArray(exception)
    || stage === null
    || typeof trial?.trial_name !== 'string'
    || typeof trial?.task_name !== 'string'
    || typeof exception.exception_type !== 'string'
    || typeof exception.occurred_at !== 'string'
  ) {
    throw new Error(`Missing deep-integration.jsonl without a proven pre-routing exception for non-oracle trial ${directory}.`)
  }
  return {
    trial: trial.trial_name,
    task: trial.task_name,
    stage,
    exceptionType: exception.exception_type,
    occurredAt: exception.occurred_at,
  }
}

async function benchmarkProviderPlanSnapshot({ tokenlessHome, daemonUrl, profile, routedProviders }) {
  const capturedAt = new Date().toISOString()
  const runtimeEntry = path.join(root, 'packages', 'cli', 'dist', 'src', 'index.js')
  const policyEntry = path.join(root, 'packages', 'server', 'dist', 'src', 'providers', 'rate-limit-policy.js')
  try {
    const [runtime, policy] = await Promise.all([
      import(pathToFileURL(runtimeEntry).href),
      import(pathToFileURL(policyEntry).href),
    ])
    const state = await runtime.getControlState({ homeDir: tokenlessHome, daemonUrl })
    const selected = Array.isArray(state?.profiles)
      ? state.profiles.find((candidate) => candidate?.slug === profile)
      : null
    if (!selected || !selected.lastObservedAuth || typeof selected.lastObservedAuth !== 'object') {
      return {
        availability: 'unavailable',
        reason: 'profile_plan_observation_missing',
        capturedAt,
        providers: {},
      }
    }
    const providers = {}
    for (const provider of [...routedProviders].sort()) {
      const observation = selected.lastObservedAuth[provider]
      const account = observation?.account
      const tier = account?.tier
      const checkedAt = typeof observation?.checkedAt === 'string'
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(observation.checkedAt)
        ? observation.checkedAt
        : null
      const accessClass = typeof observation?.access === 'string' && /^[a-z_]{1,64}$/u.test(observation.access)
        ? observation.access
        : 'unknown'
      const tierClass = ['signed_in_free', 'signed_in_paid', 'signed_in_unknown'].includes(tier?.class)
        ? tier.class
        : null
      const projection = policy.providerCapacityPolicy.project({
        provider,
        profileId: profile,
        accessClass,
        tierLabel: safePlanLabel(tier?.label),
        subscriptionLabel: safePlanLabel(account?.subscription),
        requestJson: {},
        history: [],
        now: checkedAt ?? capturedAt,
      })
      const planId = typeof projection.subscription.planId === 'string'
        && /^[a-z0-9][a-z0-9._-]{0,63}$/u.test(projection.subscription.planId)
        ? projection.subscription.planId
        : 'unknown'
      const planMatch = ['label', 'access_class', 'unknown'].includes(projection.subscription.match)
        ? projection.subscription.match
        : 'unknown'
      const observedLabel = planMatch === 'label'
        ? safePlanLabel(projection.subscription.observedLabel)
        : null
      const ageSeconds = checkedAt === null ? null : Math.max(0, Math.floor((Date.parse(capturedAt) - Date.parse(checkedAt)) / 1000))
      providers[provider] = {
        checkedAt,
        ageSeconds: Number.isSafeInteger(ageSeconds) ? ageSeconds : null,
        plan: { id: planId, match: planMatch, observedLabel },
        tierClass,
      }
    }
    return { availability: 'observed', capturedAt, providers }
  } catch (error) {
    return {
      availability: 'unavailable',
      reason: safeErrorCode(error, 'profile_plan_observation_failed'),
      capturedAt,
      providers: {},
    }
  }
}

function safePlanLabel(value) {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 160
    && !/[\r\n\0]/u.test(value)
    ? value
    : null
}

function validateResolvedRun({
  official,
  jobConfig,
  trialResults,
  deepTrials,
  preRoutingExceptions,
  kind,
  task,
  attemptsPerTask,
  expectedTrials,
  runtimeArchive,
  proxyScript,
  tokenEstimatorScript,
  tokenEstimatorNode,
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
  const exceptionTrials = trialResults.filter((trial) => trial?.exception_info != null)
  if (exceptionTrials.length !== official.stats.n_errored_trials) {
    throw new Error('Harbor errored trial count does not match the official trial exception records.')
  }
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
    if (deepTrials.length + preRoutingExceptions.length !== expectedTrials) {
      throw new Error(`Every non-oracle trial must have observer evidence or a proven pre-routing exception; found ${deepTrials.length + preRoutingExceptions.length} for ${expectedTrials} trials.`)
    }
    validateDeepSeekAgent(jobConfig, {
      runtime_archive: runtimeArchive,
      proxy_script: proxyScript,
      token_estimator_script: tokenEstimatorScript,
      token_estimator_node: tokenEstimatorNode,
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
  const expectedTaskCount = kind === 'oracle' || kind === 'wiring' ? 1 : revision.taskCount
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
    const reward = trial?.verifier_result?.rewards?.reward
    if ((typeof reward !== 'number' || !Number.isFinite(reward)) && trial?.exception_info == null) {
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
    || stats.n_errored_trials > expectedTrials
    || stats.n_cancelled_trials !== 0
    || stats.n_running_trials !== 0
    || stats.n_pending_trials !== 0
    || stats.n_retries !== 0
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

function deepIntegrationStats(events, trial) {
  const validTypes = new Set([
    'api.completion.request',
    'child.turn.started',
    'provider.routing',
    'provider.routing.invalid',
    'provider.attachment',
    'dsh.parent.completed',
  ])
  if (events.length === 0) {
    throw new Error('Deep integration audit evidence is empty.')
  }
  let nextParentOrdinal = 1
  for (const [index, event] of events.entries()) {
    if (!validTypes.has(event.type) || event.sequence !== index + 1) {
      throw new Error('Deep integration audit events are invalid or out of sequence.')
    }
    if (event.type === 'api.completion.request') {
      validateApiCompletionEvent(event, nextParentOrdinal)
      nextParentOrdinal += 1
    } else if (event.type === 'child.turn.started') {
      validateChildTurnEvent(event)
    } else if (event.type === 'provider.routing') {
      validateProviderRoutingEvent(event)
    } else if (event.type === 'provider.routing.invalid') {
      validateInvalidRoutingEvent(event)
    } else if (event.type === 'provider.attachment') {
      validateAttachmentEvent(event)
    } else if (event.type === 'dsh.parent.completed') {
      if (
        Object.keys(event).some((key) => !['protocol', 'sequence', 'type', 'outcome'].includes(key))
        || !['succeeded', 'failed'].includes(event.outcome)
      ) {
        throw new Error('Host DSH process evidence is invalid.')
      }
    }
  }

  const parentRequests = events.filter((event) => event.type === 'api.completion.request')
  const childStarts = events.filter((event) => event.type === 'child.turn.started')
  const routing = events.filter((event) => event.type === 'provider.routing')
  const estimatorRevisions = new Set(routing.map((event) => event.tokenEstimate.estimatorRevision))
  if (estimatorRevisions.size > 1) {
    throw new Error('Deep integration token estimates must use one estimator revision per trial.')
  }
  const forcedParents = parentRequests.filter((event) => event.forcedSubagent === true)
  const firstForcedParent = forcedParents[0]
  const initialParentRequest = firstForcedParent?.ordinal === 2
    ? parentRequests.find((event) => event.ordinal === 1 && event.forcedSubagent === false)
    : undefined
  const initialParentRoute = initialParentRequest && firstForcedParent
    ? routing.find((event) => (
      event.scope === 'parent'
      && event.outcome === 'completed'
      && event.sequence > initialParentRequest.sequence
      && event.sequence < firstForcedParent.sequence
    ))
    : undefined
  const nextParentRequestAfterForced = firstForcedParent
    ? parentRequests.find((event) => event.sequence > firstForcedParent.sequence)
    : undefined
  const firstParentRoute = firstForcedParent && initialParentRoute
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
    ? events.find((event) => (
      event.type === 'dsh.parent.completed'
      && event.sequence > laterParentRoute.sequence
    ))
    : undefined
  const completeChains = parentCompleted ? 1 : 0
  const terminalParentRoutes = routing.filter((event) => (
    event.scope === 'parent'
    && (event.outcome === 'completed' || event.outcome === 'failed')
  ))
  const unsettledParentCompletionRequests = parentRequests.reduce((count, request, index) => {
    const nextRequest = parentRequests[index + 1]
    const settled = terminalParentRoutes.some((route) => (
      route.sequence > request.sequence
      && (nextRequest === undefined || route.sequence < nextRequest.sequence)
    ))
    return count + (settled ? 0 : 1)
  }, 0)
  const dshParentCompletions = events.filter((event) => event.type === 'dsh.parent.completed')
  return {
    trial,
    parentCompletionRequests: parentRequests.length,
    forcedParentCompletionRequests: parentRequests.filter((event) => event.forcedSubagent === true).length,
    childTurnStarts: childStarts.length,
    childBootstrapTurns: childStarts.filter((event) => event.mode === 'bootstrap').length,
    childContinuationTurns: childStarts.filter((event) => event.mode === 'continuation').length,
    providerRoutingEvents: routing.length,
    completedParentRouting: routing.filter((event) => event.scope === 'parent' && event.outcome === 'completed').length,
    completedChildRouting: routing.filter((event) => event.scope === 'child' && event.outcome === 'completed').length,
    parentCompleted: dshParentCompletions.length,
    successfulDshParents: dshParentCompletions.filter((event) => event.outcome === 'succeeded').length,
    failedDshParents: dshParentCompletions.filter((event) => event.outcome === 'failed').length,
    unsettledParentCompletionRequests,
    completeChains,
    tokenEstimatorRevision: estimatorRevisions.size === 1 ? [...estimatorRevisions][0] : null,
    providerRouting: providerRoutingStats(events),
    limitObservations: limitObservationEvents(events),
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
    'successfulDshParents',
    'failedDshParents',
    'unsettledParentCompletionRequests',
    'completeChains',
  ]
  return {
    protocol: revision.auditProtocol,
    observedTrials: trials.length,
    trialsWithCompleteChain: trials.filter((trial) => trial.completeChains > 0).length,
    ...Object.fromEntries(fields.map((field) => [field, trials.reduce((sum, trial) => sum + trial[field], 0)])),
  }
}

function validateApiCompletionEvent(event, expectedOrdinal) {
  if (Object.keys(event).some((key) => ![
    'protocol', 'sequence', 'type', 'ordinal', 'forcedSubagent', 'finalOnly', 'transportRef',
    'interactionId', 'startedAt', 'finishedAt', 'durationMs', 'outcome', 'failureReason',
    'requestedModel', 'requestedReasoningEffort', 'requestedTool', 'requestedToolStatus', 'tools',
  ].includes(key))
    || event.ordinal !== expectedOrdinal
    || !Number.isSafeInteger(event.ordinal)
    || event.ordinal < 1
    || typeof event.forcedSubagent !== 'boolean'
    || event.finalOnly !== undefined && typeof event.finalOnly !== 'boolean'
    || typeof event.interactionId !== 'string'
    || !/^parent:[a-f0-9]{32}$/u.test(event.interactionId)
    || !isAuditTimestamp(event.startedAt)
    || event.finishedAt !== undefined && !isAuditTimestamp(event.finishedAt)
    || event.durationMs !== undefined && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)
    || event.outcome !== undefined && !['succeeded', 'failed'].includes(event.outcome)
    || event.failureReason !== undefined && (typeof event.failureReason !== 'string' || !/^[a-z][a-z0-9_-]{0,95}$/u.test(event.failureReason))
    || event.transportRef !== undefined && (typeof event.transportRef !== 'string' || !/^proxy:[a-f0-9]{32}$/u.test(event.transportRef))
    || !validateSafeMetadataNullable(event.requestedModel)
    || !validateSafeMetadataNullable(event.requestedReasoningEffort)
    || !validateSafeMetadataNullable(event.requestedTool)
    || event.requestedToolStatus !== null && event.requestedToolStatus !== undefined && typeof event.requestedToolStatus !== 'boolean'
    || !validateTraceTools(event.tools)
  ) {
    throw new Error('Host parent completion evidence is invalid.')
  }
}

function validateChildTurnEvent(event) {
  if (Object.keys(event).some((key) => ![
    'protocol', 'sequence', 'type', 'interactionId', 'requestRef', 'turnRef', 'conversationRef',
    'mode', 'startedAt', 'finishedAt', 'durationMs', 'outcome', 'httpStatus', 'attachments',
  ].includes(key))
    || typeof event.interactionId !== 'string'
    || !/^child:[a-f0-9]{32}$/u.test(event.interactionId)
    || typeof event.requestRef !== 'string'
    || !/^request:[a-f0-9]{32}$/u.test(event.requestRef)
    || event.turnRef !== null && (typeof event.turnRef !== 'string' || !/^turn:[a-f0-9]{32}$/u.test(event.turnRef))
    || event.conversationRef !== null && (typeof event.conversationRef !== 'string' || !/^conversation:[a-f0-9]{32}$/u.test(event.conversationRef))
    || !['bootstrap', 'continuation'].includes(event.mode)
    || !isAuditTimestamp(event.startedAt)
    || !isAuditTimestamp(event.finishedAt)
    || !Number.isSafeInteger(event.durationMs)
    || event.durationMs < 0
    || !['succeeded', 'failed'].includes(event.outcome)
    || event.httpStatus !== undefined && (!Number.isSafeInteger(event.httpStatus) || event.httpStatus < 100 || event.httpStatus > 599)
    || !validateAttachmentList(event.attachments)
  ) {
    throw new Error('Host child turn evidence is invalid.')
  }
}

function validateAttachmentList(value) {
  return Array.isArray(value) && value.length <= 32 && value.every((entry) => validateAttachmentRecord(entry))
}

function validateAttachmentEvent(event) {
  if (Object.keys(event).some((key) => ![
    'protocol', 'sequence', 'type', 'attachmentRef', 'name', 'mediaType', 'byteLength', 'sha256',
    'declaredByteLength', 'declaredSha256', 'upload', 'outcome', 'unknownReason', 'startedAt',
    'finishedAt', 'durationMs', 'stage', 'stored', 'providerUpload',
  ].includes(key)) || !validateAttachmentRecord(event)) {
    throw new Error('Provider attachment evidence is invalid.')
  }
}

function validateAttachmentRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && value.stage === 'host_attachment_store'
    && typeof value.stored === 'boolean'
    && value.providerUpload && typeof value.providerUpload.observed === 'boolean'
    && (value.providerUpload.accepted === null || typeof value.providerUpload.accepted === 'boolean')
    && (value.attachmentRef === null || typeof value.attachmentRef === 'string' && /^attachment:[a-f0-9]{32}$/u.test(value.attachmentRef))
    && (value.name === null || typeof value.name === 'string' && value.name.length <= 256)
    && (value.mediaType === null || typeof value.mediaType === 'string' && value.mediaType.length <= 256)
    && Number.isSafeInteger(value.byteLength) && value.byteLength >= 0
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256)
    && (value.declaredByteLength === null || Number.isSafeInteger(value.declaredByteLength) && value.declaredByteLength >= 0)
    && (value.declaredSha256 === null || typeof value.declaredSha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.declaredSha256))
    && value.upload && typeof value.upload === 'object' && !Array.isArray(value.upload)
    && sameStringSet(Object.keys(value.upload), ['requested', 'returned', 'retained'])
    && typeof value.upload.requested === 'boolean'
    && typeof value.upload.returned === 'boolean'
    && typeof value.upload.retained === 'boolean'
    && ['succeeded', 'failed', 'unknown'].includes(value.outcome)
    && (value.unknownReason === null || typeof value.unknownReason === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(value.unknownReason))
    && isAuditTimestamp(value.startedAt)
    && isAuditTimestamp(value.finishedAt)
    && (value.durationMs === null || Number.isSafeInteger(value.durationMs) && value.durationMs >= 0)
}

function validateInvalidRoutingEvent(event) {
  if (Object.keys(event).some((key) => ![
    'protocol', 'sequence', 'type', 'reason', 'interactionId', 'scope', 'requestRef', 'turnRef',
    'startedAt', 'finishedAt', 'durationMs', 'outcome', 'executionMetadata',
  ].includes(key))
    || typeof event.reason !== 'string'
    || !/^[a-z][a-z0-9_-]{0,95}$/u.test(event.reason)
    || event.interactionId !== undefined && event.interactionId !== null
      && (typeof event.interactionId !== 'string' || !/^(?:parent|child):[a-f0-9]{32}$/u.test(event.interactionId))
    || event.scope !== undefined && !['parent', 'child'].includes(event.scope)
    || event.requestRef !== undefined && event.requestRef !== null
      && (typeof event.requestRef !== 'string' || !/^request:[a-f0-9]{32}$/u.test(event.requestRef))
    || event.turnRef !== undefined && event.turnRef !== null
      && (typeof event.turnRef !== 'string' || !/^turn:[a-f0-9]{32}$/u.test(event.turnRef))
    || event.startedAt !== undefined && !isAuditTimestamp(event.startedAt)
    || event.finishedAt !== undefined && !isAuditTimestamp(event.finishedAt)
    || event.durationMs !== undefined && (!Number.isSafeInteger(event.durationMs) || event.durationMs < 0)
    || event.outcome !== undefined && !['completed', 'failed'].includes(event.outcome)
  ) {
    throw new Error('Invalid provider routing evidence is malformed.')
  }
  if (event.executionMetadata !== undefined) validateProviderExecutionMetadata(event.executionMetadata, 'unknown')
}

function validateSafeMetadataNullable(value) {
  return value === null || value === undefined || typeof value === 'string' && value.length <= 160 && SAFE_METADATA_VALUE_PATTERN.test(value)
}

function validateProviderRoutingEvent(event) {
  if (
    Object.keys(event).some((key) => ![
      'protocol', 'sequence', 'type', 'scope', 'mode', 'provider',
      'fallbackProviders', 'fallbackUsed', 'rateLimited', 'preferenceRequested',
      'preferenceHonored', 'providerSubmitted', 'visibleProof', 'limitWindow',
      'retryAfterSeconds', 'exclusions', 'attempts', 'outcome', 'observedAt', 'tokenEstimate',
      'interactionId', 'requestRef', 'turnRef', 'startedAt', 'finishedAt', 'durationMs',
      'executionMetadata', 'tools', 'toolResponseStatus', 'toolResponseNormalizationApplied',
    ].includes(key))
    ||
    event.scope === 'child' && !['action_batch', 'final', 'invalid_framing', 'invalid_json', 'invalid_response', 'unavailable'].includes(event.toolResponseStatus)
    || event.toolResponseNormalizationApplied !== undefined && event.toolResponseNormalizationApplied !== null && typeof event.toolResponseNormalizationApplied !== 'boolean'
    || event.protocol !== revision.auditProtocol
    || typeof event.observedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(event.observedAt)
    || (event.scope !== 'parent' && event.scope !== 'child')
    || typeof event.interactionId !== 'string'
    || !/^(?:parent|child):[a-f0-9]{32}$/u.test(event.interactionId)
    || event.requestRef !== undefined && event.requestRef !== null
      && (typeof event.requestRef !== 'string' || !/^request:[a-f0-9]{32}$/u.test(event.requestRef))
    || event.turnRef !== undefined && event.turnRef !== null
      && (typeof event.turnRef !== 'string' || !/^turn:[a-f0-9]{32}$/u.test(event.turnRef))
    || typeof event.startedAt !== 'string'
    || !isAuditTimestamp(event.startedAt)
    || typeof event.finishedAt !== 'string'
    || !isAuditTimestamp(event.finishedAt)
    || !Number.isSafeInteger(event.durationMs)
    || event.durationMs < 0
    || (event.mode !== 'auto' && event.mode !== 'explicit')
    || typeof event.provider !== 'string'
    || !/^[a-z][a-z0-9-]{0,63}$/u.test(event.provider)
    || !Array.isArray(event.fallbackProviders)
    || event.fallbackProviders.length > 5
    || event.fallbackProviders.some((provider) => typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(provider))
    || !Array.isArray(event.exclusions)
    || event.exclusions.length > 64
    || event.exclusions.some((exclusion) => (
      !exclusion
      || typeof exclusion !== 'object'
      || !sameStringSet(Object.keys(exclusion), ['provider', 'category', 'reason'])
      || typeof exclusion.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(exclusion.provider)
      || !['access', 'runtime', 'capability'].includes(exclusion.category)
      || ![
        'provider_not_supported',
        'provider_mode_disabled',
        'provider_not_evaluated',
        'provider_access_unknown',
        'provider_access_sign_in_required',
        'provider_access_account_blocked',
        'provider_access_unavailable',
        'missing_conversation_capability',
        'missing_structured_control_capability',
        'capability_route_unavailable',
      ].includes(exclusion.reason)
    ))
    || typeof event.fallbackUsed !== 'boolean'
    || typeof event.rateLimited !== 'boolean'
    || event.preferenceRequested !== null && (
      typeof event.preferenceRequested !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(event.preferenceRequested)
    )
    || typeof event.preferenceHonored !== 'boolean'
    || event.preferenceHonored && event.preferenceRequested === null
    || typeof event.providerSubmitted !== 'boolean'
    || event.visibleProof !== null && (
      typeof event.visibleProof !== 'string'
      || !/^[a-z0-9:_-]{1,160}$/u.test(event.visibleProof)
    )
    || event.limitWindow !== null && !['minute', 'hour', 'day', 'week', 'unknown'].includes(event.limitWindow)
    || event.retryAfterSeconds !== null && (
      !Number.isSafeInteger(event.retryAfterSeconds)
      || event.retryAfterSeconds < 1
      || event.retryAfterSeconds > 604_800
    )
    || !Array.isArray(event.attempts)
    || event.attempts.length > 5
    || event.attempts.some((attempt) => (
      !attempt
      || typeof attempt !== 'object'
      || Object.keys(attempt).some((key) => ![
        'provider', 'outcome', 'reason', 'observedAt', 'providerSubmitted',
        'visibleProof', 'limitWindow', 'retryAfterSeconds',
      ].includes(key))
      || typeof attempt.provider !== 'string'
      || !/^[a-z][a-z0-9-]{0,63}$/u.test(attempt.provider)
      || attempt.outcome !== 'fallback'
      || !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable', 'unavailable'].includes(attempt.reason)
      || typeof attempt.observedAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(attempt.observedAt)
      || typeof attempt.providerSubmitted !== 'boolean'
      || attempt.visibleProof !== undefined && (
        typeof attempt.visibleProof !== 'string'
        || !/^[a-z0-9:_-]{1,160}$/u.test(attempt.visibleProof)
      )
      || attempt.limitWindow !== undefined && !['minute', 'hour', 'day', 'week', 'unknown'].includes(attempt.limitWindow)
      || attempt.retryAfterSeconds !== undefined && (
        !Number.isSafeInteger(attempt.retryAfterSeconds)
        || attempt.retryAfterSeconds < 1
        || attempt.retryAfterSeconds > 604_800
      )
      || attempt.visibleProof !== undefined
        && !['rate_limit', 'capacity', 'auth', 'captcha', 'unreachable'].includes(attempt.reason)
      || (attempt.limitWindow !== undefined || attempt.retryAfterSeconds !== undefined)
        && !['rate_limit', 'capacity', 'captcha', 'unreachable'].includes(attempt.reason)
      || attempt.reason === 'captcha' && attempt.visibleProof === undefined
      || attempt.reason === 'rate_limit' && (attempt.visibleProof === undefined || attempt.limitWindow === undefined)
    ))
    || event.fallbackUsed !== (event.attempts.length > 0)
    || (event.outcome !== 'completed' && event.outcome !== 'failed')
    || event.outcome === 'completed' && event.rateLimited
    || event.outcome === 'completed' && event.visibleProof !== null
    || event.rateLimited && (event.visibleProof === null || event.limitWindow === null)
    || !validateTraceTools(event.tools)
  ) {
    throw new Error(`Provider routing audit event is invalid at sequence ${String(event.sequence)}.`)
  }
  if (event.executionMetadata !== undefined) validateProviderExecutionMetadata(event.executionMetadata, event.provider)
  validateTokenEstimate(event)
}

function validateProviderExecutionMetadata(value, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['model', 'reasoningEffort', 'surface', 'observedAt', 'jobIds', 'jobs', 'submissions'].includes(key))
    || !['model', 'reasoningEffort', 'surface'].every((key) => Object.hasOwn(value, key))
    || value.observedAt !== undefined && !isAuditTimestamp(value.observedAt)
    || !validateProviderMetadataChoice(value.model)
    || !validateProviderMetadataChoice(value.reasoningEffort)
    || !validateProviderMetadataChoice(value.surface, true)
    || value.jobIds !== undefined && !validateProviderJobIds(value.jobIds)
    || value.jobs !== undefined && !validateProviderJobs(value.jobs)
    || value.submissions !== undefined && !validateProviderSubmissionObservations(value.submissions)
  ) {
    throw new Error(`Provider execution metadata is invalid for ${String(provider)}.`)
  }
}

function validateProviderMetadataChoice(value, surface = false) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && sameStringSet(Object.keys(value), ['requested', 'observed'])
    && validateProviderMetadataValue(value.requested, surface)
    && validateProviderMetadataValue(value.observed, surface)
}

function validateProviderMetadataValue(value, surface) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !['availability', 'value', 'reason'].includes(key))) return false
  if (!['observed', 'unknown'].includes(value.availability)) return false
  if (value.value !== undefined && value.value !== null
    && (typeof value.value !== 'string' || value.value.length < 1 || value.value.length > 160 || !SAFE_METADATA_VALUE_PATTERN.test(value.value))) return false
  if (value.reason !== undefined && value.reason !== null
    && (typeof value.reason !== 'string' || !/^[a-z][a-z0-9_-]{0,95}$/u.test(value.reason))) return false
  if (value.availability === 'observed'
    && (typeof value.value !== 'string' || surface && !['chat', 'work', 'unknown'].includes(value.value))) return false
  if (value.availability === 'unknown' && value.value !== undefined && value.value !== null) return false
  return true
}

function validateProviderSubmissionObservation(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && sameStringSet(Object.keys(value), ['protocol', 'observedAt', 'source', 'page', 'model', 'effort'])
    && (value.protocol === null || value.protocol === 'tokenless.provider-submission-observation.v1')
    && (value.observedAt === null || isAuditTimestamp(value.observedAt))
    && (value.source === null || ['visible-provider-controls-before-submit', 'direct-protocol-no-visible-controls'].includes(value.source))
    && value.page && typeof value.page === 'object' && !Array.isArray(value.page)
    && sameStringSet(Object.keys(value.page), ['surface', 'origin'])
    && ['chat', 'work', 'unknown'].includes(value.page.surface)
    && (value.page.origin === null || typeof value.page.origin === 'string' && value.page.origin.length <= 256)
    && validateRawProviderChoice(value.model, true)
    && validateRawProviderChoice(value.effort, false)
}

function validateProviderJobIds(value) {
  return Array.isArray(value)
    && value.length >= 1
    && value.length <= 2
    && new Set(value).size === value.length
    && value.every((jobId) => typeof jobId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(jobId))
}

function validateProviderJobs(value) {
  return Array.isArray(value)
    && value.length <= 2
    && value.every((job) => (
      job && typeof job === 'object' && !Array.isArray(job)
      && sameStringSet(Object.keys(job), ['jobId', 'availability', 'status', 'provider', 'providerSubmitted', 'submissionCount', 'reason', 'errorCode', 'errorClassification'])
      && typeof job.jobId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(job.jobId)
      && ['observed', 'unknown'].includes(job.availability)
      && (job.status === null || ['queued', 'running', 'waiting_for_user', 'succeeded', 'failed', 'canceled', 'cancelled'].includes(job.status))
      && (job.provider === null || validateSafeMetadataNullable(job.provider))
      && (job.providerSubmitted === null || typeof job.providerSubmitted === 'boolean')
      && Number.isSafeInteger(job.submissionCount)
      && job.submissionCount >= 0
      && (job.errorCode === null || typeof job.errorCode === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(job.errorCode))
      && [null, 'safe_pre_submit_provider_failure', 'ambiguous_external_state', 'post_submission_failure', 'user_resolvable_local_failure'].includes(job.errorClassification)
      && (job.reason === null || typeof job.reason === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(job.reason))
    ))
}

function validateProviderSubmissionObservations(value) {
  return Array.isArray(value)
    && value.length <= 128
    && value.every((submission) => (
      submission && typeof submission === 'object' && !Array.isArray(submission)
      && sameStringSet(Object.keys(submission), ['jobId', 'provider', 'action', 'metadata', 'submissionObservation', 'responseModel'])
      && typeof submission.jobId === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(submission.jobId)
      && (submission.provider === null || validateSafeMetadataNullable(submission.provider))
      && submission.action === 'prompt.submit'
      && validateProviderActionMetadata(submission.metadata)
      && validateProviderSubmissionObservation(submission.submissionObservation)
      && validateProviderResponseModel(submission.responseModel)
    ))
}

function validateProviderResponseModel(value) {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameStringSet(Object.keys(value), ['providerModelId', 'status', 'source', 'observedAt', 'reason'])
    || !['observed', 'unknown'].includes(value.status)
    || (value.providerModelId !== null
      && (typeof value.providerModelId !== 'string' || !PROVIDER_MODEL_SLUG_PATTERN.test(value.providerModelId)))
    || value.source !== 'assistant-message-dom'
    || !isAuditTimestamp(value.observedAt)
    || (value.reason !== null && value.reason !== 'assistant_message_model_not_exposed')
  ) return false
  if (value.status === 'observed') {
    return value.providerModelId !== null
      && value.source === 'assistant-message-dom'
      && value.observedAt !== null
      && value.reason === null
  }
  return value.providerModelId === null
}

function validateProviderActionMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (Object.keys(value).some((key) => !['provider', 'actionIndex', 'startedAt', 'completedAt', 'durationMs', 'executionMode'].includes(key))) return false
  return (value.provider === undefined || validateSafeMetadataNullable(value.provider))
    && (value.actionIndex === undefined || Number.isSafeInteger(value.actionIndex) && value.actionIndex >= 0 && value.actionIndex <= 256)
    && (value.startedAt === undefined || isAuditTimestamp(value.startedAt))
    && (value.completedAt === undefined || isAuditTimestamp(value.completedAt))
    && (value.durationMs === undefined || Number.isSafeInteger(value.durationMs) && value.durationMs >= 0)
    && (value.executionMode === undefined || ['browser', 'direct'].includes(value.executionMode))
}

function validateRawProviderChoice(value, model) {
  const expectedKeys = model
    ? ['requestedLabel', 'observedLabel', 'status', 'source', 'reason', 'providerModelId', 'identityStatus']
    : ['requestedLabel', 'observedLabel', 'status', 'source', 'reason']
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && sameStringSet(Object.keys(value), expectedKeys)
    && (value.requestedLabel === null || validateSafeMetadataNullable(value.requestedLabel))
    && (value.observedLabel === null || validateSafeMetadataNullable(value.observedLabel))
    && ['observed', 'unknown'].includes(value.status)
    && ['visible-provider-choice-inspect', 'not-observed'].includes(value.source)
    && (value.reason === null || typeof value.reason === 'string' && /^[a-z][a-z0-9_-]{0,95}$/u.test(value.reason))
    && (value.status === 'observed' ? value.observedLabel !== null : value.observedLabel === null)
    && (!model || (
      (value.providerModelId === null || validateSafeMetadataNullable(value.providerModelId))
      && ['not-exposed', 'unknown'].includes(value.identityStatus)
    ))
}

function validateTraceTools(value) {
  if (!Array.isArray(value) || value.length > 64) return false
  return value.every((tool) => (
    tool && typeof tool === 'object' && !Array.isArray(tool)
    && Object.keys(tool).every((key) => ['callId', 'toolName', 'interactionId', 'requested', 'returned', 'executed', 'outcome', 'exitCode', 'arguments', 'result', 'returnedAt', 'resultObservedAt'].includes(key))
    && typeof tool.callId === 'string'
    && /^[A-Za-z0-9._:-]{1,256}$/u.test(tool.callId)
    && (tool.toolName === null || typeof tool.toolName === 'string')
    && (tool.interactionId === null || typeof tool.interactionId === 'string')
    && (tool.requested === null || typeof tool.requested === 'boolean')
    && typeof tool.returned === 'boolean'
    && typeof tool.executed === 'boolean'
    && typeof tool.outcome === 'string'
    && ['unknown', 'succeeded', 'failed'].includes(tool.outcome)
    && (tool.exitCode === null || Number.isSafeInteger(tool.exitCode))
    && validateDigestSummary(tool.arguments)
    && validateDigestSummary(tool.result)
    && (tool.returnedAt === undefined || isAuditTimestamp(tool.returnedAt))
    && (tool.resultObservedAt === undefined || isAuditTimestamp(tool.resultObservedAt))
  ))
}

function validateDigestSummary(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
    && ['observed', 'unknown'].includes(value.availability)
    && (value.sha256 === undefined || value.sha256 === null || /^[a-f0-9]{64}$/u.test(value.sha256))
    && (value.bytes === undefined || value.bytes === null || Number.isSafeInteger(value.bytes) && value.bytes >= 0)
    && (value.characters === undefined || value.characters === null || Number.isSafeInteger(value.characters) && value.characters >= 0)
    && (value.reason === undefined || value.reason === null || typeof value.reason === 'string')
}

function isAuditTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u.test(value)
    && Number.isFinite(Date.parse(value))
}

function validateTokenEstimate(event) {
  const estimate = event.tokenEstimate
  if (
    !estimate
    || typeof estimate !== 'object'
    || !sameStringSet(Object.keys(estimate), [
      'availability', 'basis', 'estimator', 'estimatorRevision',
      'inputCharacters', 'inputTextSha256', 'outputCharacters',
      'outputTextSha256', 'interactions', 'totalTokens',
    ])
    || estimate.availability !== 'estimated'
    || ![
      'normalized_openai_request_and_visible_assistant_text',
      'provider_turn_prompt_attachments_and_visible_assistant_text',
    ].includes(estimate.basis)
    || estimate.estimator !== 'o200k_base'
    || typeof estimate.estimatorRevision !== 'string'
    || estimate.estimatorRevision.length < 1
    || !Number.isSafeInteger(estimate.inputCharacters)
    || estimate.inputCharacters < 0
    || !/^[a-f0-9]{64}$/u.test(estimate.inputTextSha256)
    || !Number.isSafeInteger(estimate.outputCharacters)
    || estimate.outputCharacters < 0
    || !/^[a-f0-9]{64}$/u.test(estimate.outputTextSha256)
    || !Array.isArray(estimate.interactions)
    || estimate.interactions.length !== event.attempts.length + 1
    || !Number.isSafeInteger(estimate.totalTokens)
    || estimate.totalTokens < 0
  ) {
    throw new Error('Provider token estimate evidence is invalid or unavailable.')
  }
  let totalTokens = 0
  for (const [index, interaction] of estimate.interactions.entries()) {
    const expected = index < event.attempts.length ? event.attempts[index] : event
    if (
      !interaction
      || typeof interaction !== 'object'
      || !sameStringSet(Object.keys(interaction), [
        'provider', 'outcome', 'observedAt', 'providerSubmitted',
        'inputTokens', 'outputTokens', 'totalTokens',
      ])
      || interaction.provider !== expected.provider
      || interaction.outcome !== (index < event.attempts.length ? 'fallback' : event.outcome)
      || interaction.observedAt !== expected.observedAt
      || interaction.providerSubmitted !== expected.providerSubmitted
      || !Number.isSafeInteger(interaction.inputTokens)
      || interaction.inputTokens < 0
      || !Number.isSafeInteger(interaction.outputTokens)
      || interaction.outputTokens < 0
      || !Number.isSafeInteger(interaction.totalTokens)
      || interaction.totalTokens !== interaction.inputTokens + interaction.outputTokens
      || !interaction.providerSubmitted && interaction.totalTokens !== 0
      || index < event.attempts.length && interaction.outputTokens !== 0
      || index === event.attempts.length && event.outcome === 'failed' && interaction.outputTokens !== 0
    ) {
      throw new Error('Provider interaction token estimate is invalid.')
    }
    totalTokens += interaction.totalTokens
  }
  if (totalTokens !== estimate.totalTokens) {
    throw new Error('Provider interaction token estimate total is invalid.')
  }
}

function emptyProviderRoutingCounts() {
  return {
    routed: 0,
    attempted: 0,
    submitted: 0,
    rateLimited: 0,
    fallbackOut: 0,
    completed: 0,
    failed: 0,
    preferenceRequested: 0,
    preferenceHonored: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedTotalTokens: 0,
  }
}

function providerRoutingStats(events) {
  const scopes = { parent: {}, child: {} }
  for (const event of events) {
    if (event.type !== 'provider.routing') continue
    const providers = scopes[event.scope]
    const finalEstimate = event.tokenEstimate.interactions.at(-1)
    const current = providers[event.provider] ?? emptyProviderRoutingCounts()
    current.routed += 1
    current.attempted += 1
    if (event.providerSubmitted) current.submitted += 1
    if (event.rateLimited) current.rateLimited += 1
    if (event.outcome === 'completed') current.completed += 1
    else current.failed += 1
    current.estimatedInputTokens += finalEstimate.inputTokens
    current.estimatedOutputTokens += finalEstimate.outputTokens
    current.estimatedTotalTokens += finalEstimate.totalTokens
    providers[event.provider] = current
    for (const [index, attempt] of event.attempts.entries()) {
      const tokenEstimate = event.tokenEstimate.interactions[index]
      const attempted = providers[attempt.provider] ?? emptyProviderRoutingCounts()
      attempted.routed += 1
      attempted.attempted += 1
      if (attempt.providerSubmitted) attempted.submitted += 1
      attempted.fallbackOut += 1
      attempted.failed += 1
      if (attempt.reason === 'rate_limit') attempted.rateLimited += 1
      attempted.estimatedInputTokens += tokenEstimate.inputTokens
      attempted.estimatedOutputTokens += tokenEstimate.outputTokens
      attempted.estimatedTotalTokens += tokenEstimate.totalTokens
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

function limitObservationEvents(events) {
  const observed = []
  for (const event of events) {
    if (event.type !== 'provider.routing') continue
    for (const [index, attempt] of event.attempts.entries()) {
      if (attempt.reason !== 'rate_limit' && attempt.visibleProof === undefined) continue
      observed.push({
        scope: event.scope,
        provider: attempt.provider,
        observedAt: attempt.observedAt,
        reason: attempt.reason,
        providerSubmitted: attempt.providerSubmitted,
        visibleProof: attempt.visibleProof ?? null,
        limitWindow: attempt.limitWindow ?? null,
        retryAfterSeconds: attempt.retryAfterSeconds ?? null,
        estimatedTokens: event.tokenEstimate.interactions[index].totalTokens,
      })
    }
    if (event.visibleProof === null) continue
    observed.push({
      scope: event.scope,
      provider: event.provider,
      observedAt: event.observedAt,
      reason: event.rateLimited ? 'rate_limit' : 'capacity',
      providerSubmitted: event.providerSubmitted,
      visibleProof: event.visibleProof,
      limitWindow: event.limitWindow,
      retryAfterSeconds: event.retryAfterSeconds,
      estimatedTokens: event.tokenEstimate.interactions.at(-1).totalTokens,
    })
  }
  return observed
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
  const limitEvents = trials.flatMap((trial) => trial.limitObservations.map((event) => ({
    trial: trial.trial,
    ...event,
  }))).sort((left, right) => left.observedAt.localeCompare(right.observedAt) || left.trial.localeCompare(right.trial))
  const estimated = Object.values(scopes).flatMap((scope) => Object.values(scope.providers))
  const estimatorRevisions = new Set(
    trials
      .map((trial) => trial.tokenEstimatorRevision)
      .filter((revisionValue) => revisionValue !== null && revisionValue !== undefined),
  )
  if (trials.length === 0) {
    return {
      protocol: revision.routingProtocol,
      mode: 'not_applicable',
      tokenUsage: { availability: 'not_applicable' },
      limitObservations: { events: [], count: 0 },
      scopes,
    }
  }
  if (estimatorRevisions.size === 0) {
    return {
      protocol: revision.routingProtocol,
      mode: 'not_applicable',
      tokenUsage: { availability: 'not_applicable' },
      limitObservations: { events: limitEvents, count: limitEvents.length },
      scopes,
    }
  }
  if (estimatorRevisions.size !== 1) {
    throw new Error('Terminal-Bench token estimates must use one estimator revision for the run.')
  }
  return {
    protocol: revision.routingProtocol,
    mode: 'auto',
    tokenUsage: {
      availability: 'estimated',
      estimator: 'o200k_base',
      estimatorRevision: [...estimatorRevisions][0],
      basis: 'serialized benchmark interaction input and visible assistant output; not provider billing usage',
      interactions: estimated.reduce((sum, counts) => sum + counts.attempted, 0),
      submittedInteractions: estimated.reduce((sum, counts) => sum + counts.submitted, 0),
      inputTokens: estimated.reduce((sum, counts) => sum + counts.estimatedInputTokens, 0),
      outputTokens: estimated.reduce((sum, counts) => sum + counts.estimatedOutputTokens, 0),
      totalTokens: estimated.reduce((sum, counts) => sum + counts.estimatedTotalTokens, 0),
    },
    limitObservations: {
      events: limitEvents,
      count: limitEvents.length,
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
    TZ: 'UTC',
    PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  }
}

function datasetIdentity() {
  return `${revision.dataset}@${revision.datasetRef}`
}

async function jobsDirectory(args) {
  const resultsDirectory = path.resolve(benchmarkRoot, 'results')
  const jobsDirectory = path.resolve(option(args, '--jobs-dir') ?? resultsDirectory)
  const relative = path.relative(resultsDirectory, jobsDirectory)
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`--jobs-dir must be within ${resultsDirectory}.`)
  }
  await rejectSymlinkComponents(resultsDirectory, jobsDirectory)
  return jobsDirectory
}

async function existingJobDirectory(args) {
  const resultsDirectory = path.resolve(benchmarkRoot, 'results')
  const jobDir = path.resolve(requiredOption(args, '--job-dir'))
  const relative = path.relative(resultsDirectory, jobDir)
  if (
    relative === ''
    || relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`--job-dir must be an existing direct or nested job directory within ${resultsDirectory}.`)
  }
  const components = relative.split(path.sep)
  if (components.some((component) => !JOB_NAME_PATTERN.test(component))) {
    throw new Error('--job-dir components must be safe basenames of up to 64 ASCII letters, digits, dot, underscore, or hyphen.')
  }
  await rejectSymlinkComponents(resultsDirectory, jobDir, '--job-dir')
  let stat
  try {
    stat = await fs.stat(jobDir)
  } catch {
    throw new Error(`--job-dir does not exist: ${jobDir}.`)
  }
  if (!stat.isDirectory()) throw new Error(`--job-dir is not a directory: ${jobDir}.`)
  return jobDir
}

function uniqueJobName(kind) {
  return `tokenless-tb4-${kind}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`
}

function resolveJobName(args, kind) {
  const jobName = option(args, '--job-name') ?? uniqueJobName(kind)
  if (!JOB_NAME_PATTERN.test(jobName)) {
    throw new Error('--job-name must be one safe basename of up to 64 ASCII letters, digits, dot, underscore, or hyphen.')
  }
  return jobName
}

async function rejectSymlinkComponents(baseDirectory, targetDirectory, optionName = '--jobs-dir') {
  const relative = path.relative(baseDirectory, targetDirectory)
  let current = baseDirectory
  const components = relative === '' ? [] : relative.split(path.sep)
  for (const component of ['', ...components]) {
    if (component !== '') current = path.join(current, component)
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error(`${optionName} cannot contain a symbolic link: ${current}.`)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
  }
}

async function refuseExisting(target) {
  if (await exists(target)) throw new Error(`Refusing to overwrite existing benchmark evidence: ${target}`)
}

async function optionalFileEvidence(filePath, label) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return { availability: 'unavailable', reason: `${label.replace(/\s+/gu, '_')}_missing`, path: null, sha256: null, bytes: null }
  }
  try {
    const bytes = await fs.readFile(filePath)
    return {
      availability: 'observed',
      path: path.relative(root, filePath).startsWith('..') ? path.basename(filePath) : path.relative(root, filePath).split(path.sep).join('/'),
      sha256: sha256Value(bytes),
      bytes: bytes.byteLength,
    }
  } catch (error) {
    return {
      availability: 'unavailable',
      reason: safeErrorCode(error, `${label.replace(/\s+/gu, '_')}_unavailable`),
      path: path.basename(filePath),
      sha256: null,
      bytes: null,
    }
  }
}

function sha256Value(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function canonicalJson(value) {
  return JSON.stringify(sortJsonValue(value))
}

function sortJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortJsonValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, sortJsonValue(entry)]))
}

function splitNullEntries(value) {
  return String(value).split('\0').filter((entry) => entry.length > 0)
}

function safeLoopbackOrigin(value) {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return null
    return `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`
  } catch {
    return null
  }
}

function safeErrorCode(error, fallback) {
  const code = typeof error?.code === 'string' ? error.code.toLowerCase() : ''
  return /^[a-z0-9_-]{1,64}$/u.test(code) ? code : fallback
}

function sortedStrings(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string').sort()
    : []
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
  return `Terminal-Bench 4.0 DeepSeek Harness lane\n\n` +
    `Commands:\n` +
    `  inspect\n` +
    `  prepare --dsh-checkout <path>\n` +
    `  observe --job-dir <existing-results-job-dir>\n` +
    `  oracle [--task terminal-bench/<name>] [--jobs-dir <path>]\n` +
    `  wiring --home <path> --dsh-checkout <path> --profile <id> --semantic-manifest <path> [--task terminal-bench/<name>] [--jobs-dir <path>]\n` +
    `  sweep --home <path> --dsh-checkout <path> --profile <id> --semantic-manifest <path> [--jobs-dir <path>]\n` +
    `  full --home <path> --dsh-checkout <path> --profile <id> --semantic-manifest <path> [--jobs-dir <path>]\n\n` +
    `  Default jobs directory: benchmarks/terminalbench/results; explicit --jobs-dir must stay within it.\n` +
    `  observe writes benchmarks/terminalbench/observations/<job-name>/run-observation.json and never overwrites evidence.\n` +
    `The sweep command is a fixed ${revision.taskCount}-task, k=1 phase gate; full is fixed to Harbor ${revision.harborVersion}, the ${revision.taskCount}-task Terminal-Bench 4.0 dataset, k=5, one concurrent trial, and zero Harbor retries.\n`
}
