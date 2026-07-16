import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  VISIBLE_ATTACHMENT_PROTOCOL,
  cleanupOrphanedVisibleAttachmentBundles,
  removeStagedVisibleAttachmentBundle,
  stageVisibleAttachment,
  stageVisibleAttachments,
  validateVisibleAttachmentDescriptor,
  visibleAttachmentPath,
} from '../packages/cli/dist/src/index.js'

test('visible attachment staging copies bytes into a private path and returns a path-free descriptor', async () => {
  await withTemporaryDirectory(async (directory) => {
    const homeDir = path.join(directory, 'home')
    const sourcePath = path.join(directory, 'report.txt')
    const bytes = Buffer.from('Tokenless visible attachment\nwith binary byte: \0\n')
    await fs.writeFile(sourcePath, bytes)

    const descriptor = await stageVisibleAttachment({
      homeDir,
      sourcePath,
      bundleId: 'bundle_safe-1',
      attachmentId: 'attachment_safe-1',
      type: 'text/plain',
    })

    assert.deepEqual(descriptor, {
      protocol: VISIBLE_ATTACHMENT_PROTOCOL,
      bundleId: 'bundle_safe-1',
      attachmentId: 'attachment_safe-1',
      name: 'report.txt',
      type: 'text/plain',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
    const serializedDescriptor = JSON.stringify(descriptor)
    assert.doesNotMatch(serializedDescriptor, /sourcePath|stagedPath/i)
    assert.equal(serializedDescriptor.includes(directory), false)
    assert.equal(serializedDescriptor.includes(homeDir), false)
    assert.equal(serializedDescriptor.includes(sourcePath), false)
    const stagedPath = visibleAttachmentPath(homeDir, descriptor.bundleId, descriptor.attachmentId)
    assert.deepEqual(await fs.readFile(stagedPath), bytes)
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(stagedPath)).mode & 0o777, 0o600)
      assert.equal((await fs.stat(path.dirname(stagedPath))).mode & 0o777, 0o700)
    }
    assert.equal(await removeStagedVisibleAttachmentBundle({ homeDir, bundleId: descriptor.bundleId }), true)
    await assert.rejects(fs.stat(stagedPath), { code: 'ENOENT' })
  })
})

test('visible attachment descriptors reject paths, unknown fields, unsafe ids, and malformed hashes', () => {
  const base = {
    protocol: VISIBLE_ATTACHMENT_PROTOCOL,
    bundleId: 'bundle-1',
    attachmentId: 'attachment-1',
    name: 'safe.txt',
    type: 'text/plain',
    size: 4,
    sha256: 'a'.repeat(64),
  }
  assert.deepEqual(validateVisibleAttachmentDescriptor(base), base)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, sourcePath: 'C:\\private.txt' }), /unsupported field/i)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, stagedPath: '/tmp/private' }), /unsupported field/i)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, bundleId: '../escape' }), /bundleId/)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, attachmentId: 'a/b' }), /attachmentId/)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, name: '../secret.txt' }), /path-free/)
  assert.throws(() => validateVisibleAttachmentDescriptor({ ...base, sha256: 'A'.repeat(64) }), /lowercase/)
})

test('visible attachment staging fails closed on collisions, size limits, and batch partial failures', async () => {
  await withTemporaryDirectory(async (directory) => {
    const homeDir = path.join(directory, 'home')
    const first = path.join(directory, 'first.txt')
    const second = path.join(directory, 'second.txt')
    const aggregateFirst = path.join(directory, 'aggregate-first.txt')
    const aggregateSecond = path.join(directory, 'aggregate-second.txt')
    await fs.writeFile(first, 'first')
    await fs.writeFile(second, 'second is too large')
    await fs.writeFile(aggregateFirst, '1234')
    await fs.writeFile(aggregateSecond, '5678')

    await stageVisibleAttachment({
      homeDir,
      sourcePath: first,
      bundleId: 'collision',
      attachmentId: 'same',
    })
    await assert.rejects(
      stageVisibleAttachment({ homeDir, sourcePath: first, bundleId: 'collision', attachmentId: 'same' }),
      { code: 'EEXIST' }
    )
    await assert.rejects(
      stageVisibleAttachment({ homeDir, sourcePath: second, maxBytes: 4 }),
      /staging limit/
    )
    await assert.rejects(
      stageVisibleAttachments({
        homeDir,
        bundleId: 'batch-rollback',
        maxBytes: 5,
        files: [{ sourcePath: first }, { sourcePath: second }],
      }),
      /staging limit/
    )
    await assert.rejects(
      fs.stat(path.join(homeDir, 'attachments', 'batch-rollback')),
      { code: 'ENOENT' }
    )
    await assert.rejects(
      stageVisibleAttachments({
        homeDir,
        bundleId: 'aggregate-rollback',
        maxBytes: 6,
        files: [{ sourcePath: aggregateFirst }, { sourcePath: aggregateSecond }],
      }),
      /aggregate staging limit|staging limit/
    )
    await assert.rejects(
      fs.stat(path.join(homeDir, 'attachments', 'aggregate-rollback')),
      { code: 'ENOENT' }
    )
  })
})

test('visible attachment staging rejects source and staging-root symlinks', {
  skip: process.platform === 'win32' && 'Creating symlinks may require Windows Developer Mode.',
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const homeDir = path.join(directory, 'home')
    const source = path.join(directory, 'source.txt')
    const sourceLink = path.join(directory, 'source-link.txt')
    await fs.writeFile(source, 'private')
    await fs.symlink(source, sourceLink)
    await assert.rejects(stageVisibleAttachment({ homeDir, sourcePath: sourceLink }), /non-symlink/)

    const outside = path.join(directory, 'outside')
    await fs.mkdir(homeDir, { recursive: true })
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(homeDir, 'attachments'), 'dir')
    await assert.rejects(stageVisibleAttachment({ homeDir, sourcePath: source }), /non-symlink directory|escaped/)
    assert.deepEqual(await fs.readdir(outside), [])
  })
})

test('orphan cleanup removes only expired, structurally valid attachment bundles', async () => {
  await withTemporaryDirectory(async (directory) => {
    const homeDir = path.join(directory, 'home')
    const source = path.join(directory, 'source.txt')
    await fs.writeFile(source, 'cleanup')
    const old = await stageVisibleAttachment({ homeDir, sourcePath: source, bundleId: 'old-bundle' })
    const recent = await stageVisibleAttachment({ homeDir, sourcePath: source, bundleId: 'recent-bundle' })
    const oldTime = new Date('2026-01-01T00:00:00.000Z')
    await fs.utimes(path.dirname(visibleAttachmentPath(homeDir, old.bundleId, old.attachmentId)), oldTime, oldTime)

    const removed = await cleanupOrphanedVisibleAttachmentBundles({
      homeDir,
      ttlMs: 60_000,
      nowMs: Date.parse('2026-01-01T00:02:00.000Z'),
    })
    assert.deepEqual(removed, ['old-bundle'])
    await assert.rejects(fs.stat(visibleAttachmentPath(homeDir, old.bundleId, old.attachmentId)), { code: 'ENOENT' })
    assert.equal((await fs.stat(visibleAttachmentPath(homeDir, recent.bundleId, recent.attachmentId))).isFile(), true)
  })
})

async function withTemporaryDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'tokenless-visible-attachment-'))
  try {
    await run(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}
