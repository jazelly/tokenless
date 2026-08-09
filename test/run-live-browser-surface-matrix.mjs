import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const surfaceTest = path.join(root, 'test/live-browser-provider-surfaces.e2e.mjs')
const supportedSelections = Object.freeze(['chrome', 'managed-chromium', 'cloak'])
const supportedVisibilities = Object.freeze(['headed', 'headless'])
const options = resolveOptions(process.argv.slice(2))
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

let failed = false
try {
  for (const visibility of options.visibilities) {
    const result = await runSelection(options.selection, visibility)
    if (result.code !== 0) failed = true
    if (interruptedSignal) break
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
else if (failed) process.exitCode = 1

function runSelection(selection, visibility) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--test',
      '--test-concurrency=1',
      surfaceTest,
    ], {
      cwd: root,
      env: {
        ...process.env,
        TOKENLESS_LIVE_BROWSER_SURFACE_GATE: '1',
        TOKENLESS_LIVE_BROWSER_SURFACE_SELECTION: selection,
        TOKENLESS_LIVE_BROWSER_SURFACE_VISIBILITY: visibility,
      },
      stdio: 'inherit',
    })
    activeChild = child
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (activeChild === child) activeChild = null
      resolve({ code: code ?? (signal ? 1 : 0), signal })
    })
  })
}

function resolveOptions(arguments_) {
  let selection = 'chrome'
  let visibility = 'headed'
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!value) failUsage(`${flag ?? 'argument'} requires a value`)
    if (flag === '--selection') selection = value
    else if (flag === '--visibility') visibility = value
    else failUsage(`Unsupported argument: ${flag}`)
  }
  if (!supportedSelections.includes(selection)) {
    failUsage(`Unsupported browser selection: ${selection}`)
  }
  if (!supportedVisibilities.includes(visibility)) {
    failUsage(`Unsupported browser visibility: ${visibility}`)
  }
  return Object.freeze({
    selection,
    visibilities: Object.freeze([visibility]),
  })
}

function failUsage(message) {
  console.error(message)
  console.error(
    `Usage: node test/run-live-browser-surface-matrix.mjs ` +
    `[--selection ${supportedSelections.join('|')}] ` +
    `[--visibility ${supportedVisibilities.join('|')}]`,
  )
  process.exit(2)
}
