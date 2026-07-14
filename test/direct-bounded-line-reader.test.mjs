import assert from 'node:assert/strict'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const directModuleRoot = process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT
  ? pathToFileURL(`${path.resolve(process.env.TOKENLESS_DIRECT_TEST_MODULE_ROOT)}${path.sep}`)
  : new URL('../packages/cli/dist/src/direct/', import.meta.url)

const { consumeBoundedLines } = await import(new URL('bounded-line-reader.js', directModuleRoot))

test('bounded line reader remains linear for one-byte chunks and preserves CRLF frames', async () => {
  const payload = Buffer.from(`${'x'.repeat(256 * 1024)}\r\nsecond\n`, 'utf8')
  const stream = Readable.from([...payload].map((byte) => Buffer.from([byte])))
  const lines = []
  await new Promise((resolve, reject) => {
    consumeBoundedLines(stream, {
      maxLineBytes: 256 * 1024 + 1,
      maxLines: 2,
      onLine: (line) => lines.push(line),
      onError: reject,
      onEnd: resolve,
    })
  })
  assert.deepEqual(lines, ['x'.repeat(256 * 1024), 'second'])
})

test('bounded line reader rejects invalid UTF-8 inside an otherwise framed value', async () => {
  const stream = Readable.from([Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a])])
  await assert.rejects(new Promise((resolve, reject) => {
    consumeBoundedLines(stream, {
      maxLineBytes: 64,
      maxLines: 1,
      onLine: () => reject(new Error('invalid UTF-8 must not reach the consumer')),
      onError: reject,
      onEnd: resolve,
    })
  }), /invalid UTF-8/i)
})

test('bounded line reader validates its allocation limits before attaching listeners', () => {
  const stream = new Readable({ read() {} })
  assert.throws(() => consumeBoundedLines(stream, {
    maxLineBytes: 0,
    maxLines: 1,
    onLine() {},
    onError() {},
  }), RangeError)
  assert.throws(() => consumeBoundedLines(stream, {
    maxLineBytes: 1,
    maxLines: 0,
    onLine() {},
    onError() {},
  }), RangeError)
})
