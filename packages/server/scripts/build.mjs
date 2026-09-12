#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const nodeBins = {
  tsc: resolveNodeBin('typescript', 'tsc'),
  vite: resolveNodeBin('vite', 'vite'),
}

run('tsc', ['-p', path.join(packageRoot, 'tsconfig.json')])
run('vite', ['build', '--config', path.join(packageRoot, 'vite.openai-tool-protocol.config.mjs'), '--logLevel', 'error'])

const catalogTarget = path.join(packageRoot, 'dist', 'catalog', 'provider-rate-limits.v1.json')
fs.mkdirSync(path.dirname(catalogTarget), { recursive: true })
fs.copyFileSync(path.join(packageRoot, 'catalog', 'provider-rate-limits.v1.json'), catalogTarget)

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
