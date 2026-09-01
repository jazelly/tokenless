#!/usr/bin/env node
import { daemonBuildInfo } from './http/server.js'
import { startDaemon } from './runtime/lifecycle.js'

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--tokenless-build-info') {
    console.log(JSON.stringify(daemonBuildInfo('tokenless-daemon')))
    return
  }
  const options = parseArgs(args)
  await startDaemon(options)
}

function parseArgs(args: string[]) {
  let homeDir: string | undefined
  let host = '127.0.0.1'
  let port = 7331
  const positional: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === '--home') {
      homeDir = requireValue(args, ++index, '--home')
    } else if (arg === '--host') {
      host = requireValue(args, ++index, '--host')
    } else if (arg === '--port') {
      port = parsePort(requireValue(args, ++index, '--port'))
    } else {
      positional.push(arg)
    }
  }
  if (positional.length === 1 && positional[0] === 'serve') {
    return { homeDir, host, port }
  }
  if (positional.length === 0) return { homeDir, host, port }
  throw new Error('usage: daemon-entry.mjs [--home <path>] [serve] [--host <loopback>] [--port <port>]')
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index]
  if (!value) throw new Error(`${flag} requires a value`)
  return value
}

function parsePort(value: string) {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a valid TCP port')
  return port
}

main().catch((error) => {
  console.error(error instanceof Error && error.message ? error.message : String(error))
  process.exit(1)
})
