import type { Readable } from 'node:stream'

export class BoundedLineError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoundedLineError'
  }
}

export function consumeBoundedLines(
  stream: Readable,
  options: Readonly<{
    maxLineBytes: number
    maxLines: number
    onLine: (line: string) => void
    onError: (error: Error) => void
    onEnd?: (() => void) | undefined
  }>,
): () => void {
  if (!Number.isSafeInteger(options.maxLineBytes) || options.maxLineBytes <= 0) {
    throw new RangeError('A positive bounded-line byte limit is required.')
  }
  if (!Number.isSafeInteger(options.maxLines) || options.maxLines <= 0) {
    throw new RangeError('A positive bounded-line count limit is required.')
  }
  const pending = Buffer.allocUnsafe(options.maxLineBytes)
  let pendingLength = 0
  let lines = 0
  let stopped = false
  const decoder = new TextDecoder('utf-8', { fatal: true })

  const stop = () => {
    if (stopped) return
    stopped = true
    stream.removeListener('data', onData)
    stream.removeListener('error', onStreamError)
    stream.removeListener('end', onEnd)
  }
  const fail = (message: string) => {
    if (stopped) return
    stop()
    stream.destroy()
    options.onError(new BoundedLineError(message))
  }
  const onData = (value: Buffer | string) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
    let offset = 0
    while (!stopped && offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset)
      const end = newline === -1 ? chunk.length : newline
      const segment = chunk.subarray(offset, end)
      if (pendingLength + segment.length > options.maxLineBytes) {
        fail('A line exceeded its byte limit before a delimiter was received.')
        return
      }
      if (segment.length > 0) {
        segment.copy(pending, pendingLength)
        pendingLength += segment.length
      }
      if (newline === -1) return
      if (++lines > options.maxLines) {
        fail('The stream exceeded its line-count limit.')
        return
      }
      const lineLength = pendingLength > 0 && pending[pendingLength - 1] === 0x0d
        ? pendingLength - 1
        : pendingLength
      const lineBytes = pending.subarray(0, lineLength)
      pendingLength = 0
      try {
        options.onLine(decoder.decode(lineBytes))
      } catch {
        fail('A line contained invalid UTF-8 or failed structured processing.')
        return
      }
      offset = newline + 1
    }
  }
  const onStreamError = () => fail('The bounded line stream failed.')
  const onEnd = () => {
    if (stopped) return
    if (pendingLength > 0) {
      fail('The bounded line stream ended with an unterminated frame.')
      return
    }
    stop()
    options.onEnd?.()
  }

  stream.on('data', onData)
  stream.once('error', onStreamError)
  stream.once('end', onEnd)
  return stop
}
