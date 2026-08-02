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
  if (name === 'browser-runtime') {
    let expectedAuto = process.env.TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO ?? 'system'
    if (arguments_.length > 0) {
      if (arguments_.length !== 2 || arguments_[0] !== '--expected-auto') {
        failUsage('browser-runtime accepts only --expected-auto <system|managed-chromium>')
      }
      expectedAuto = arguments_[1]
    }
    if (expectedAuto !== 'system' && expectedAuto !== 'managed-chromium') {
      failUsage('browser-runtime expected auto family must be system or managed-chromium')
    }
    return {
      testPath: 'test/live-browser-runtime.e2e.mjs',
      environment: {
        TOKENLESS_LIVE_BROWSER_RUNTIME_GATE: '1',
        TOKENLESS_LIVE_BROWSER_RUNTIME_EXPECT_AUTO: expectedAuto,
      },
    }
  }

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
    const options = parseWebUiFixtureArguments(arguments_)
    return {
      testPath: 'test/live-web-ui-provider.e2e.mjs',
      environment: {
        TOKENLESS_LIVE_WEB_UI_GATE: 'representative-provider',
        TOKENLESS_LIVE_WEB_UI_FIXTURE_FILE: options.fixtureFile,
        TOKENLESS_LIVE_WEB_UI_FIXTURE: options.fixture,
      },
    }
  }

  failUsage('suite must be browser-runtime, managed-playwright, provider-fallback, or web-ui-provider')
}

function failUsage(message) {
  console.error(message)
  console.error('Usage: node test/run-gated-e2e.mjs browser-runtime [--expected-auto system|managed-chromium]')
  console.error('   or: node test/run-gated-e2e.mjs managed-playwright <all|non_submission|mutation|project>')
  console.error('   or: node test/run-gated-e2e.mjs provider-fallback')
  console.error('   or: node test/run-gated-e2e.mjs web-ui-provider [--fixture <case-or-suite>] [--fixture-file <path>]')
  process.exit(2)
}

function parseWebUiFixtureArguments(arguments_) {
  let fixture = 'smoke'
  let fixtureFile = path.join(root, 'test/fixtures/local/web-ui.json')
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    const value = arguments_[index + 1]
    if (argument === '--fixture') {
      if (!value || value.startsWith('--')) failUsage('web-ui-provider --fixture requires a case or suite name')
      fixture = value
      index += 1
      continue
    }
    if (argument === '--fixture-file') {
      if (!value || value.startsWith('--')) failUsage('web-ui-provider --fixture-file requires a path')
      fixtureFile = path.resolve(root, value)
      index += 1
      continue
    }
    failUsage(`web-ui-provider does not support '${argument}'`)
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(fixture)) {
    failUsage('web-ui-provider fixture selection must use lowercase letters, numbers, and hyphens')
  }
  return { fixture, fixtureFile }
}
