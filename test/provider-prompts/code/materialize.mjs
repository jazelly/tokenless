import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parquetReadObjects, toJson } from 'hyparquet'

import {
  getCodeBenchmarkTask,
  getVendoredCodeBenchmarkPrompt,
  sha256,
} from './collection.mjs'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const defaultCacheRoot = path.join(repositoryRoot, 'test-results', 'code-benchmark-cache')

export async function materializeCodeBenchmarkTask(taskId, { cacheRoot = defaultCacheRoot } = {}) {
  const task = getCodeBenchmarkTask(taskId)
  const record = task.source.locator.kind === 'parquet_row_offset'
    ? await fetchParquetRecord(task)
    : await fetchJsonlRecord(task)
  validateSourceRecord(task, record.raw, record.value)
  const filename = materializedRecordPath(task.id, cacheRoot)
  await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
  await fs.writeFile(filename, `${JSON.stringify({
    schema: 'tokenless.code-benchmark-materialized-record.v1',
    taskId: task.id,
    sourceRevision: task.source.revision,
    sourceRecordSha256: task.source.recordSha256,
    record: record.value,
  }, null, 2)}\n`, { mode: 0o600 })
  return { taskId: task.id, filename, sourceRevision: task.source.revision }
}

export async function loadMaterializedCodeBenchmarkRecord(taskId, { cacheRoot = defaultCacheRoot } = {}) {
  const task = getCodeBenchmarkTask(taskId)
  const filename = materializedRecordPath(task.id, cacheRoot)
  let artifact
  try {
    artifact = JSON.parse(await fs.readFile(filename, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`Task ${task.id} is not materialized; run: npm run benchmark:code -- materialize --task ${task.id}`)
    }
    throw error
  }
  if (
    artifact.schema !== 'tokenless.code-benchmark-materialized-record.v1' ||
    artifact.taskId !== task.id ||
    artifact.sourceRevision !== task.source.revision ||
    artifact.sourceRecordSha256 !== task.source.recordSha256
  ) {
    throw new Error(`Materialized record metadata does not match manifest for ${task.id}`)
  }
  validateRecordIdentity(task, artifact.record)
  return artifact.record
}

export async function getCodeBenchmarkPrompt(taskId, options) {
  const task = getCodeBenchmarkTask(taskId)
  if (task.prompt.mode === 'vendored') return getVendoredCodeBenchmarkPrompt(task.id)
  const record = await loadMaterializedCodeBenchmarkRecord(task.id, options)
  const sourcePrompt = record[task.prompt.field]
  if (typeof sourcePrompt !== 'string') throw new Error(`Materialized task ${task.id} has no ${task.prompt.field}`)
  if (sha256(sourcePrompt) !== task.prompt.sourceSha256) throw new Error(`Materialized prompt hash mismatch for ${task.id}`)
  return task.taskType === 'self_repair'
    ? renderLiveCodeBenchSelfRepairPrompt(sourcePrompt, task.inputs)
    : renderLiveCodeBenchGenerationPrompt(sourcePrompt, record.starter_code)
}

export function materializedRecordPath(taskId, cacheRoot = defaultCacheRoot) {
  return path.join(cacheRoot, 'records', `${sha256(taskId)}.json`)
}

async function fetchParquetRecord(task) {
  const bytes = await fetchVerifiedArtifact(task)
  const file = {
    byteLength: bytes.byteLength,
    slice(start, end) {
      const chunk = bytes.slice(start, end)
      return Promise.resolve(chunk.buffer)
    },
  }
  const offset = task.source.locator.value
  const rows = await parquetReadObjects({ file, rowStart: offset, rowEnd: offset + 1 })
  const value = toJson(rows[0])
  if (!value) throw new Error(`Pinned Parquet artifact returned no row for ${task.id}`)
  return { raw: JSON.stringify(value), value }
}

async function fetchJsonlRecord(task) {
  const response = await fetch(task.source.artifactUrl)
  if (!response.ok) throw new Error(`Unable to materialize ${task.id}: HTTP ${response.status}`)
  const body = await response.text()
  if (sha256(body) !== task.source.artifactSha256) throw new Error(`Source artifact hash mismatch for ${task.id}`)
  const lines = task.benchmark === 'LiveCodeBench'
    ? splitLiveCodeBenchRecords(body)
    : body.trimEnd().split('\n')
  for (const raw of lines) {
    const value = JSON.parse(raw)
    const id = value.question_id ?? value.id
    if (id === task.source.locator.value) return { raw, value }
  }
  throw new Error(`Source artifact does not contain ${task.source.locator.value}`)
}

async function fetchVerifiedArtifact(task) {
  const response = await fetch(task.source.artifactUrl)
  if (!response.ok) throw new Error(`Unable to fetch source artifact for ${task.id}: HTTP ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (sha256(bytes) !== task.source.artifactSha256) throw new Error(`Source artifact hash mismatch for ${task.id}`)
  return bytes
}

function validateSourceRecord(task, raw, value) {
  if (sha256(raw) !== task.source.recordSha256) throw new Error(`Source record hash mismatch for ${task.id}`)
  validateRecordIdentity(task, value)
}

function validateRecordIdentity(task, value) {
  const id = String(value.question_id ?? value.task_id ?? value.id)
  if (id !== task.upstreamTaskId) throw new Error(`Source record identity mismatch for ${task.id}: received ${id}`)
}

function splitLiveCodeBenchRecords(body) {
  return body.split('\n{"question_title": ').map((part, index) => (
    index === 0 ? part : `{"question_title": ${part}`
  ))
}

function renderLiveCodeBenchGenerationPrompt(question, starterCode) {
  const system = 'You are an expert Python programmer. You will be given a question (problem specification) and will generate a correct Python program that matches the specification and passes all tests.'
  const format = starterCode
    ? `You will use the following starter code to write the solution to the problem and enclose your code within delimiters.\n\`\`\`python\n${starterCode}\n\`\`\``
    : 'Read the inputs from stdin solve the problem and write the answer to stdout (do not directly test on the sample inputs). Enclose your code within delimiters as follows. Ensure that when the python program runs, it reads the inputs, runs the algorithm and writes output to STDOUT.\n```python\n# YOUR CODE HERE\n```'
  return `${system}\n\n### Question:\n${question}\n\n### Format: ${format}\n\n### Answer: (use the provided format with backticks)\n`
}

function renderLiveCodeBenchSelfRepairPrompt(question, inputs) {
  const candidate = inputs.find((input) => input.kind === 'prior_candidate')?.value
  const feedback = inputs.find((input) => input.kind === 'evaluator_feedback')?.value
  if (typeof candidate !== 'string' || !feedback) throw new Error('LiveCodeBench self-repair inputs are incomplete')
  const check = feedback.error_code === -2
    ? `The above code is incorrect and got a wrong answer.\nInput: ${feedback.inputs}\nGenerated Output: ${feedback.output}\nExpected: ${feedback.expected}`
    : null
  if (!check) throw new Error(`Unsupported LiveCodeBench feedback code: ${feedback.error_code}`)
  return [
    'You are a helpful programming assistant and an expert Python programmer. The user has written code that is not passing the tests. Give a concise explanation of the error, then provide the entire fixed program in one Python code block.',
    '',
    '### Question:',
    question,
    '',
    '### Answer:',
    '```python',
    candidate.trimEnd(),
    '```',
    '',
    check,
    '',
    '### Format: Read the inputs from stdin solve the problem and write the answer to stdout. Enclose the entire fixed program in one Python code block.',
  ].join('\n')
}
