#!/usr/bin/env node

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
