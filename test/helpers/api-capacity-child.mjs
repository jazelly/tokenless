import path from 'node:path'
import { pathToFileURL } from 'node:url'

const [moduleRoot, homeDir, provider, accountInternalId, maxConcurrency] = process.argv.slice(2)
if (!moduleRoot || !homeDir || !provider || !accountInternalId || !maxConcurrency) {
  process.exitCode = 2
} else {
  const { withApiAccountCapacity } = await import(new URL(
    'api-account-capacity.js',
    pathToFileURL(`${path.resolve(moduleRoot)}${path.sep}`),
  ))
  try {
    await withApiAccountCapacity({
      homeDir: path.resolve(homeDir),
      provider,
      accountInternalId,
      maxConcurrency: Number(maxConcurrency),
      queueDepth: 4,
      queueWaitMs: 10_000,
    }, async () => {
      process.stdout.write('acquired\n')
      await new Promise((resolve, reject) => {
        process.stdin.once('data', resolve)
        process.stdin.once('error', reject)
        process.stdin.resume()
      })
      process.stdin.pause()
      process.stdout.write('released\n')
    })
  } catch (error) {
    process.stderr.write(`${error?.code ?? error?.name ?? 'error'}\n`)
    process.exitCode = 1
  }
}
