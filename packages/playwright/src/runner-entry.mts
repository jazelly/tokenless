import { ManagedPlaywrightRunnerService } from './runner-service.js'
import { RUNNER_HEARTBEAT_INTERVAL_MS, writeRunnerHeartbeat } from './runner-supervisor.js'
import { createDaemonClient } from './daemon-client.js'
import { ManagedProfileRegistry } from './profiles/registry.js'

const args = parseArgs(process.argv.slice(2))
const abortController = new AbortController()
const homeDir = requiredArg(args, 'home-dir')
const sessionId = requiredArg(args, 'session-id')

process.on('SIGINT', () => abortController.abort())
process.on('SIGTERM', () => abortController.abort())

await writeRunnerHeartbeat({ homeDir, sessionId })
const heartbeat = setInterval(() => {
  void writeRunnerHeartbeat({ homeDir, sessionId }).catch(() => undefined)
}, RUNNER_HEARTBEAT_INTERVAL_MS)

const service = new ManagedPlaywrightRunnerService({
  homeDir,
  profileRegistry: new ManagedProfileRegistry(homeDir),
  daemonClient: createDaemonClient({
    homeDir,
    daemonUrl: args.get('daemon-url'),
  }),
})

try {
  await service.runUntilStopped(abortController.signal)
} finally {
  clearInterval(heartbeat)
  await service.shutdown().catch(() => undefined)
}

function parseArgs(values: readonly string[]) {
  const parsed = new Map<string, string>()
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]
    const value = values[index + 1]
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error('Invalid managed Playwright runner arguments.')
    }
    parsed.set(key.slice(2), value)
    index += 1
  }
  return parsed
}

function requiredArg(args: Map<string, string>, key: string) {
  const value = args.get(key)
  if (!value) throw new Error('Missing managed Playwright runner argument.')
  return value
}
