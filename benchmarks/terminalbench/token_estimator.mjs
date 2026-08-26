import process from 'node:process'

import { OutputSavingsRuntimeManager } from '../../packages/server/dist/src/output-savings/index.js'

const homeDir = process.argv[2]
if (!homeDir) throw new Error('Tokenless API home is required.')

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const text = Buffer.concat(chunks).toString('utf8')
const measurement = await new OutputSavingsRuntimeManager(homeDir).measure(text, {
  installIfMissing: false,
})

if (measurement.state !== 'measured') {
  process.stdout.write(`${JSON.stringify({
    availability: 'unavailable',
    estimator: measurement.estimator,
    estimatorRevision: measurement.estimatorRevision,
    reason: measurement.reason,
  })}\n`)
  process.exit(0)
}

process.stdout.write(`${JSON.stringify({
  availability: 'estimated',
  estimator: measurement.estimator,
  estimatorRevision: measurement.estimatorRevision,
  tokens: measurement.estimatedOutputTokens,
  characters: measurement.visibleCharacters,
  sourceTextSha256: measurement.sourceTextSha256,
})}\n`)
