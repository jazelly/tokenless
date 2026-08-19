import * as Ajv2020Module from 'ajv/dist/2020.js'
import type { Ajv2020 as Ajv2020Instance } from 'ajv/dist/2020.js'
import * as AddFormatsModule from 'ajv-formats'
import type { FormatsPlugin } from 'ajv-formats'

const Ajv2020 = (Ajv2020Module.default ?? Ajv2020Module) as unknown as new (
  options?: ConstructorParameters<typeof Ajv2020Instance>[0]
) => Ajv2020Instance
const addFormats = (AddFormatsModule.default ?? AddFormatsModule) as unknown as FormatsPlugin

const MAX_JSON_DEPTH = 48
const MAX_JSON_PROPERTIES = 10_000

export class StrictJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StrictJsonError'
  }
}

export class MarkerExtractionError extends Error {
  constructor(readonly reason: 'count' | 'order') {
    super(reason === 'count' ? 'Expected exactly one marker pair.' : 'Markers are not ordered.')
    this.name = 'MarkerExtractionError'
  }
}

export function createAjv2020() {
  const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false })
  addFormats(ajv)
  return ajv
}

export function extractExactlyOneMarkedValue(value: string, openMarker: string, closeMarker: string) {
  if (countOccurrences(value, openMarker) !== 1 || countOccurrences(value, closeMarker) !== 1) {
    throw new MarkerExtractionError('count')
  }
  const open = value.indexOf(openMarker)
  const close = value.indexOf(closeMarker)
  if (open < 0 || close < open + openMarker.length) throw new MarkerExtractionError('order')
  return {
    before: value.slice(0, open),
    content: value.slice(open + openMarker.length, close),
    after: value.slice(close + closeMarker.length),
    marked: value.slice(open, close + closeMarker.length),
  }
}

export function parseStrictJson(source: string, options: { exactNumbers?: boolean } = {}) {
  let properties = 0

  function parseValue(index: number, depth: number): number {
    if (depth > MAX_JSON_DEPTH) fail('JSON exceeds the maximum nesting depth')
    index = skipWhitespace(index)
    const token = source[index]
    if (token === '"') return parseString(index).end
    if (token === '{') return parseObject(index, depth + 1)
    if (token === '[') return parseArray(index, depth + 1)
    if (token === 't' && source.startsWith('true', index)) return index + 4
    if (token === 'f' && source.startsWith('false', index)) return index + 5
    if (token === 'n' && source.startsWith('null', index)) return index + 4
    return parseNumber(index)
  }

  function parseObject(index: number, depth: number): number {
    const keys = new Set<string>()
    index = skipWhitespace(index + 1)
    if (source[index] === '}') return index + 1
    while (index < source.length) {
      if (source[index] !== '"') fail('JSON object keys must be strings')
      const parsed = parseString(index)
      if (keys.has(parsed.value)) fail(`JSON object contains duplicate key '${parsed.value}'`)
      keys.add(parsed.value)
      properties += 1
      if (properties > MAX_JSON_PROPERTIES) fail('JSON exceeds the maximum property count')
      index = skipWhitespace(parsed.end)
      if (source[index] !== ':') fail('JSON object key must be followed by a colon')
      index = skipWhitespace(parseValue(index + 1, depth))
      if (source[index] === '}') return index + 1
      if (source[index] !== ',') fail('JSON object entries must be separated by commas')
      index = skipWhitespace(index + 1)
    }
    fail('JSON object is not closed')
  }

  function parseArray(index: number, depth: number): number {
    index = skipWhitespace(index + 1)
    if (source[index] === ']') return index + 1
    while (index < source.length) {
      index = skipWhitespace(parseValue(index, depth))
      if (source[index] === ']') return index + 1
      if (source[index] !== ',') fail('JSON array entries must be separated by commas')
      index = skipWhitespace(index + 1)
    }
    fail('JSON array is not closed')
  }

  function parseString(index: number) {
    const start = index
    index += 1
    while (index < source.length) {
      const code = source.charCodeAt(index)
      if (code === 0x22) {
        const raw = source.slice(start, index + 1)
        try {
          return { end: index + 1, value: JSON.parse(raw) as string }
        } catch {
          fail('JSON string escape is invalid')
        }
      }
      if (code === 0x5c) {
        index += 1
        if (index >= source.length) fail('JSON string escape is incomplete')
        if (source[index] === 'u') {
          const hex = source.slice(index + 1, index + 5)
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('JSON unicode escape is invalid')
          index += 4
        } else if (!'"\\/bfnrt'.includes(source[index]!)) {
          fail('JSON string escape is invalid')
        }
      } else if (code < 0x20) {
        fail('JSON strings cannot contain unescaped control characters')
      }
      index += 1
    }
    fail('JSON string is not closed')
  }

  function parseNumber(index: number) {
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (!match || match.index !== 0) fail('JSON contains an invalid value')
    if (options.exactNumbers) {
      const token = match[0]
      const value = Number(token)
      if (
        !Number.isFinite(value) ||
        (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
        JSON.stringify(value) !== token
      ) {
        fail('structured JSON numbers must be canonical finite values, and integers must be safe integers')
      }
    }
    return index + match[0].length
  }

  function skipWhitespace(index: number) {
    while (index < source.length && /[\t\n\r ]/.test(source[index]!)) index += 1
    return index
  }

  const end = skipWhitespace(parseValue(0, 0))
  if (end !== source.length) fail('JSON contains trailing content')
  try {
    return JSON.parse(source) as unknown
  } catch {
    fail('JSON is invalid')
  }
}

function countOccurrences(value: string, needle: string) {
  return value.split(needle).length - 1
}

function fail(message: string): never {
  throw new StrictJsonError(message)
}
