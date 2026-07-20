type WritableStream = {
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

export const SETUP_MANAGED_PROFILE_DISCLOSURE = Object.freeze([
  'Keeps sign-ins between jobs. Imports copy selected provider cookies only; other browser data is excluded.',
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
  private lastProgressWidth = 0

  constructor(options: SetupPresenterOptions = {}) {
    const env = options.env ?? process.env
    this.enabled = options.enabled ?? true
    this.colorEnabled = this.enabled && supportsAnsi(env)
    this.animationEnabled = this.enabled &&
      options.animation !== false &&
      supportsAnimation(env)
    this.stream = options.stream ?? process.stderr
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
      this.paint('brightCyan', 'Tokenless setup'),
      '',
    ].join('\n'))
  }

  explain({ title, lines }: ExplainOptions) {
    if (!this.enabled) return
    this.write(`${this.paint('bright', title)}\n`)
    for (const line of lines) this.write(`  ${this.paint('dim', '-')} ${line}\n`)
  }

  note(message: string) {
    if (!this.enabled) return
    this.write(`  ${this.paint('cyan', '*')} ${message}\n`)
  }

  success(message: string) {
    if (!this.enabled) return
    this.write(`  ${this.paint('green', 'OK')} ${message}\n`)
  }

  handover(provider: string, detail: string, nextStep = 'Finish in the already-open Tokenless-managed Chrome window/tab, then press Enter here. The same job will resume.') {
    if (!this.enabled) return
    this.write([
      this.paint('yellow', `Visible ${provider} handoff`),
      `  ${this.paint('dim', '-')} ${detail}`,
      `  ${this.paint('dim', '-')} ${nextStep}`,
    ].join('\n') + '\n')
  }

  async withProgress<T>(message: string, task: () => Promise<T>): Promise<T> {
    if (!this.enabled) return await task()

    let timer: unknown | null = null
    let frame = 0
    const render = () => {
      const prefix = this.animationEnabled
        ? `${SPINNER_FRAMES[frame++ % SPINNER_FRAMES.length]}`
        : '-'
      this.writeProgress(`${this.paint('cyan', prefix)} ${message}...`)
    }

    if (this.animationEnabled) {
      render()
      timer = this.timers.setInterval(render, this.intervalMs)
    } else {
      this.write(`  - ${message}...\n`)
    }

    try {
      const result = await task()
      if (timer !== null) this.timers.clearInterval(timer)
      this.clearProgress()
      this.success(message)
      return result
    } catch (error) {
      if (timer !== null) this.timers.clearInterval(timer)
      this.clearProgress()
      this.write(`  ${this.paint('red', 'X')} ${message}\n`)
      throw error
    }
  }

  summary(message: string) {
    if (!this.enabled) return
    this.write(`\n${this.paint('brightGreen', message)}\n`)
  }

  private writeProgress(line: string) {
    const visible = stripAnsi(line)
    this.lastProgressWidth = Math.max(this.lastProgressWidth, visible.length)
    this.write(`\r  ${line}${' '.repeat(Math.max(0, this.lastProgressWidth - visible.length))}`)
  }

  private clearProgress() {
    if (this.lastProgressWidth === 0) return
    this.write(`\r${' '.repeat(this.lastProgressWidth + 2)}\r`)
    this.lastProgressWidth = 0
  }

  private write(chunk: string) {
    this.stream.write(chunk)
  }

  private paint(color: keyof typeof ANSI_COLORS, value: string) {
    if (!this.colorEnabled) return value
    const code = ANSI_COLORS[color]
    return `\u001b[${code}m${value}\u001b[0m`
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

export function supportsAnsi(env: NodeJS.ProcessEnv = process.env) {
  if ('NO_COLOR' in env) return false
  if (env.TERM === 'dumb') return false
  return true
}

export function supportsAnimation(env: NodeJS.ProcessEnv = process.env) {
  if (env.TERM === 'dumb') return false
  if (env.CI && env.TOKENLESS_FORCE_ANIMATION !== '1') return false
  return true
}

function stripAnsi(value: string) {
  return value.replace(/\u001b\[[0-9;]*m/g, '')
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
