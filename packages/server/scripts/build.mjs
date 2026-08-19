#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

run('tsc', ['-p', path.join(packageRoot, 'tsconfig.json')])
run('vite', ['build', '--config', path.join(packageRoot, 'vite.openai-tool-protocol.config.mjs'), '--logLevel', 'error'])

const catalogTarget = path.join(packageRoot, 'dist', 'catalog', 'provider-rate-limits.v1.json')
fs.mkdirSync(path.dirname(catalogTarget), { recursive: true })
fs.copyFileSync(path.join(packageRoot, 'catalog', 'provider-rate-limits.v1.json'), catalogTarget)

function run(command, args) {
  const executable = process.platform === 'win32' && !path.isAbsolute(command) ? `${command}.cmd` : command
  const shell = process.platform === 'win32' && !path.isAbsolute(command)
  execFileSync(executable, args, { cwd: packageRoot, stdio: 'inherit', shell })
}
