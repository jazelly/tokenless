export const NATIVE_PROTOCOL_VERSION = 'tokenless.native.v1' as const

export const NATIVE_MESSAGE_TYPES = Object.freeze({
  DAEMON_CONNECT: 'tokenless.native.daemon_connect',
  DAEMON_CONNECTED: 'tokenless.native.daemon_connected',
  DAEMON_JOB: 'tokenless.native.daemon_job',
  DAEMON_READY: 'tokenless.native.daemon_ready',
  DAEMON_COMPLETE_JOB: 'tokenless.native.daemon_complete_job',
  DAEMON_ERROR: 'tokenless.native.daemon_error',
  READ_CONFIG: 'tokenless.native.read_config',
  WRITE_CONFIG: 'tokenless.native.write_config',
  LIST_HISTORY: 'tokenless.native.list_history',
})

export type NativeMessage = Record<string, unknown> & {
  protocol: typeof NATIVE_PROTOCOL_VERSION
  type: string
}

export function createNativeMessage(
  type: string,
  payload: Record<string, unknown> = {}
): NativeMessage {
  return Object.fromEntries(
    Object.entries({
      ...payload,
      protocol: NATIVE_PROTOCOL_VERSION,
      type,
    }).filter(([, value]) => value !== undefined)
  ) as NativeMessage
}

export function isNativeMessage(value: unknown): value is NativeMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<NativeMessage>
  return candidate.protocol === NATIVE_PROTOCOL_VERSION && typeof candidate.type === 'string'
}
