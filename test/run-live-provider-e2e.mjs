import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfiguredBrowserTarget } from './helpers/configured-browser-profile.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArguments(process.argv.slice(2))
let activeChild = null
let interruptedSignal = null

const interrupt = (signal) => {
  interruptedSignal = signal
  activeChild?.kill(signal)
}
const onSigint = () => interrupt('SIGINT')
const onSigterm = () => interrupt('SIGTERM')
process.once('SIGINT', onSigint)
process.once('SIGTERM', onSigterm)

try {
  const target = await resolveConfiguredBrowserTarget()
  reportTarget(target)
  if (options.command === 'status') {
    process.exitCode = 0
  } else if (options.command === 'web-ui') {
    process.exitCode = await runInherited(process.execPath, [
      'test/run-gated-e2e.mjs',
      'web-ui-provider',
    ], {
      ...process.env,
      TOKENLESS_LIVE_E2E_GATE: options.gate,
    })
  } else {
    process.exitCode = await runInherited(process.execPath, [
      'test/run-gated-e2e.mjs',
      'managed-playwright',
      options.gate,
    ], {
      ...process.env,
      TOKENLESS_LIVE_E2E_GATE: options.gate,
    })
  }
} catch (error) {
  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  else {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

function reportTarget(target) {
  console.log('Live provider E2E target:')
  console.log(`  config: ${target.configPath}`)
  console.log(`  profile: ${target.profile.slug}`)
  console.log(`  directory: browser/profiles/${target.relativeDirectory}`)
  console.log(`  browser: ${target.runtime.selection}`)
  console.log(`  runtime: ${target.runtime.runtimeId}`)
}

function runInherited(command, arguments_, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: root,
      env: environment,
      stdio: 'inherit',
    })
    activeChild = child
    child.once('error', reject)
    child.once('close', (status, signal) => {
      if (activeChild === child) activeChild = null
      resolve(interruptedSignal ? (interruptedSignal === 'SIGINT' ? 130 : 143) : status ?? (signal ? 1 : 0))
    })
  })
}

function parseArguments(arguments_) {
  const command = arguments_[0]
  if (!['run', 'web-ui', 'status'].includes(command)) failUsage()
  const parsed = { command, gate: 'all' }
  for (let index = 1; index < arguments_.length; index += 1) {
    if (arguments_[index] !== '--gate') failUsage(`Unsupported argument '${arguments_[index]}'.`)
    const gate = arguments_[index + 1]
    if (!gate || gate.startsWith('--')) failUsage('--gate requires a value.')
    parsed.gate = gate
    index += 1
  }
  if (!['all', 'non_submission', 'mutation', 'project'].includes(parsed.gate)) {
    failUsage('Gate must be all, non_submission, mutation, or project.')
  }
  return parsed
}

function failUsage(message) {
  if (message) console.error(message)
  console.error('Usage: node test/run-live-provider-e2e.mjs <run|web-ui|status> [--gate <all|non_submission|mutation|project>]')
  process.exit(2)
}
