export type CliOutputOptions = {
  json?: boolean
  color?: boolean
  noColor?: boolean
}

export type CliColor = 'bright' | 'brightCyan' | 'brightGreen' | 'cyan' | 'dim' | 'green' | 'red' | 'yellow'

type ColorStream = {
  isTTY?: boolean
  hasColors?: (...args: any[]) => boolean
}

const ANSI_COLORS: Readonly<Record<CliColor, string>> = Object.freeze({
  bright: '1',
  brightCyan: '96;1',
  brightGreen: '92;1',
  cyan: '36',
  dim: '2',
  green: '32',
  red: '31',
  yellow: '33',
})

export function resolveCliColorEnabled(
  options: CliOutputOptions = {},
  {
    env = process.env,
    stream = process.stdout,
  }: {
    env?: NodeJS.ProcessEnv
    stream?: ColorStream
  } = {},
) {
  if (options.json === true || options.noColor === true) return false
  if (options.color === true) return true
  if ('NO_COLOR' in env || env.TERM === 'dumb') return false
  if (stream.isTTY !== true) return false
  try {
    return typeof stream.hasColors === 'function' ? stream.hasColors() : true
  } catch {
    return false
  }
}

export function paintCliText(value: string, color: CliColor, enabled: boolean) {
  if (!enabled) return value
  return `\u001b[${ANSI_COLORS[color]}m${value}\u001b[0m`
}
