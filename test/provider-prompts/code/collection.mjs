import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const directory = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.join(directory, 'manifest.json')
const schemaPath = path.join(directory, 'manifest.schema.json')
const promptsPath = path.join(directory, 'prompts.json')
const expectedBenchmarkCounts = {
  LiveCodeBench: 12,
  'BigCodeBench-Instruct': 6,
  'EvalPlus MBPP+': 4,
  CRUXEval: 4,
}
const expectedCollectionCounts = {
  'code-smoke': 8,
  'code-core': 20,
  'code-agent': 0,
}

let loaded

export function loadCodeBenchmarkCollection() {
  if (loaded) return loaded
  const manifest = readJson(manifestPath)
  const schema = readJson(schemaPath)
  const prompts = readJson(promptsPath)
  const ajv = new Ajv2020({ allErrors: true, strict: true })
  addFormats(ajv)
  const validate = ajv.compile(schema)
  if (!validate(manifest)) {
    throw new Error(`Code benchmark manifest schema validation failed:\n${ajv.errorsText(validate.errors, { separator: '\n' })}`)
  }

  const ids = new Set()
  const vendoredPromptKeys = new Set()
  for (const task of manifest.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate code benchmark task ID: ${task.id}`)
    ids.add(task.id)
    if (task.prompt.mode === 'vendored') {
      if (task.source.redistribution !== 'vendored') {
        throw new Error(`Vendored prompt ${task.id} must declare vendored redistribution`)
      }
      const licenseValues = [task.source.repositoryLicense, task.source.datasetLicense, task.source.contentLicense]
      if (licenseValues.includes('unknown')) throw new Error(`Vendored prompt ${task.id} has an unknown license boundary`)
      if (vendoredPromptKeys.has(task.prompt.key)) throw new Error(`Duplicate vendored prompt key: ${task.prompt.key}`)
      vendoredPromptKeys.add(task.prompt.key)
      const artifact = prompts[task.prompt.key]
      if (!artifact) throw new Error(`Missing vendored prompt ${task.prompt.key}`)
      if (!artifact.original?.trim() || !artifact.rendered?.trim()) {
        throw new Error(`Vendored prompt ${task.prompt.key} must preserve original and rendered text`)
      }
      assertHash(artifact.rendered, task.prompt.sha256, `prompt ${task.id}`)
    } else {
      if (task.source.redistribution !== 'reference_only') {
        throw new Error(`Reference-only prompt ${task.id} must declare reference_only redistribution`)
      }
      if (task.source.datasetLicense !== 'unknown' && task.source.contentLicense !== 'unknown') {
        throw new Error(`Reference-only prompt ${task.id} does not document an unknown content boundary`)
      }
    }
    if (task.taskType === 'self_repair') {
      const inputKinds = task.inputs.map((input) => input.kind).sort()
      if (inputKinds.join(',') !== 'evaluator_feedback,prior_candidate') {
        throw new Error(`Self-repair task ${task.id} must pin candidate and evaluator feedback`)
      }
    } else if (task.inputs.length !== 0) {
      throw new Error(`Standalone task ${task.id} has unexpected inputs`)
    }
    if (task.collections.includes('code-agent')) {
      throw new Error(`Standalone task ${task.id} cannot enter code-agent`)
    }
  }

  for (const key of Object.keys(prompts)) {
    if (!vendoredPromptKeys.has(key)) throw new Error(`Unreferenced vendored prompt artifact: ${key}`)
  }

  assertCounts(manifest.tasks, expectedBenchmarkCounts, (task) => task.benchmark, 'benchmark')
  assertCounts(
    manifest.tasks.flatMap((task) => task.collections.map((collection) => ({ collection }))),
    expectedCollectionCounts,
    (entry) => entry.collection,
    'collection',
  )
  if (manifest.collections['code-agent'].enabled) throw new Error('code-agent must remain disabled without repository-complete tasks')

  loaded = Object.freeze({ manifest, prompts, tasks: Object.freeze([...manifest.tasks]) })
  return loaded
}

export function listCodeBenchmarkTasks({ collection, benchmark, availableOnly = false } = {}) {
  return loadCodeBenchmarkCollection().tasks.filter((task) => (
    (!collection || task.collections.includes(collection)) &&
    (!benchmark || task.benchmark === benchmark) &&
    (!availableOnly || task.prompt.mode === 'vendored')
  ))
}

export function getCodeBenchmarkTask(taskId) {
  const task = loadCodeBenchmarkCollection().tasks.find((entry) => entry.id === taskId)
  if (!task) throw new Error(`Unknown code benchmark task ID: ${taskId}`)
  return task
}

export function getVendoredCodeBenchmarkPrompt(taskId) {
  const { prompts } = loadCodeBenchmarkCollection()
  const task = getCodeBenchmarkTask(taskId)
  if (task.prompt.mode !== 'vendored') {
    throw new Error(`Task ${taskId} is reference-only; run the explicit materialize command before reading its prompt`)
  }
  return prompts[task.prompt.key].rendered
}

export function codeBenchmarkSummary() {
  const { manifest, tasks } = loadCodeBenchmarkCollection()
  return {
    schema: manifest.schema,
    revision: manifest.revision,
    taskCount: tasks.length,
    benchmarkCounts: countBy(tasks, (task) => task.benchmark),
    collectionCounts: Object.fromEntries(Object.keys(manifest.collections).map((collection) => [
      collection,
      tasks.filter((task) => task.collections.includes(collection)).length,
    ])),
    vendoredPromptCount: tasks.filter((task) => task.prompt.mode === 'vendored').length,
    referenceOnlyPromptCount: tasks.filter((task) => task.prompt.mode === 'reference_only').length,
  }
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function assertHash(value, expected, label) {
  const actual = sha256(value)
  if (actual !== expected) throw new Error(`${label} hash mismatch: expected ${expected}, received ${actual}`)
}

function assertCounts(entries, expected, select, label) {
  const actual = countBy(entries, select)
  for (const [key, count] of Object.entries(expected)) {
    if ((actual[key] ?? 0) !== count) {
      throw new Error(`Unexpected ${label} count for ${key}: expected ${count}, received ${actual[key] ?? 0}`)
    }
  }
}

function countBy(entries, select) {
  const counts = {}
  for (const entry of entries) {
    const key = select(entry)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'))
}
