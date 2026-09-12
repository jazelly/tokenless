#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const distRoot = path.join(packageRoot, 'dist')
const require = createRequire(import.meta.url)
const nodeBins = {
  tsc: resolveNodeBin('typescript', 'tsc'),
  vite: resolveNodeBin('vite', 'vite'),
}

fs.rmSync(distRoot, { recursive: true, force: true })

const sharedRoot = path.join(packageRoot, '..', 'shared')
const harnessRoot = path.join(packageRoot, '..', 'harness')
const serverRoot = path.join(packageRoot, '..', 'server')
const dashboardRoot = path.join(packageRoot, '..', 'dashboard')

for (const workspaceRoot of [sharedRoot, harnessRoot, serverRoot, dashboardRoot]) {
  fs.rmSync(path.join(workspaceRoot, 'dist'), { recursive: true, force: true })
}

run('tsc', ['-p', path.join(sharedRoot, 'tsconfig.json')])
run('tsc', ['-p', path.join(harnessRoot, 'tsconfig.json')])
run(process.execPath, [path.join(serverRoot, 'scripts', 'build.mjs')])
run('vite', ['build', '--config', path.join(dashboardRoot, 'vite.config.ts'), '--logLevel', 'error'])
const serverDashboardRoot = path.join(serverRoot, 'dist', 'dashboard')
fs.cpSync(path.join(dashboardRoot, 'dist'), serverDashboardRoot, { recursive: true })
fs.copyFileSync(
  path.join(packageRoot, '..', '..', 'assets', 'tokenless-mark.png'),
  path.join(serverDashboardRoot, 'mark.png'),
)
fs.cpSync(path.join(sharedRoot, 'dist'), path.join(distRoot, 'shared'), { recursive: true })
fs.cpSync(path.join(serverRoot, 'dist'), path.join(distRoot, 'server'), { recursive: true })
run('tsc', ['-p', 'tsconfig.json'])

fs.cpSync(
  path.join(harnessRoot, 'dist'),
  path.join(distRoot, 'harness'),
  {
    recursive: true,
    filter: (source) => !source.endsWith('.js') && !source.endsWith('.js.map'),
  },
)
fs.cpSync(
  path.join(harnessRoot, 'schemas', 'provider-turn', 'v0'),
  path.join(distRoot, 'schemas', 'provider-turn', 'v0'),
  { recursive: true },
)
run('vite', ['build', '--config', path.join(harnessRoot, 'vite.bundle.config.mjs'), '--logLevel', 'error'])

const providersRoot = path.join(distRoot, 'server', 'src', 'providers')
const runtimeRoot = path.join(distRoot, 'runtime')
fs.mkdirSync(providersRoot, { recursive: true })
fs.cpSync(path.join(packageRoot, 'runtime'), runtimeRoot, { recursive: true })
fs.cpSync(path.join(packageRoot, '..', '..', 'skills'), path.join(distRoot, 'skills'), { recursive: true })
fs.cpSync(path.join(packageRoot, 'integrations'), path.join(distRoot, 'integrations'), { recursive: true })
fs.copyFileSync(
  path.join(serverRoot, 'catalog', 'provider-rate-limits.v1.json'),
  path.join(providersRoot, 'provider-rate-limits.v1.json'),
)
fs.chmodSync(path.join(distRoot, 'src', 'tokenless.mjs'), 0o755)
fs.chmodSync(path.join(distRoot, 'src', 'bootstrap', 'daemon-entry.mjs'), 0o755)
fs.chmodSync(path.join(distRoot, 'server', 'src', 'entry.mjs'), 0o755)

run(process.execPath, [path.join(providersRoot, 'rate-limit-catalog-check.mjs')])

function run(command, args) {
  const nodeBin = nodeBins[command]
  execFileSync(nodeBin ? process.execPath : command, nodeBin ? [nodeBin, ...args] : args, {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  })
}

function resolveNodeBin(packageName, binName) {
  const manifestPath = require.resolve(packageName + '/package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const relativePath = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
  if (typeof relativePath !== 'string') throw new Error('Missing ' + binName + ' binary in ' + manifestPath)
  return path.resolve(path.dirname(manifestPath), relativePath)
}
