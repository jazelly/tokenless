import { createHash, randomUUID } from 'node:crypto'

import {
  DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES,
  VISIBLE_ATTACHMENT_SCHEMA_ID,
  validateVisibleAttachmentDescriptor,
  type VisibleAttachmentDescriptor,
} from '../persistence/attachments.js'

type EphemeralJobState = {
  request: unknown
  checkpoint?: unknown
  result?: unknown
}

type JobShape = {
  job_id: string
  request_json: unknown
  checkpoint_json?: unknown
  result_json?: unknown
}

const PROMPT_MARKER_PREFIX = '[tokenless ephemeral provider payload:'
const jobs = new Map<string, EphemeralJobState>()
const attachments = new Map<string, Map<string, Buffer>>()

export async function stageEphemeralProviderAttachment(input: {
  stream: AsyncIterable<Uint8Array>
  bundleId: string
  name: string
  type: string
  maxBytes?: number | undefined
}): Promise<VisibleAttachmentDescriptor> {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_VISIBLE_ATTACHMENT_BYTES
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer.')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of input.stream) {
    const bytes = Buffer.from(chunk)
    size += bytes.byteLength
    if (size > maxBytes) throw new Error(`Visible attachment exceeds the ${maxBytes}-byte staging limit.`)
    chunks.push(bytes)
  }
  if (size < 1) throw new Error('Visible attachment must not be empty.')
  const buffer = Buffer.concat(chunks)
  const descriptor = validateVisibleAttachmentDescriptor({
    protocol: VISIBLE_ATTACHMENT_SCHEMA_ID,
    bundleId: input.bundleId,
    attachmentId: randomUUID(),
    name: input.name,
    type: input.type,
    size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  })
  const bundle = attachments.get(descriptor.bundleId) ?? new Map<string, Buffer>()
  if (bundle.has(descriptor.attachmentId)) throw new Error('Ephemeral attachment identity already exists.')
  bundle.set(descriptor.attachmentId, buffer)
  attachments.set(descriptor.bundleId, bundle)
  return descriptor
}

export function readEphemeralProviderAttachment(bundleId: string, attachmentId: string) {
  return attachments.get(bundleId)?.get(attachmentId)
}

export function hasEphemeralProviderBundle(bundleId: string) {
  return attachments.has(bundleId)
}

export function dropEphemeralProviderBundle(bundleId: string) {
  attachments.delete(bundleId)
}

export function registerEphemeralProviderJob(jobId: string, request: unknown) {
  jobs.set(jobId, { request })
  return redactRequest(request, jobId)
}

export function hydrateEphemeralProviderJob<T extends JobShape>(job: T): T {
  if (!hasEphemeralMarker(job.request_json, job.job_id)) return job
  const state = jobs.get(job.job_id)
  if (!state) throw new Error('Ephemeral provider payload is unavailable after daemon restart.')
  return {
    ...job,
    request_json: state.request,
    ...(state.checkpoint === undefined ? {} : { checkpoint_json: state.checkpoint }),
    ...(state.result === undefined ? {} : { result_json: state.result }),
  }
}

export function redactEphemeralProviderCheckpoint(jobId: string, checkpoint: unknown) {
  const state = jobs.get(jobId)
  if (!state) return checkpoint
  state.checkpoint = checkpoint
  return { protocol: 'tokenless.ephemeral-provider-state.v1', kind: 'checkpoint', redacted: true }
}

export function redactEphemeralProviderResult(jobId: string, result: unknown) {
  const state = jobs.get(jobId)
  if (!state) return result
  state.result = result
  return { protocol: 'tokenless.ephemeral-provider-state.v1', kind: 'result', redacted: true }
}

function redactRequest(value: unknown, jobId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Ephemeral provider request must be an object.')
  const request = value as Record<string, unknown>
  if (!Array.isArray(request.actions)) throw new TypeError('Ephemeral provider request actions are missing.')
  const marker = `${PROMPT_MARKER_PREFIX}${jobId}]`
  const context = request.context && typeof request.context === 'object' && !Array.isArray(request.context)
    ? request.context as Record<string, unknown>
    : undefined
  return {
    ...request,
    ...(context && Array.isArray(context.instructions) ? {
      context: {
        ...context,
        instructions: context.instructions.map((candidate) => (
          candidate && typeof candidate === 'object' && !Array.isArray(candidate)
            ? { ...(candidate as Record<string, unknown>), content: marker }
            : candidate
        )),
      },
    } : {}),
    actions: request.actions.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate
      const action = candidate as Record<string, unknown>
      if (action.action !== 'prompt.input') return candidate
      return { ...action, payload: { text: marker } }
    }),
  }
}

function hasEphemeralMarker(value: unknown, jobId: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actions = (value as { actions?: unknown }).actions
  if (!Array.isArray(actions)) return false
  const marker = `${PROMPT_MARKER_PREFIX}${jobId}]`
  return actions.some((candidate) => Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate) &&
    (candidate as { action?: unknown }).action === 'prompt.input' &&
    (candidate as { payload?: { text?: unknown } }).payload?.text === marker))
}
