import { createBridgeRequest, validateBridgeRequest } from './protocol.js'

export class BrowserSessionBridgeUnavailableError extends Error {
  code: string

  constructor(message = 'Tokenless extension runtime is unavailable.') {
    super(message)
    this.name = 'BrowserSessionBridgeUnavailableError'
    this.code = 'browser_session_bridge_unavailable'
  }
}

type ExtensionRuntime = typeof chrome.runtime
type ExternalExtensionClientOptions = {
  extensionId?: string
  runtime?: ExtensionRuntime
}

export function createExternalExtensionClient({ extensionId, runtime = globalThis.chrome?.runtime }: ExternalExtensionClientOptions = {}) {
  if (typeof extensionId !== 'string' || extensionId.trim() === '') {
    throw new TypeError('extensionId must be a nonempty string.')
  }

  return {
    async request(input: Record<string, any>) {
      const request = createBridgeRequest(input)
      const validation = validateBridgeRequest(request)
      if (validation.ok === false) {
        return {
          protocol: request.protocol,
          requestId: request.requestId,
          ok: false,
          provider: request.provider ?? null,
          action: request.action ?? null,
          result: null,
          error: validation.error,
        }
      }

      if (!runtime?.sendMessage) {
        throw new BrowserSessionBridgeUnavailableError()
      }

      return sendRuntimeMessage(runtime, extensionId, request)
    },
  }
}

function sendRuntimeMessage(runtime: ExtensionRuntime, extensionId: string, request: Record<string, any>) {
  return new Promise((resolve, reject) => {
    runtime.sendMessage(extensionId, request, (response) => {
      const lastError = runtime.lastError
      if (lastError) {
        reject(new BrowserSessionBridgeUnavailableError(lastError.message))
        return
      }
      resolve(response)
    })
  })
}
