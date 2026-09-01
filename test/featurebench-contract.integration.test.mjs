import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const cliEntry = path.resolve('packages', 'cli', 'dist', 'src', 'tokenless.mjs')
const scriptEntry = path.resolve('scripts', 'featurebench.mjs')
const expected = {
  benchmarkCommit: '445dcbaec0b2e136061b0acb54e753c0a9f1888e',
  datasetRevision: 'e99d6efdfe511ea832c1b5735c536129561ec96a',
  wiringTask: 'pypa__packaging.013f3b03.test_metadata.e00b5801.lv1',
}

test('built CLI and benchmark orchestrator expose the same pinned FeatureBench contract', async () => {
  const [cli, script] = await Promise.all([
    jsonProcess([cliEntry, 'featurebench', 'inspect', '--json']),
    jsonProcess([scriptEntry, 'inspect', '--json']),
  ])

  assert.equal(cli.ok, true)
  assert.equal(script.ok, true)
  assert.equal(cli.benchmarkCommit, expected.benchmarkCommit)
  assert.equal(script.benchmarkCommit, expected.benchmarkCommit)
  assert.equal(cli.datasetRevision, expected.datasetRevision)
  assert.equal(script.datasetRevision, expected.datasetRevision)
  assert.equal(cli.attemptsPerTask, 1)
  assert.equal(script.attemptsPerTask, 1)
  assert.equal(cli.splits.full.tasks, 200)
  assert.equal(script.splits.full.tasks, 200)
  assert.equal(script.splits.full.images, 24)
  assert.equal(script.splits.full.official, true)
  assert.equal(script.splits.fast.official, false)
  assert.equal(cli.wiringTasks[0], expected.wiringTask)
  assert.equal(script.wiringTasks[0], expected.wiringTask)
})

test('built CLI rejects an unscoped FeatureBench container run', async () => {
  await assert.rejects(
    execFileAsync(process.execPath, [cliEntry, 'featurebench', 'run', '--json'], { encoding: 'utf8' }),
    (error) => {
      const payload = JSON.parse(error.stdout)
      assert.equal(payload.ok, false)
      assert.match(payload.error.message, /--channel-file is required/)
      return true
    },
  )
})

async function jsonProcess(arguments_) {
  const result = await execFileAsync(process.execPath, arguments_, {
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
  })
  return JSON.parse(result.stdout)
}
