import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const runtimeDirectory = path.resolve(process.argv[2] ?? '')
if (!runtimeDirectory) throw new Error('Output savings runtime directory is required.')

const require = createRequire(import.meta.url)
const { Tiktoken } = require(path.join(runtimeDirectory, 'lite', 'tiktoken.cjs')) as {
  Tiktoken: new (ranks: string, specialTokens: Record<string, number>, pattern: string) => {
    encode(text: string): Uint32Array
    free(): void
  }
}
const ranks = JSON.parse(await fs.readFile(path.join(runtimeDirectory, 'encoders', 'o200k_base.json'), 'utf8')) as {
  bpe_ranks: string
  special_tokens: Record<string, number>
  pat_str: string
}
const text = readFileSync(0, 'utf8')
const encoding = new Tiktoken(ranks.bpe_ranks, ranks.special_tokens, ranks.pat_str)
try {
  const tokens = encoding.encode(text).length
  process.stdout.write(`${JSON.stringify({ tokens })}\n`)
} finally {
  encoding.free()
}
