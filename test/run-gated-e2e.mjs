import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [suite, ...suiteArguments] = process.argv.slice(2)
const definition = resolveDefinition(suite, suiteArguments)
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
  const child = spawn(process.execPath, [
    '--test',
    '--test-concurrency=1',
    definition.testPath,
  ], {
    cwd: root,
    env: {
      ...process.env,
      ...definition.environment,
    },
    stdio: 'inherit',
  })
  activeChild = child
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  activeChild = null
  if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
  else if (result.signal) process.exitCode = 1
  else process.exitCode = result.code ?? 1
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

function resolveDefinition(name, arguments_) {
  if (name === 'managed-playwright') {
    if (arguments_.length !== 1) {
      failUsage('managed-playwright requires exactly one gate argument')
    }
    const gate = arguments_[0]
    const supportedGates = new Set(['all', 'non_submission', 'mutation', 'project'])
    if (!gate || !supportedGates.has(gate)) {
      failUsage(`managed-playwright requires one of: ${[...supportedGates].join(', ')}`)
    }
    return {
      testPath: 'test/live-managed-playwright.e2e.mjs',
      environment: { TOKENLESS_LIVE_E2E_GATE: gate },
    }
  }

  if (name === 'provider-fallback') {
    if (arguments_.length !== 0) failUsage('provider-fallback does not accept a gate argument')
    return {
      testPath: 'test/live-provider-fallback.e2e.mjs',
      environment: { TOKENLESS_LIVE_FALLBACK_E2E_GATE: 'real-provider-fallback' },
    }
  }

  if (name === 'web-ui-provider') {
    if (arguments_.length !== 0) failUsage('web-ui-provider does not accept arguments')
    return {
      testPath: 'test/live-web-ui-provider.e2e.mjs',
      environment: { TOKENLESS_LIVE_WEB_UI_GATE: 'representative-provider' },
    }
  }

  if (name === 'featurebench') {
    if (arguments_.length !== 2) failUsage('featurebench requires <provider> <browser|direct>')
    const [provider, executionMode] = arguments_
    if (!provider || (executionMode !== 'browser' && executionMode !== 'direct')) {
      failUsage('featurebench requires <provider> <browser|direct>')
    }
    return {
      testPath: 'test/live-featurebench.e2e.mjs',
      environment: {
        TOKENLESS_LIVE_FEATUREBENCH_GATE: 'real-featurebench',
        TOKENLESS_FEATUREBENCH_PROVIDER: provider,
        TOKENLESS_FEATUREBENCH_EXECUTION_MODE: executionMode,
      },
    }
  }

  failUsage('suite must be managed-playwright, provider-fallback, web-ui-provider, or featurebench')
}

function failUsage(message) {
  console.error(message)
  console.error('Usage: node test/run-gated-e2e.mjs managed-playwright <all|non_submission|mutation|project>')
  console.error('   or: node test/run-gated-e2e.mjs provider-fallback')
  console.error('   or: node test/run-gated-e2e.mjs web-ui-provider')
  console.error('   or: node test/run-gated-e2e.mjs featurebench <provider> <browser|direct>')
  process.exit(2)
}
