import {
  createNativeMessage,
  isNativeMessage,
  NATIVE_MESSAGE_TYPES,
} from '../shared/native-protocol.js'
import type { NativeMessage } from '../shared/native-protocol.js'

export type NativeDaemonBridgeTiming = {
  handshakeTimeoutMs: number
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
}

export type NativeDaemonBridgeOptions = {
  connectNative: () => chrome.runtime.Port
  onMessage: (port: chrome.runtime.Port, message: NativeMessage) => void
  timing?: Partial<NativeDaemonBridgeTiming>
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

const DEFAULT_TIMING: NativeDaemonBridgeTiming = Object.freeze({
  handshakeTimeoutMs: 5000,
  reconnectInitialDelayMs: 250,
  reconnectMaxDelayMs: 30000,
})

export class NativeDaemonBridge {
  readonly #connectNative: NativeDaemonBridgeOptions['connectNative']
  readonly #onMessage: NativeDaemonBridgeOptions['onMessage']
  readonly #timing: NativeDaemonBridgeTiming
  readonly #setTimer: typeof setTimeout
  readonly #clearTimer: typeof clearTimeout
  #port: chrome.runtime.Port | null = null
  #connected = false
  #stopped = false
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #nextReconnectDelayMs: number

  constructor(options: NativeDaemonBridgeOptions) {
    this.#connectNative = options.connectNative
    this.#onMessage = options.onMessage
    this.#timing = normalizeTiming(options.timing)
    const setTimer = options.setTimer ?? globalThis.setTimeout
    const clearTimer = options.clearTimer ?? globalThis.clearTimeout
    this.#setTimer = ((...args: Parameters<typeof setTimeout>) => (
      Reflect.apply(setTimer, globalThis, args)
    )) as typeof setTimeout
    this.#clearTimer = ((...args: Parameters<typeof clearTimeout>) => {
      Reflect.apply(clearTimer, globalThis, args)
    }) as typeof clearTimeout
    this.#nextReconnectDelayMs = this.#timing.reconnectInitialDelayMs
  }

  start() {
    this.#stopped = false
    if (this.#port || this.#reconnectTimer) return
    this.#connect()
  }

  stop() {
    this.#stopped = true
    this.#clearHandshakeTimer()
    this.#clearReconnectTimer()
    const port = this.#port
    this.#port = null
    this.#connected = false
    if (port) disconnectQuietly(port)
  }

  isConnectedPort(port: chrome.runtime.Port) {
    return this.#port === port && this.#connected
  }

  postIfConnected(port: chrome.runtime.Port, message: NativeMessage) {
    if (!this.isConnectedPort(port)) return false
    try {
      port.postMessage(message)
      return true
    } catch {
      this.#failPort(port)
      return false
    }
  }

  #connect() {
    if (this.#stopped || this.#port || this.#reconnectTimer) return

    let port: chrome.runtime.Port
    try {
      port = this.#connectNative()
    } catch {
      this.#scheduleReconnect()
      return
    }

    this.#port = port
    this.#connected = false
    try {
      port.onMessage.addListener((message) => this.#handleMessage(port, message))
      port.onDisconnect.addListener(() => this.#handleDisconnect(port))
      this.#handshakeTimer = this.#setTimer(() => {
        if (this.#port === port && !this.#connected) {
          this.#failPort(port)
        }
      }, this.#timing.handshakeTimeoutMs)
      port.postMessage(createNativeMessage(NATIVE_MESSAGE_TYPES.DAEMON_CONNECT))
    } catch {
      this.#failPort(port)
    }
  }

  #handleMessage(port: chrome.runtime.Port, message: unknown) {
    if (this.#port !== port) return

    if (!isNativeMessage(message)) {
      this.#failPort(port)
      return
    }

    if (!this.#connected) {
      if (message.type === NATIVE_MESSAGE_TYPES.DAEMON_CONNECTED && message.ok === true) {
        this.#connected = true
        this.#clearHandshakeTimer()
        this.#nextReconnectDelayMs = this.#timing.reconnectInitialDelayMs
        return
      }
      this.#failPort(port)
      return
    }

    if (message.type === NATIVE_MESSAGE_TYPES.DAEMON_ERROR || message.ok === false) {
      this.#failPort(port)
      return
    }

    if (message.type === NATIVE_MESSAGE_TYPES.DAEMON_CONNECTED) return
    this.#onMessage(port, message)
  }

  #handleDisconnect(port: chrome.runtime.Port) {
    if (this.#port !== port) return
    this.#port = null
    this.#connected = false
    this.#clearHandshakeTimer()
    this.#scheduleReconnect()
  }

  #failPort(port: chrome.runtime.Port) {
    if (this.#port !== port) return
    this.#port = null
    this.#connected = false
    this.#clearHandshakeTimer()
    disconnectQuietly(port)
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#port || this.#reconnectTimer) return
    const delayMs = this.#nextReconnectDelayMs
    this.#nextReconnectDelayMs = Math.min(
      this.#timing.reconnectMaxDelayMs,
      Math.max(this.#timing.reconnectInitialDelayMs, delayMs * 2)
    )
    this.#reconnectTimer = this.#setTimer(() => {
      this.#reconnectTimer = null
      this.#connect()
    }, delayMs)
  }

  #clearHandshakeTimer() {
    if (!this.#handshakeTimer) return
    this.#clearTimer(this.#handshakeTimer)
    this.#handshakeTimer = null
  }

  #clearReconnectTimer() {
    if (!this.#reconnectTimer) return
    this.#clearTimer(this.#reconnectTimer)
    this.#reconnectTimer = null
  }
}

function normalizeTiming(value: Partial<NativeDaemonBridgeTiming> | undefined): NativeDaemonBridgeTiming {
  const handshakeTimeoutMs = positiveNumber(value?.handshakeTimeoutMs, DEFAULT_TIMING.handshakeTimeoutMs)
  const reconnectInitialDelayMs = positiveNumber(
    value?.reconnectInitialDelayMs,
    DEFAULT_TIMING.reconnectInitialDelayMs
  )
  return {
    handshakeTimeoutMs,
    reconnectInitialDelayMs,
    reconnectMaxDelayMs: Math.max(
      reconnectInitialDelayMs,
      positiveNumber(value?.reconnectMaxDelayMs, DEFAULT_TIMING.reconnectMaxDelayMs)
    ),
  }
}

function positiveNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function disconnectQuietly(port: chrome.runtime.Port) {
  try {
    port.disconnect()
  } catch {
    // The native process may already be gone.
  }
}
