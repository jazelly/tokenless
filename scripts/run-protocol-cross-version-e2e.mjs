import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  path.join(root, 'test/protocol-cross-version.e2e.mjs'),
], {
  cwd: root,
  stdio: 'inherit',
  windowsHide: true,
  env: {
    ...process.env,
    TOKENLESS_CROSS_VERSION_E2E: '1',
  },
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
