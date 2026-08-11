import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { getCodeBenchmarkTask, loadCodeBenchmarkCollection } from './collection.mjs'
import { loadMaterializedCodeBenchmarkRecord } from './materialize.mjs'

export async function evaluateCodeBenchmarkResponse(taskId, responseText, options = {}) {
  const task = getCodeBenchmarkTask(taskId)
  const record = await loadMaterializedCodeBenchmarkRecord(task.id, options)
  if (task.evaluation.adapter === 'cruxeval.output.v1') {
    const actual = extractAssertionRightHandSide(responseText)
    return verdict(task, normalizePythonLiteral(actual) === normalizePythonLiteral(record.output), {
      expected: record.output,
      actual,
      isolation: 'none',
    })
  }

  const candidate = task.taskType === 'input_prediction'
    ? extractAssertionArguments(responseText)
    : extractPythonCode(responseText)
  const runner = buildPythonRunner(task, record, candidate)
  return runDockerEvaluation(task, runner)
}

export function extractPythonCode(responseText) {
  if (typeof responseText !== 'string' || !responseText.trim()) throw new Error('Benchmark response is empty')
  const fenced = /```(?:python)?\s*\r?\n([\s\S]*?)```/iu.exec(responseText)
  return (fenced?.[1] ?? responseText).trim()
}

function runDockerEvaluation(task, runner) {
  const { manifest } = loadCodeBenchmarkCollection()
  const image = task.benchmark === 'EvalPlus MBPP+' ? manifest.evaluatorImages.evalplus : manifest.evaluatorImages.python
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'tokenless-code-benchmark-'))
  try {
    fs.writeFileSync(path.join(root, 'runner.py'), runner, { mode: 0o600 })
    const result = spawnSync('docker', [
      'run', '--rm',
      '--network', 'none',
      '--read-only',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--pids-limit', '64',
      '--memory', '512m',
      '--cpus', '1',
      '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
      '--mount', `type=bind,source=${root},target=/work`,
      '--workdir', '/work',
      '--entrypoint', 'python',
      image,
      '/work/runner.py',
    ], {
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    if (result.error) throw result.error
    if (result.status !== 0 && !result.stdout.trim()) {
      throw new Error(`Docker evaluator failed for ${task.id}: ${result.stderr.trim() || `exit ${result.status}`}`)
    }
    let payload
    try {
      payload = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1))
    } catch {
      throw new Error(`Docker evaluator returned invalid output for ${task.id}: ${result.stdout || result.stderr}`)
    }
    return verdict(task, payload.passed === true, {
      isolation: 'docker',
      image,
      detail: payload.detail ?? null,
    })
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function buildPythonRunner(task, record, candidate) {
  if (task.benchmark === 'BigCodeBench-Instruct') {
    return buildExecRunner({
      candidate,
      tests: record.test,
      verdictExpression: 'unittest.TextTestRunner(verbosity=0).run(unittest.defaultTestLoader.loadTestsFromTestCase(TestCases)).wasSuccessful()',
    })
  }
  if (task.benchmark === 'EvalPlus MBPP+') {
    const imports = (record.test_imports ?? []).join('\n')
    return buildExecRunner({
      candidate: `${imports}\n${candidate}`,
      tests: record.test,
      verdictExpression: 'True',
    })
  }
  if (task.benchmark === 'CRUXEval') {
    return buildExecRunner({
      candidate: record.code,
      tests: '',
      verdictExpression: `f(${candidate}) == ${record.output}`,
    })
  }
  if (task.benchmark === 'LiveCodeBench') return buildLiveCodeBenchRunner(record, candidate)
  throw new Error(`No evaluator adapter for ${task.benchmark}`)
}

function buildLiveCodeBenchRunner(record, candidate) {
  return `
import base64
import json
import pickle
import subprocess
import sys
import zlib

candidate = ${JSON.stringify(candidate)}
open('/tmp/candidate.py', 'w', encoding='utf-8').write(candidate)
public_tests = json.loads(${JSON.stringify(record.public_test_cases)})
private_value = ${JSON.stringify(record.private_test_cases)}
try:
    private_tests = json.loads(private_value)
except Exception:
    private_tests = json.loads(pickle.loads(zlib.decompress(base64.b64decode(private_value.encode('utf-8')))))

def normalize(value):
    return '\\n'.join(line.rstrip() for line in value.strip().splitlines())

passed = True
detail = None
for case in public_tests + private_tests:
    if case.get('testtype') != 'stdin':
        passed = False
        detail = 'unsupported_non_stdin_case'
        break
    try:
        run = subprocess.run(
            [sys.executable, '/tmp/candidate.py'],
            input=case['input'],
            text=True,
            capture_output=True,
            timeout=6,
            cwd='/tmp',
        )
        if run.returncode != 0 or normalize(run.stdout) != normalize(case['output']):
            passed = False
            detail = 'wrong_answer_or_runtime_error'
            break
    except subprocess.TimeoutExpired:
        passed = False
        detail = 'time_limit_exceeded'
        break
print(json.dumps({'passed': passed, 'detail': detail}))
`
}

function buildExecRunner({ candidate, tests, verdictExpression }) {
  return `
import json

namespace = {}
try:
    exec(${JSON.stringify(candidate)}, namespace)
    exec(${JSON.stringify(tests)}, namespace)
    passed = bool(eval(${JSON.stringify(verdictExpression)}, namespace))
    detail = None
except BaseException as error:
    passed = False
    detail = type(error).__name__
print(json.dumps({'passed': passed, 'detail': detail}))
`
}

function extractAssertionRightHandSide(responseText) {
  const answer = extractAnswerEnvelope(responseText)
  const match = /assert\s+f\([\s\S]*?\)\s*==\s*([\s\S]+)$/u.exec(answer)
  if (!match) throw new Error('CRUXEval output response must contain a complete assertion')
  return match[1].trim()
}

function extractAssertionArguments(responseText) {
  const answer = extractAnswerEnvelope(responseText)
  const match = /assert\s+f\(([\s\S]*?)\)\s*==/u.exec(answer)
  if (!match) throw new Error('CRUXEval input response must contain a complete assertion')
  return match[1].trim()
}

function extractAnswerEnvelope(responseText) {
  const match = /\[ANSWER\]([\s\S]*?)(?:\[\/ANSWER\]|$)/iu.exec(responseText)
  return (match?.[1] ?? responseText).trim()
}

function normalizePythonLiteral(value) {
  let result = ''
  let quote = null
  let escaped = false
  for (const character of value.trim()) {
    if (quote) {
      result += character
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = null
    } else if (character === "'" || character === '"') {
      quote = character
      result += character
    } else if (!/\s/u.test(character)) {
      result += character
    }
  }
  return result
}

function verdict(task, passed, evidence) {
  return {
    schema: 'tokenless.code-benchmark-verdict.v1',
    taskId: task.id,
    benchmark: task.benchmark,
    passed,
    evaluator: task.evaluation.adapter,
    evidence,
  }
}
