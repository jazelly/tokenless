import { localizeText } from './localization.js'
import { paintCliText, resolveCliColorEnabled } from './cli-output.js'

type WritableStream = {
  columns?: number
  isTTY?: boolean
  write(chunk: string): unknown
}

type TimerApi = {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(timer: unknown): void
}

export type SetupPresenterOptions = {
  enabled?: boolean
  stream?: WritableStream
  env?: NodeJS.ProcessEnv
  color?: boolean
  timers?: TimerApi
  animation?: boolean
  intervalMs?: number
}

export type SetupTerminalCapabilitiesOptions = {
  json?: boolean
  stdin?: { isTTY?: boolean }
  stdout?: { isTTY?: boolean }
  stderr?: { isTTY?: boolean }
}

export type SetupTerminalCapabilities = {
  canPrompt: boolean
  canPresent: boolean
}

type ExplainOptions = {
  title: string
  lines: readonly string[]
}

const SPINNER_FRAMES = Object.freeze(['-', '\\', '|', '/'])
const REPLACE_TERMINAL_LINE = '\u001b[2K\u001b[1G'

export const SETUP_MANAGED_PROFILE_DISCLOSURE = Object.freeze([
  'Keeps sign-ins between jobs inside a Tokenless-managed profile. Experimental import can copy only a selected Google Chrome profile as an opaque filesystem tree with explicit consent; it may fail by version or platform and does not guarantee sign-in-state transfer.',
])

export const SETUP_READINESS_DISCLOSURE = Object.freeze([
  'Checks visible sign-in state without submitting a prompt.',
])

export class SetupPresenter {
  private readonly enabled: boolean
  private readonly colorEnabled: boolean
  private readonly animationEnabled: boolean
  private readonly stream: WritableStream
  private readonly timers: TimerApi
  private readonly intervalMs: number

  constructor(options: SetupPresenterOptions = {}) {
    const env = options.env ?? process.env
    this.enabled = options.enabled ?? true
    this.stream = options.stream ?? process.stderr
    this.colorEnabled = this.enabled && (options.color ?? resolveCliColorEnabled({}, { env, stream: this.stream }))
    this.animationEnabled = this.enabled &&
      options.animation !== false &&
      supportsAnimation(env)
    this.timers = options.timers ?? {
      setInterval: (callback, ms) => setInterval(callback, ms),
      clearInterval: (timer) => clearInterval(timer as NodeJS.Timeout),
    }
    this.intervalMs = options.intervalMs ?? 90
  }

  isEnabled() {
    return this.enabled
  }

  welcome() {
    if (!this.enabled) return
    this.write([
      '',
      this.paint('brightCyan', localizeText('Tokenless setup')),
      '',
    ].join('\n'))
  }

  explain({ title, lines }: ExplainOptions) {
    if (!this.enabled) return
    this.write(`${this.paint('bright', localizeText(title))}\n`)
    for (const line of lines) this.write(`  ${this.paint('dim', '-')} ${localizeText(line)}\n`)
  }

  note(message: string) {
    if (!this.enabled) return
    this.write(`  ${this.paint('yellow', '*')} ${localizeText(message)}\n`)
  }

  success(message: string) {
    if (!this.enabled) return
    this.write(`  ${this.paint('green', 'OK')} ${localizeText(message)}\n`)
  }

  async withProgress<T>(message: string, task: () => Promise<T>): Promise<T> {
    if (!this.enabled) return await task()

    let timer: unknown | null = null
    let frame = 0
    const render = () => {
      const prefix = this.animationEnabled
        ? `${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]}`
        : '-'
      this.writeProgress(prefix, localizeText(message))
    }

    if (this.animationEnabled) {
      render()
      timer = this.timers.setInterval(render, this.intervalMs)
    }

    try {
      const result = await task()
      if (timer !== null) this.timers.clearInterval(timer)
      if (this.animationEnabled) this.finishProgress('OK', localizeText(message), 'green')
      else this.success(message)
      return result
    } catch (error) {
      if (timer !== null) this.timers.clearInterval(timer)
      if (this.animationEnabled) this.finishProgress('X', localizeText(message), 'red')
      else this.write(`  ${this.paint('red', 'X')} ${localizeText(message)}\n`)
      throw error
    }
  }

  summary(message: string) {
    if (!this.enabled) return
    this.write(`\n${this.paint('brightGreen', localizeText(message))}\n`)
  }

  private writeProgress(prefix: string, message: string) {
    this.write(`${REPLACE_TERMINAL_LINE}${this.progressLine(prefix, message, '...', 'cyan')}`)
  }

  private finishProgress(prefix: string, message: string, color: keyof typeof ANSI_COLORS) {
    this.write(`${REPLACE_TERMINAL_LINE}${this.progressLine(prefix, message, '', color)}\n`)
  }

  private progressLine(prefix: string, message: string, suffix: string, color: keyof typeof ANSI_COLORS) {
    const fixed = `  ${prefix} `
    const maxWidth = terminalLineWidth(this.stream.columns)
    if (maxWidth <= fixed.length) return truncateLine(fixed.trimStart(), maxWidth)
    const detail = truncateLine(`${message}${suffix}`, maxWidth - fixed.length)
    return `  ${this.paint(color, prefix)} ${detail}`
  }

  private write(chunk: string) {
    this.stream.write(chunk)
  }

  private paint(color: keyof typeof ANSI_COLORS, value: string) {
    return paintCliText(value, color, this.colorEnabled)
  }
}

export function createSetupPresenter(options: SetupPresenterOptions = {}) {
  return new SetupPresenter(options)
}

export function resolveSetupTerminalCapabilities(options: SetupTerminalCapabilitiesOptions = {}): SetupTerminalCapabilities {
  const canPrompt = options.json !== true &&
    (options.stdin ?? process.stdin).isTTY === true &&
    (options.stdout ?? process.stdout).isTTY === true
  return {
    canPrompt,
    canPresent: canPrompt && (options.stderr ?? process.stderr).isTTY === true,
  }
}

export function supportsAnsi(env: NodeJS.ProcessEnv = process.env, stream?: WritableStream) {
  if ('NO_COLOR' in env) return false
  if (env.TERM === 'dumb') return false
  if (stream?.isTTY === false) return false
  return true
}

export function supportsAnimation(env: NodeJS.ProcessEnv = process.env) {
  if (env.TERM === 'dumb') return false
  if (env.CI && env.TOKENLESS_FORCE_ANIMATION !== '1') return false
  return true
}

function terminalLineWidth(columns: number | undefined) {
  if (columns === undefined || !Number.isFinite(columns)) return Number.POSITIVE_INFINITY
  return Math.max(1, Math.floor(columns) - 1)
}

function truncateLine(value: string, maxLength: number) {
  if (value.length <= maxLength) return value
  if (maxLength <= 1) return '…'.slice(0, Math.max(0, maxLength))
  return `${value.slice(0, maxLength - 1)}…`
}

const ANSI_COLORS = Object.freeze({
  bright: '1',
  dim: '2',
  cyan: '36',
  brightCyan: '96;1',
  green: '32',
  brightGreen: '92;1',
  yellow: '33',
  red: '31',
})
