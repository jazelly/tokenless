import { HarnessSkillError } from '../contracts.js'

const MAX_JSON_DEPTH = 48
const MAX_JSON_PROPERTIES = 10_000

export function parseStrictJson(source: string) {
  let properties = 0

  function parseValue(index: number, depth: number): number {
    if (depth > MAX_JSON_DEPTH) fail('JSON exceeds the maximum nesting depth.')
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
      if (source[index] !== '"') fail('JSON object keys must be strings.')
      const parsed = parseString(index)
      if (keys.has(parsed.value)) fail(`JSON object contains duplicate key '${parsed.value}'.`)
      keys.add(parsed.value)
      properties += 1
      if (properties > MAX_JSON_PROPERTIES) fail('JSON exceeds the maximum property count.')
      index = skipWhitespace(parsed.end)
      if (source[index] !== ':') fail('JSON object key must be followed by a colon.')
      index = skipWhitespace(parseValue(index + 1, depth))
      if (source[index] === '}') return index + 1
      if (source[index] !== ',') fail('JSON object entries must be separated by commas.')
      index = skipWhitespace(index + 1)
    }
    fail('JSON object is not closed.')
  }

  function parseArray(index: number, depth: number): number {
    index = skipWhitespace(index + 1)
    if (source[index] === ']') return index + 1
    while (index < source.length) {
      index = skipWhitespace(parseValue(index, depth))
      if (source[index] === ']') return index + 1
      if (source[index] !== ',') fail('JSON array entries must be separated by commas.')
      index = skipWhitespace(index + 1)
    }
    fail('JSON array is not closed.')
  }

  function parseString(index: number) {
    const start = index
    index += 1
    while (index < source.length) {
      const code = source.charCodeAt(index)
      if (code === 0x22) {
        const raw = source.slice(start, index + 1)
        let value: string
        try {
          value = JSON.parse(raw) as string
        } catch {
          fail('JSON string escape is invalid.')
        }
        return { end: index + 1, value }
      }
      if (code === 0x5c) {
        index += 1
        if (index >= source.length) fail('JSON string escape is incomplete.')
        if (source[index] === 'u') {
          const hex = source.slice(index + 1, index + 5)
          if (!/^[0-9A-Fa-f]{4}$/.test(hex)) fail('JSON unicode escape is invalid.')
          index += 4
        } else if (!'"\\/bfnrt'.includes(source[index]!)) {
          fail('JSON string escape is invalid.')
        }
      } else if (code < 0x20) {
        fail('JSON strings cannot contain unescaped control characters.')
      }
      index += 1
    }
    fail('JSON string is not closed.')
  }

  function parseNumber(index: number) {
    const match = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(index))
    if (!match || match.index !== 0) fail('JSON contains an invalid value.')
    return index + match[0].length
  }

  function skipWhitespace(index: number) {
    while (index < source.length && /[\t\n\r ]/.test(source[index]!)) index += 1
    return index
  }

  function fail(message: string): never {
    throw new HarnessSkillError('harness_response_json_invalid', message)
  }

  const end = skipWhitespace(parseValue(0, 0))
  if (end !== source.length) fail('JSON contains trailing content.')
  try {
    return JSON.parse(source) as unknown
  } catch {
    fail('Harness response contains invalid JSON.')
  }
}
