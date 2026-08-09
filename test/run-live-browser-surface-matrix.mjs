import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const surfaceTest = path.join(root, 'test/live-browser-provider-surfaces.e2e.mjs')
if (process.argv.length > 2) failUsage()
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
  const result = await runSurfaceTest()
  if (result.code !== 0) failed = true
} finally {
  process.removeListener('SIGINT', onSigint)
  process.removeListener('SIGTERM', onSigterm)
}

if (interruptedSignal) process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 143
else if (failed) process.exitCode = 1

function runSurfaceTest() {
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

function failUsage() {
  console.error('Usage: node test/run-live-browser-surface-matrix.mjs')
  process.exit(2)
}
