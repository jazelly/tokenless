import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export const FEATUREBENCH_WIRING_TASK = 'pypa__packaging.013f3b03.test_metadata.e00b5801.lv1'
export const FEATUREBENCH_COMMIT = '445dcbaec0b2e136061b0acb54e753c0a9f1888e'
export const FEATUREBENCH_DATASET_REVISION = 'e99d6efdfe511ea832c1b5735c536129561ec96a'

export async function runFeatureBenchProviderCase({
  provider,
  executionMode,
  homeDir,
  profile,
  daemonUrl,
  model = 'provider-default',
  effort,
  task = FEATUREBENCH_WIRING_TASK,
}) {
  const checkout = requiredEnvironment('TOKENLESS_FEATUREBENCH_CHECKOUT')
  const outputRoot = path.resolve(process.env.TOKENLESS_FEATUREBENCH_OUTPUT_DIR?.trim() || path.join(checkout, 'runs'))
  await fs.mkdir(outputRoot, { recursive: true })
  const before = new Set(await directoryNames(outputRoot))
  const runId = `live_featurebench_${randomUUID()}`
  const args = [
    path.resolve('scripts', 'featurebench.mjs'),
    'wiring',
    '--checkout', checkout,
    '--output-dir', outputRoot,
    '--home', homeDir,
    '--profile', profile,
    '--provider', provider,
    '--execution-mode', executionMode,
    '--model', model,
    '--task', task,
    '--run-id', runId,
    '--n-concurrent', '1',
    '--eval-concurrent', '1',
    '--timeout', process.env.TOKENLESS_FEATUREBENCH_TASK_TIMEOUT?.trim() || '7200',
    '--max-steps', process.env.TOKENLESS_FEATUREBENCH_MAX_STEPS?.trim() || '40',
    '--tool-timeout-ms', process.env.TOKENLESS_FEATUREBENCH_TOOL_TIMEOUT_MS?.trim() || '120000',
    '--provider-turn-timeout-ms', process.env.TOKENLESS_FEATUREBENCH_PROVIDER_TURN_TIMEOUT_MS?.trim() || '600000',
    ...(daemonUrl ? ['--daemon-url', daemonUrl] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(process.env.TOKENLESS_FEATUREBENCH_CHANNEL_HOST?.trim()
      ? ['--channel-host', process.env.TOKENLESS_FEATUREBENCH_CHANNEL_HOST.trim()]
      : []),
    ...(process.env.TOKENLESS_FEATUREBENCH_HF_OFFLINE?.trim() === '1' ? ['--offline-cache'] : []),
  ]
  await run(process.execPath, args)

  for (const directory of await newDirectories(outputRoot, before)) {
    const reportPath = path.join(directory, 'tokenless-run.json')
    try {
      const report = JSON.parse(await fs.readFile(reportPath, 'utf8'))
      if (report.runId === runId) return { report, reportPath, runDir: directory }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  throw new Error(`FeatureBench run ${runId} completed without a matching tokenless-run.json report.`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: path.resolve('.'),
      env: process.env,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`FeatureBench process failed with ${signal ?? `exit code ${code ?? 1}`}.`))
    })
  })
}

async function directoryNames(parent) {
  return (await fs.readdir(parent, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

async function newDirectories(parent, before) {
  const directories = []
  for (const name of await directoryNames(parent)) {
    if (before.has(name)) continue
    const full = path.join(parent, name)
    directories.push({ full, mtime: (await fs.stat(full)).mtimeMs })
  }
  directories.sort((left, right) => right.mtime - left.mtime)
  return directories.map((entry) => entry.full)
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required.`)
  return value
}
