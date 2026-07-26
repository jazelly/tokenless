import { pathToFileURL } from 'node:url'
import path from 'node:path'

const [oldCliPackageDir, homeDir, daemonUrl, mode] = process.argv.slice(2)

if (!oldCliPackageDir || !homeDir || !daemonUrl) {
  process.stderr.write('usage: published-cli-conformance-child <package-dir> <home-dir> <daemon-url>\n')
  process.exitCode = 2
} else {
  try {
    const runtime = await import(pathToFileURL(path.join(oldCliPackageDir, 'dist/src/runtime.js')).href)
    const client = await import(pathToFileURL(path.join(oldCliPackageDir, 'dist/src/daemon-client.js')).href)
    const probe = await runtime.probeDaemonReady({ homeDir, daemonUrl, timeoutMs: 2_000 })
    const created = mode === 'create-job' && probe.ok
      ? await client.createDaemonJob({
          homeDir,
          daemonUrl,
          provider: 'claude',
          action: 'prompt.submit',
          requestJson: {
            prompt: 'created by published cross-version helper',
            taskId: 'published-cross-version',
            idempotencyKey: 'published-cross-version',
          },
        })
      : null
    const jobs = probe.ok
      ? await client.listDaemonJobs({ homeDir, daemonUrl, requestTimeoutMs: 2_000 })
      : null
    process.stdout.write(`${JSON.stringify({ probe, created, jobs })}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
    process.exitCode = 1
  }
}
