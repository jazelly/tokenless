import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'scripts', 'code-benchmark.mjs')

test('code benchmark command validates and lists the pinned standalone collection', () => {
  const validated = run(['validate'])
  assert.equal(validated.status, 0, validated.stderr)
  assert.deepEqual(JSON.parse(validated.stdout), {
    ok: true,
    schema: 'tokenless.code-benchmark-collection.v1',
    revision: '2026-08-10',
    taskCount: 26,
    benchmarkCounts: {
      LiveCodeBench: 12,
      'BigCodeBench-Instruct': 6,
      'EvalPlus MBPP+': 4,
      CRUXEval: 4,
    },
    collectionCounts: {
      'code-smoke': 8,
      'code-core': 20,
      'code-agent': 0,
    },
    vendoredPromptCount: 14,
    referenceOnlyPromptCount: 12,
  })

  const listed = run(['list', '--collection', 'code-core'])
  assert.equal(listed.status, 0, listed.stderr)
  const payload = JSON.parse(listed.stdout)
  assert.equal(payload.count, 20)
  assert.equal(payload.tasks.every((task) => task.collections.includes('code-core')), true)
  assert.equal(payload.tasks.every((task) => task.evaluator.length > 0), true)
})

test('provider-bound smoke prompt resolves by stable task ID without a correlation marker', () => {
  const result = run(['prompt', '--task', 'bigcodebench:v0.1.4:4', '--json'])
  assert.equal(result.status, 0, result.stderr)
  const payload = JSON.parse(result.stdout)
  assert.equal(payload.ok, true)
  assert.equal(payload.task.upstreamTaskId, 'BigCodeBench/4')
  assert.equal(payload.task.promptAvailability, 'vendored')
  assert.match(payload.prompt, /from collections import Counter/)
  assert.doesNotMatch(payload.prompt, /TOKENLESS_|reply with exactly|respond with exactly/iu)
})

function run(args) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
}
