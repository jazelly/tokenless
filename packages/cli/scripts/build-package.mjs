#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(packageRoot, 'dist')

fs.rmSync(distRoot, { recursive: true, force: true })

run('tsc', ['-p', path.join(packageRoot, '..', 'web-ai-interaction-protocol', 'tsconfig.json')])
run('tsc', ['-p', path.join(packageRoot, '..', 'web-agent-harness', 'tsconfig.json')])
run('tsc', ['-p', 'tsconfig.json'])
run('vite', ['build', '--config', 'vite.ui.config.ts', '--logLevel', 'error'])

fs.cpSync(
  path.join(packageRoot, '..', 'web-agent-harness', 'dist'),
  path.join(distRoot, 'web-agent-harness'),
  { recursive: true },
)
fs.cpSync(
  path.join(packageRoot, '..', 'web-ai-interaction-protocol', 'schemas', 'v0'),
  path.join(distRoot, 'schemas', 'v0'),
  { recursive: true },
)
run('vite', ['build', '--config', 'vite.harness.config.mjs', '--logLevel', 'error'])

const uiRoot = path.join(distRoot, 'src', 'daemon', 'ui')
const providersRoot = path.join(distRoot, 'src', 'providers')
fs.mkdirSync(providersRoot, { recursive: true })
fs.copyFileSync(
  path.join(packageRoot, '..', '..', 'assets', 'tokenless-mark.png'),
  path.join(uiRoot, 'mark.png'),
)
fs.copyFileSync(
  path.join(packageRoot, 'catalog', 'provider-rate-limits.v1.json'),
  path.join(providersRoot, 'provider-rate-limits.v1.json'),
)
fs.chmodSync(path.join(distRoot, 'src', 'tokenless.mjs'), 0o755)
fs.chmodSync(path.join(distRoot, 'src', 'daemon', 'daemon-entry.mjs'), 0o755)

run(process.execPath, [path.join(providersRoot, 'rate-limit-catalog-check.mjs')])

function run(command, args) {
  const executable = process.platform === 'win32' && !path.isAbsolute(command) ? `${command}.cmd` : command
  const shell = process.platform === 'win32' && !path.isAbsolute(command)
  execFileSync(executable, args, { cwd: packageRoot, stdio: 'inherit', shell })
}
