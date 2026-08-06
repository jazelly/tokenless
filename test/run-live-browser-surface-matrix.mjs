import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const surfaceTest = path.join(root, 'test/live-browser-provider-surfaces.e2e.mjs')
const defaultSelections = Object.freeze(['auto', 'managed-chromium', 'cloak'])
const supportedSelections = Object.freeze(['auto', 'chrome', 'managed-chromium', 'cloak'])
const supportedVisibilities = Object.freeze(['headed', 'headless'])
const options = resolveOptions(process.argv.slice(2))
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
  for (const visibility of options.visibilities) {
    for (const selection of options.selections) {
      const result = await runSelection(selection, visibility)
      if (result.code !== 0) failed = true
      if (interruptedSignal) break
    }
    if (interruptedSignal) break
  }
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
  if (ownsHome) await fs.rm(homeDir, { recursive: true, force: true })
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
        ...(options.fallback === null
          ? {}
          : { TOKENLESS_LIVE_BROWSER_SURFACE_FALLBACK_SELECTION: options.fallback }),
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

function resolveOptions(arguments_) {
  let selection = null
  let visibility = 'headed'
  let fallback = null
  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index]
    const value = arguments_[index + 1]
    if (!value) failUsage(`${flag ?? 'argument'} requires a value`)
    if (flag === '--selection') selection = value
    else if (flag === '--visibility') visibility = value
    else if (flag === '--fallback') fallback = value
    else failUsage(`Unsupported argument: ${flag}`)
  }
  if (selection !== null && !supportedSelections.includes(selection)) {
    failUsage(`Unsupported browser selection: ${selection}`)
  }
  if (!supportedVisibilities.includes(visibility)) {
    failUsage(`Unsupported browser visibility: ${visibility}`)
  }
  if (fallback !== null && !supportedSelections.includes(fallback)) {
    failUsage(`Unsupported fallback browser selection: ${fallback}`)
  }
  if (fallback !== null && selection === null) {
    failUsage('--fallback requires one explicit --selection')
  }
  if (fallback === selection) {
    failUsage('Fallback browser selection must differ from the primary selection')
  }
  return Object.freeze({
    selections: selection === null ? defaultSelections : Object.freeze([selection]),
    visibilities: Object.freeze([visibility]),
    fallback,
  })
}

function failUsage(message) {
  console.error(message)
  console.error(
    `Usage: node test/run-live-browser-surface-matrix.mjs ` +
    `[--selection ${supportedSelections.join('|')}] ` +
    `[--visibility ${supportedVisibilities.join('|')}] ` +
    `[--fallback ${supportedSelections.join('|')}]`,
  )
  process.exit(2)
}
