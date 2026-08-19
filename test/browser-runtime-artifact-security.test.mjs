import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'

import { verifyAndExtractManagedBrowserArtifact } from '../packages/server/dist/src/browser/runtime/manager.js'

test('managed browser artifact verification fails closed across real archive and executable boundaries', async () => {
  const temporaryRoot = await fs.realpath(os.tmpdir())
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'tokenless-browser-artifact-security-'))
  const stateDirectory = path.join(root, 'state')
  const configPath = path.join(stateDirectory, 'config.json')
  const registryPath = path.join(stateDirectory, 'profiles.json')
  const configSentinel = Buffer.from('{"browser":"sentinel"}\n')
  const registrySentinel = Buffer.from('{"profiles":["sentinel"]}\n')
  try {
    await fs.mkdir(stateDirectory, { recursive: true, mode: 0o700 })
    await fs.writeFile(configPath, configSentinel, { mode: 0o600 })
    await fs.writeFile(registryPath, registrySentinel, { mode: 0o600 })

    const checksumCase = await prepareCase(root, 'checksum', createTarGz([
      fileEntry('artifact.txt', Buffer.from('real archive bytes\n')),
    ]))
    await assertVerificationFailure({
      testCase: checksumCase,
      entry: artifactEntry({ sha256: '0'.repeat(64) }),
      expectedCode: 'browser_runtime_checksum_mismatch',
    })
    await assert.rejects(fs.stat(checksumCase.payloadDirectory), { code: 'ENOENT' })
    await assertStateUnchanged()

    const unsafeCase = await prepareCase(root, 'unsafe-path', createTarGz([
      fileEntry('../escaped-browser-artifact', Buffer.from('must not escape\n')),
    ]))
    await assertVerificationFailure({
      testCase: unsafeCase,
      entry: artifactEntry({ sha256: await sha256(unsafeCase.archive) }),
      expectedCode: 'browser_runtime_archive_unsafe',
    })
    await assert.rejects(fs.stat(path.join(unsafeCase.caseDirectory, 'escaped-browser-artifact')), { code: 'ENOENT' })
    await assert.rejects(fs.stat(path.join(root, 'escaped-browser-artifact')), { code: 'ENOENT' })
    await assertStateUnchanged()

    const executableRelativePath = process.platform === 'win32'
      ? 'chrome.exe'
      : 'Chromium.app/Contents/MacOS/Chromium'
    const executableBytes = process.platform === 'win32'
      ? await fs.readFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'))
      : Buffer.from('#!/bin/sh\nprintf "Chromium 1.2.3.4\\n"\n')
    const versionCase = await prepareCase(root, 'wrong-version', createTarGz([
      ...directoryEntries(executableRelativePath),
      fileEntry(executableRelativePath, executableBytes, 0o755),
    ]))
    await assertVerificationFailure({
      testCase: versionCase,
      entry: artifactEntry({
        sha256: await sha256(versionCase.archive),
        executableRelativePath,
      }),
      expectedCode: 'browser_runtime_version_mismatch',
    })
    await assertStateUnchanged()
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }

  async function assertStateUnchanged() {
    assert.deepEqual(await fs.readFile(configPath), configSentinel)
    assert.deepEqual(await fs.readFile(registryPath), registrySentinel)
  }
})

async function assertVerificationFailure({ testCase, entry, expectedCode }) {
  await assert.rejects(
    verifyAndExtractManagedBrowserArtifact({
      entry,
      archivePath: testCase.archive,
      payloadDirectory: testCase.payloadDirectory,
      temporaryRoot: testCase.caseDirectory,
    }),
    (error) => error?.code === expectedCode,
  )
}

async function prepareCase(root, slug, archiveBytes) {
  const caseDirectory = path.join(root, slug)
  const archive = path.join(caseDirectory, 'browser.tar.gz')
  const payloadDirectory = path.join(caseDirectory, 'payload')
  await fs.mkdir(caseDirectory, { recursive: false, mode: 0o700 })
  await fs.writeFile(archive, archiveBytes, { mode: 0o600 })
  return { caseDirectory, archive, payloadDirectory }
}

function artifactEntry(overrides = {}) {
  return {
    family: 'cloak',
    browserId: 'cloak',
    displayName: 'Browser artifact security integration target',
    platform: process.platform === 'win32' ? 'win32-x64' : 'darwin-arm64',
    artifactVersion: 'integration-security-case',
    browserVersion: '9.9.9.9',
    downloadUrl: 'https://example.invalid/browser.tar.gz',
    sha256: '0'.repeat(64),
    archiveFormat: 'tar.gz',
    executableRelativePath: process.platform === 'win32'
      ? 'chrome.exe'
      : 'Chromium.app/Contents/MacOS/Chromium',
    ...overrides,
  }
}

function directoryEntries(filePath) {
  const segments = filePath.split('/')
  const entries = []
  for (let index = 1; index < segments.length; index += 1) {
    entries.push(directoryEntry(`${segments.slice(0, index).join('/')}/`))
  }
  return entries
}

function fileEntry(name, content, mode = 0o644) {
  return { name, content, mode, type: '0' }
}

function directoryEntry(name) {
  return { name, content: Buffer.alloc(0), mode: 0o755, type: '5' }
}

function createTarGz(entries) {
  const blocks = []
  for (const entry of entries) {
    const header = Buffer.alloc(512)
    writeString(header, entry.name, 0, 100)
    writeOctal(header, entry.mode, 100, 8)
    writeOctal(header, 0, 108, 8)
    writeOctal(header, 0, 116, 8)
    writeOctal(header, entry.content.length, 124, 12)
    writeOctal(header, 0, 136, 12)
    header.fill(0x20, 148, 156)
    header[156] = entry.type.charCodeAt(0)
    writeString(header, 'ustar\0', 257, 6)
    writeString(header, '00', 263, 2)
    const checksum = header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0')
    writeString(header, checksum, 148, 6)
    header[154] = 0
    header[155] = 0x20
    blocks.push(header, entry.content)
    const padding = (512 - (entry.content.length % 512)) % 512
    if (padding > 0) blocks.push(Buffer.alloc(padding))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function writeString(buffer, value, offset, length) {
  buffer.write(value, offset, Math.min(Buffer.byteLength(value), length), 'utf8')
}

function writeOctal(buffer, value, offset, length) {
  const encoded = value.toString(8).padStart(length - 1, '0').slice(-(length - 1))
  buffer.write(encoded, offset, length - 1, 'ascii')
  buffer[offset + length - 1] = 0
}

function sha256(file) {
  return fs.readFile(file).then((content) => createHash('sha256').update(content).digest('hex'))
}
