#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

import {
  codeBenchmarkSummary,
  getCodeBenchmarkTask,
  listCodeBenchmarkTasks,
  loadCodeBenchmarkCollection,
} from '../test/provider-prompts/code/collection.mjs'
import { evaluateCodeBenchmarkResponse } from '../test/provider-prompts/code/evaluator.mjs'
import {
  getCodeBenchmarkPrompt,
  materializeCodeBenchmarkTask,
  materializedRecordPath,
} from '../test/provider-prompts/code/materialize.mjs'

const [command = 'help', ...arguments_] = process.argv.slice(2)

try {
  if (command === 'validate') {
    loadCodeBenchmarkCollection()
    output({ ok: true, ...codeBenchmarkSummary() })
  } else if (command === 'list') {
    const collection = option(arguments_, '--collection')
    const benchmark = option(arguments_, '--benchmark')
    const tasks = listCodeBenchmarkTasks({
      ...(collection ? { collection } : {}),
      ...(benchmark ? { benchmark } : {}),
      availableOnly: arguments_.includes('--available-only'),
    })
    output({ ok: true, count: tasks.length, tasks: tasks.map(taskSummary) })
  } else if (command === 'prompt') {
    const taskId = requiredOption(arguments_, '--task')
    const prompt = await getCodeBenchmarkPrompt(taskId)
    if (arguments_.includes('--json')) output({ ok: true, task: taskSummary(getCodeBenchmarkTask(taskId)), prompt })
    else process.stdout.write(prompt.endsWith('\n') ? prompt : `${prompt}\n`)
  } else if (command === 'materialize') {
    const taskId = requiredOption(arguments_, '--task')
    output({ ok: true, materialized: await materializeCodeBenchmarkTask(taskId) })
  } else if (command === 'evaluate') {
    const taskId = requiredOption(arguments_, '--task')
    const responseFile = path.resolve(requiredOption(arguments_, '--response-file'))
    const response = fs.readFileSync(responseFile, 'utf8')
    const verdict = await evaluateCodeBenchmarkResponse(taskId, response)
    output({ ok: verdict.passed, verdict })
    if (!verdict.passed) process.exitCode = 1
  } else if (command === 'status') {
    const tasks = listCodeBenchmarkTasks()
    output({
      ok: true,
      ...codeBenchmarkSummary(),
      materialized: tasks.filter((task) => fs.existsSync(materializedRecordPath(task.id))).map((task) => task.id),
      evaluatorImages: loadCodeBenchmarkCollection().manifest.evaluatorImages,
    })
  } else if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(helpText)
  } else {
    throw new Error(`Unknown code benchmark command: ${command}`)
  }
} catch (error) {
  if (arguments_.includes('--json')) output({ ok: false, error: { message: error.message } })
  else process.stderr.write(`Error: ${error.message}\n`)
  process.exitCode = 1
}

function taskSummary(task) {
  return {
    id: task.id,
    benchmark: task.benchmark,
    upstreamTaskId: task.upstreamTaskId,
    taskType: task.taskType,
    collections: task.collections,
    promptAvailability: task.prompt.mode,
    evaluator: task.evaluation.adapter,
  }
}

function option(args, name) {
  const index = args.indexOf(name)
  return index < 0 ? null : args[index + 1]
}

function requiredOption(args, name) {
  const value = option(args, name)?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

const helpText = `Code benchmark prompt collection

Usage:
  npm run benchmark:code -- validate
  npm run benchmark:code -- list [--collection code-smoke|code-core] [--available-only]
  npm run benchmark:code -- prompt --task <task-id> [--json]
  npm run benchmark:code -- materialize --task <task-id>
  npm run benchmark:code -- evaluate --task <task-id> --response-file <file>
  npm run benchmark:code -- status
`
