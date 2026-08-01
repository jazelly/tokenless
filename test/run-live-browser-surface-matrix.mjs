import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const surfaceTest = path.join(root, 'test/live-browser-provider-surfaces.e2e.mjs')
const supportedSelections = Object.freeze(['auto', 'managed-chromium', 'cloak'])
const selections = resolveSelections(process.argv.slice(2))
const suppliedHome = process.env.TOKENLESS_LIVE_BROWSER_SURFACE_HOME
const temporaryRoot = await fs.realpath(os.tmpdir())
const homeDir = suppliedHome
  ? path.resolve(suppliedHome)
  : await fs.mkdtemp(path.join(temporaryRoot, 'tokenless-browser-surface-matrix-'))
const ownsHome = !suppliedHome
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
  for (const selection of selections) {
    const result = await runSelection(selection)
    if (result.code !== 0) failed = true
    if (interruptedSignal) break
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  if (ownsHome) await fs.rm(homeDir, { recursive: true, force: true })
}

if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
else if (failed) process.exitCode = 1

function runSelection(selection) {
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
        TOKENLESS_LIVE_BROWSER_SURFACE_HOME: homeDir,
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

function resolveSelections(arguments_) {
  if (arguments_.length === 0) return supportedSelections
  if (arguments_.length !== 2 || arguments_[0] !== '--selection') {
    failUsage('Expected exactly --selection <browser>')
  }
  const selection = arguments_[1]
  if (!supportedSelections.includes(selection)) {
    failUsage(`Unsupported browser selection: ${selection}`)
  }
  return Object.freeze([selection])
}

function failUsage(message) {
  console.error(message)
  console.error(`Usage: node test/run-live-browser-surface-matrix.mjs [--selection ${supportedSelections.join('|')}]`)
  process.exit(2)
}
