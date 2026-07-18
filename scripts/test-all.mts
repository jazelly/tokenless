import { spawnSync } from 'node:child_process'
import { globSync } from 'node:fs'

const testFiles = globSync('test/**/*.test.mjs').sort()
if (testFiles.length === 0) throw new Error('No Tokenless test files were found.')

const result = spawnSync(process.execPath, [
  '--test',
  '--test-concurrency=1',
  ...testFiles,
], {
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exitCode = result.status ?? 1
