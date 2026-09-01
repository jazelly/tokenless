#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.join('packages', 'cli', 'dist', 'src', 'tokenless.mjs')
const targetPath = path.join(repositoryRoot, target)
const linkPath = path.join(repositoryRoot, 'tokenless-beta')

if (!fs.existsSync(targetPath)) {
  throw new Error(`Built CLI entrypoint does not exist: ${targetPath}`)
}

try {
  fs.unlinkSync(linkPath)
} catch (error) {
  if (error?.code !== 'ENOENT') {
    throw error
  }
}

fs.symlinkSync(target, linkPath, 'file')
console.log(`Created development launcher / 已创建开发启动入口: tokenless-beta -> ${target}`)

// Invoke npm through its JavaScript entrypoint on Windows. Node cannot execute
// npm.cmd with execFileSync(), and resolving the extensionless shim fails with
// ENOENT. Running the entrypoint also keeps argument handling shell-free.
const npmCliPath = process.env.npm_execpath || (
  process.platform === 'win32'
    ? path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : null
)
const npmCommand = npmCliPath ? process.execPath : 'npm'
const npmArgs = npmCliPath ? [npmCliPath, 'link'] : ['link']

// With npm 11, running `npm link` from the package directory creates the
// global link; passing `--global` is rejected for this form.
execFileSync(npmCommand, npmArgs, {
  cwd: path.join(repositoryRoot, 'packages', 'cli'),
  stdio: 'inherit',
})
console.log('Linked the local CLI globally / 已将本地 CLI 链接到全局: tokenless')
