export const NATIVE_PROTOCOL_VERSION = 'tokenless.native.v1' as const
export const VISIBLE_ATTACHMENT_PROTOCOL_VERSION = 'tokenless.visible-attachment.v1' as const
export const MAX_VISIBLE_ATTACHMENT_CHUNK_BYTES = 512 * 1024

export const NATIVE_MESSAGE_TYPES = Object.freeze({
  DAEMON_CONNECT: 'tokenless.native.daemon_connect',
  DAEMON_CONNECTED: 'tokenless.native.daemon_connected',
  DAEMON_JOB: 'tokenless.native.daemon_job',
  DAEMON_READY: 'tokenless.native.daemon_ready',
  DAEMON_COMPLETE_JOB: 'tokenless.native.daemon_complete_job',
  ATTACHMENT_OPEN: 'tokenless.native.attachment_open',
  ATTACHMENT_READ: 'tokenless.native.attachment_read',
  ATTACHMENT_CLOSE: 'tokenless.native.attachment_close',
  DAEMON_ERROR: 'tokenless.native.daemon_error',
  READ_CONFIG: 'tokenless.native.read_config',
  WRITE_CONFIG: 'tokenless.native.write_config',
  LIST_HISTORY: 'tokenless.native.list_history',
})

export type NativeAttachmentDescriptor = {
  protocol: typeof VISIBLE_ATTACHMENT_PROTOCOL_VERSION
  bundleId: string
  attachmentId: string
  name: string
  type: string
  size: number
  sha256: string
}

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

export function isNativeAttachmentDescriptor(value: unknown): value is NativeAttachmentDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const descriptor = value as Partial<NativeAttachmentDescriptor> & Record<string, unknown>
  const keys = Object.keys(descriptor)
  if (keys.some((key) => !['protocol', 'bundleId', 'attachmentId', 'name', 'type', 'size', 'sha256'].includes(key))) {
    return false
  }
  return descriptor.protocol === VISIBLE_ATTACHMENT_PROTOCOL_VERSION &&
    safeAttachmentId(descriptor.bundleId) &&
    safeAttachmentId(descriptor.attachmentId) &&
    typeof descriptor.name === 'string' &&
    descriptor.name.length > 0 &&
    !descriptor.name.includes('\0') &&
    !descriptor.name.includes('/') &&
    !descriptor.name.includes('\\') &&
    new TextEncoder().encode(descriptor.name).byteLength <= 512 &&
    typeof descriptor.type === 'string' &&
    /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(descriptor.type) &&
    new TextEncoder().encode(descriptor.type).byteLength <= 255 &&
    typeof descriptor.size === 'number' &&
    Number.isSafeInteger(descriptor.size) &&
    descriptor.size >= 0 &&
    typeof descriptor.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(descriptor.sha256)
}

function safeAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
}
