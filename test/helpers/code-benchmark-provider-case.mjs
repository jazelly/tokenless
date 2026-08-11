import { getCodeBenchmarkTask, getVendoredCodeBenchmarkPrompt } from '../provider-prompts/code/collection.mjs'
import { evaluateCodeBenchmarkResponse } from '../provider-prompts/code/evaluator.mjs'
import { materializeCodeBenchmarkTask } from '../provider-prompts/code/materialize.mjs'

export const providerCodeSmokeTaskId = 'bigcodebench:v0.1.4:4'

let preparation

export function providerCodeSmokeCase() {
  const task = getCodeBenchmarkTask(providerCodeSmokeTaskId)
  return {
    task,
    prompt: getVendoredCodeBenchmarkPrompt(task.id),
    prepare: () => (preparation ??= materializeCodeBenchmarkTask(task.id)),
    evaluate: (responseText) => evaluateCodeBenchmarkResponse(task.id, responseText),
  }
}
