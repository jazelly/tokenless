import { createHash, randomInt } from 'node:crypto'
import { tokenlessError } from '../../playwright/errors.js'

const MAX_ATTEMPTS = 100_000

export type ChatGptProofRequirement = {
  required: boolean
  seed?: string | undefined
  difficulty?: string | undefined
}

export function createChatGptProofToken(
  requirement: ChatGptProofRequirement,
  userAgent: string,
): string | undefined {
  if (!requirement.required) return undefined
  const seed = requiredTextInput(requirement.seed, 'seed')
  const difficulty = requiredHexInput(requirement.difficulty, 'difficulty')
  const proof = [
    [3008, 4010, 6000][randomInt(3)]! * [1, 2, 4][randomInt(3)]!,
    new Date().toUTCString(),
    null,
    0,
    userAgent,
    'https://tcr9i.chat.openai.com/v2/35536E1E-65B4-4D96-9D97-6ADB7EFF8147/api.js',
    'dpl=1440a687921de39ff5ee56b92807faaadce73f13',
    'en',
    'en-US',
    null,
    'plugins−[object PluginArray]',
    '_reactListeningtokenless',
    'ontransitionend',
  ]

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    proof[3] = attempt
    const encoded = Buffer.from(JSON.stringify(proof), 'utf8').toString('base64')
    const digestPrefix = createHash('sha3-512').update(seed + encoded).digest('hex').slice(0, difficulty.length)
    if (digestPrefix <= difficulty) return `gAAAAAB${encoded}`
  }
  throw tokenlessError(
    'direct_proof_of_work_failed',
    'ChatGPT direct protocol proof-of-work could not be solved within the supported attempt limit.',
  )
}

function requiredHexInput(value: unknown, field: string) {
  if (typeof value !== 'string' || !value || !/^[a-f0-9]+$/iu.test(value)) {
    throw tokenlessError(
      'direct_requirements_invalid',
      `ChatGPT direct protocol returned an invalid proof-of-work ${field}.`,
    )
  }
  return value
}

function requiredTextInput(value: unknown, field: string) {
  if (typeof value !== 'string' || !value) {
    throw tokenlessError(
      'direct_requirements_invalid',
      `ChatGPT direct protocol returned an invalid proof-of-work ${field}.`,
    )
  }
  return value
}
