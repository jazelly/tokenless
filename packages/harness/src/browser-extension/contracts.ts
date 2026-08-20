import type { JsonValue } from '../contracts.js'

export const HARNESS_BROWSER_EXTENSION_PROTOCOL = 'tokenless.harness-browser-extension/v1' as const
export const BROWSER_PAGE_OBSERVE_TOOL = 'browser_page_observe' as const
export const BROWSER_PAGE_INPUT_TOOL = 'browser_page_input' as const

export type BrowserFailureCode =
  | 'inaccessible_page'
  | 'no_supported_control'
  | 'sensitive_control'
  | 'hidden_control'
  | 'disabled_control'
  | 'read_only_control'
  | 'detached_control'
  | 'ambiguous_control'
  | 'stale_document'
  | 'stale_observation'
  | 'approval_rejected'
  | 'extension_disconnected'
  | 'invalid_action'

export type BrowserExtensionPageBinding = {
  tabId: number
  documentId: string
  origin: string
  url: string
  title: string
  documentRevision: number
}

export type BrowserSemanticControl = {
  elementRef: string
  role: 'textbox'
  name: string
  label: string
  placeholder: string
  inputType: string
  valuePresence: 'empty' | 'present'
  visible: true
  enabled: true
  editable: true
  structuralHint: string
  contextText: string
}

export type BrowserPageObservation = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  kind: 'semantic_page_observation'
  page: {
    origin: string
    url: string
    title: string
    documentId: string
    documentRevision: number
  }
  observationRevision: number
  controls: readonly BrowserSemanticControl[]
}

export type BrowserPageInputAction = {
  elementRef: string
  text: string
}

export type BrowserPageInputResult = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  kind: 'input_result'
  status: 'succeeded' | 'failed'
  elementRef: string
  documentRevision: number
  observationRevision: number
  valueEvidence: {
    state: 'present' | 'not_verified'
    length?: number
    sha256?: string
  }
  failure?: {
    code: BrowserFailureCode
    message: string
  }
}

export type BrowserActionProposal = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  kind: 'input_proposal'
  actionId: string
  runId: string
  callId: string
  argumentsDigest: string
  status: 'awaiting_approval' | 'applying'
  target: {
    elementRef: string
    label: string
    name: string
    inputType: string
  }
  text: string
  page: BrowserExtensionPageBinding
  observationRevision: number
}

export type BrowserActionResultRequest = {
  actionId: string
  runId: string
  result: BrowserPageInputResult
}

export type BrowserSessionSummary = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  sessionId: string
  extensionId: string
  page: BrowserExtensionPageBinding
}

export type BrowserPairingSummary = {
  pairingId: string
  extensionId: string
  extensionVersion: string
  provider?: string
  profileId?: string
  status: 'active' | 'revoked'
  createdAt: string
  lastAttachedAt?: string
}

export function isBrowserPageObservation(value: unknown): value is BrowserPageObservation {
  if (!isRecord(value) || value.protocol !== HARNESS_BROWSER_EXTENSION_PROTOCOL || value.kind !== 'semantic_page_observation') return false
  if (!isRecord(value.page) || typeof value.page.origin !== 'string' || typeof value.page.url !== 'string' ||
    typeof value.page.title !== 'string' || typeof value.page.documentId !== 'string' ||
    !Number.isSafeInteger(value.page.documentRevision) || !Number.isSafeInteger(value.observationRevision) ||
    !Array.isArray(value.controls)) return false
  if (!isCanonicalPage(value.page) || value.controls.length > 64 || value.observationRevision < 1 ||
    value.controls.some((control) => !isSemanticControl(control))) return false
  const refs = value.controls.map((control) => control.elementRef)
  return new Set(refs).size === refs.length
}

export function isBrowserPageInputResult(value: unknown): value is BrowserPageInputResult {
  if (!isRecord(value) || value.protocol !== HARNESS_BROWSER_EXTENSION_PROTOCOL || value.kind !== 'input_result' ||
    (value.status !== 'succeeded' && value.status !== 'failed') || typeof value.elementRef !== 'string' ||
    !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 1 ||
    !Number.isSafeInteger(value.observationRevision) || value.observationRevision < 1 ||
    !isRecord(value.valueEvidence) || (value.valueEvidence.state !== 'present' && value.valueEvidence.state !== 'not_verified')) return false
  if (value.valueEvidence.state === 'present' &&
    (!Number.isSafeInteger(value.valueEvidence.length) || Number(value.valueEvidence.length) < 0 ||
      typeof value.valueEvidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.valueEvidence.sha256))) return false
  if (value.valueEvidence.state === 'not_verified' &&
    (value.valueEvidence.length !== undefined || value.valueEvidence.sha256 !== undefined)) return false
  if (value.status === 'succeeded') return value.failure === undefined && value.valueEvidence.state === 'present'
  return value.valueEvidence.state === 'not_verified' && isRecord(value.failure) &&
    isBrowserFailureCode(value.failure.code) && typeof value.failure.message === 'string' && value.failure.message.length <= 512
}

export function redactedInputResult(value: BrowserPageInputResult): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    status: value.status,
    elementRef: value.elementRef,
    documentRevision: value.documentRevision,
    observationRevision: value.observationRevision,
    valueEvidence: {
      state: value.valueEvidence.state,
      ...(value.valueEvidence.length === undefined ? {} : { length: value.valueEvidence.length }),
      ...(value.valueEvidence.sha256 === undefined ? {} : { sha256: value.valueEvidence.sha256 }),
    },
    ...(value.failure ? { failure: value.failure } : {}),
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSemanticControl(value: unknown): value is BrowserSemanticControl {
  return isRecord(value) && typeof value.elementRef === 'string' && /^element-[0-9a-f-]{36}$/u.test(value.elementRef) && value.role === 'textbox' &&
    boundedString(value.name, 160) && boundedString(value.label, 160) && boundedString(value.placeholder, 160) &&
    boundedString(value.inputType, 32) && (value.valuePresence === 'empty' || value.valuePresence === 'present') &&
    value.visible === true && value.enabled === true && value.editable === true &&
    boundedString(value.structuralHint, 160) && boundedString(value.contextText, 240)
}

function isCanonicalPage(value: Record<string, any>) {
  if (typeof value.origin !== 'string' || typeof value.url !== 'string' || typeof value.title !== 'string' ||
    typeof value.documentId !== 'string' || !/^document-[0-9a-f-]{36}$/u.test(value.documentId) ||
    !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 1 || value.title.length > 512 || value.url.length > 2048) return false
  try {
    const origin = new URL(value.origin)
    const url = new URL(value.url)
    return ['http:', 'https:'].includes(origin.protocol) && origin.origin === value.origin && origin.pathname === '/' &&
      !origin.username && !origin.password && url.origin === value.origin
  } catch {
    return false
  }
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength
}

function isBrowserFailureCode(value: unknown): value is BrowserFailureCode {
  return typeof value === 'string' && [
    'inaccessible_page', 'no_supported_control', 'sensitive_control', 'hidden_control', 'disabled_control',
    'read_only_control', 'detached_control', 'ambiguous_control', 'stale_document', 'stale_observation',
    'approval_rejected', 'extension_disconnected', 'invalid_action',
  ].includes(value)
}
