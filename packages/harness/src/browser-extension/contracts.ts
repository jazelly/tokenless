import type { JsonValue } from '../contracts.js'

export const HARNESS_BROWSER_EXTENSION_PROTOCOL = 'tokenless.harness-browser-extension/v2' as const
export const BROWSER_PAGE_OBSERVE_TOOL = 'browser_page_observe' as const
export const BROWSER_PAGE_INPUT_TOOL = 'browser_page_input' as const
export const BROWSER_PAGE_CLICK_TOOL = 'browser_page_click' as const
export const BROWSER_PAGE_SUBMIT_TOOL = 'browser_page_submit' as const
export const BROWSER_PAGE_RADIO_TOOL = 'browser_page_radio' as const
export const BROWSER_PAGE_UPLOAD_TOOL = 'browser_page_upload' as const
export const BROWSER_PAGE_NAVIGATE_TOOL = 'browser_page_navigate' as const

export const BROWSER_ACTION_TOOLS = [
  BROWSER_PAGE_INPUT_TOOL,
  BROWSER_PAGE_CLICK_TOOL,
  BROWSER_PAGE_SUBMIT_TOOL,
  BROWSER_PAGE_RADIO_TOOL,
  BROWSER_PAGE_UPLOAD_TOOL,
  BROWSER_PAGE_NAVIGATE_TOOL,
] as const

export type BrowserActionKind = 'input' | 'click' | 'submit' | 'radio' | 'upload' | 'navigate'
export type BrowserElementActionKind = Exclude<BrowserActionKind, 'navigate'>
export type BrowserToolName = typeof BROWSER_ACTION_TOOLS[number]

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
  role: 'textbox' | 'button' | 'radio' | 'file' | 'form'
  name: string
  label: string
  placeholder: string
  inputType: string
  valuePresence: 'empty' | 'present'
  checked?: boolean
  actions: readonly BrowserElementActionKind[]
  visible: true
  enabled: true
  editable: boolean
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

export type BrowserPageInputAction = { elementRef: string; text: string }
export type BrowserPageElementAction = { elementRef: string }
export type BrowserPageNavigateAction = { url: string }
export type BrowserPageAction = BrowserPageInputAction | BrowserPageElementAction | BrowserPageNavigateAction

export type BrowserActionResult = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  kind: 'action_result'
  action: BrowserActionKind
  status: 'succeeded' | 'failed'
  elementRef?: string
  documentRevision: number
  observationRevision: number
  evidence: {
    state: 'verified' | 'dispatched' | 'not_verified'
    length?: number
    sha256?: string
    checked?: boolean
    fileName?: string
    url?: string
  }
  failure?: {
    code: BrowserFailureCode
    message: string
  }
}

export type BrowserActionProposal = {
  protocol: typeof HARNESS_BROWSER_EXTENSION_PROTOCOL
  kind: 'action_proposal'
  action: BrowserActionKind
  actionId: string
  runId: string
  callId: string
  argumentsDigest: string
  status: 'awaiting_approval' | 'applying'
  target?: {
    elementRef: string
    label: string
    name: string
    inputType: string
  }
  text?: string
  url?: string
  page: BrowserExtensionPageBinding
  observationRevision: number
}

export type BrowserActionResultRequest = {
  actionId: string
  runId: string
  result: BrowserActionResult
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

export type BrowserPrivateEvidence = {
  rawDom: string
  screenshotDataUrl: string
  capturedAt: string
}

export function isBrowserPageObservation(value: unknown): value is BrowserPageObservation {
  if (!isRecord(value) || value.protocol !== HARNESS_BROWSER_EXTENSION_PROTOCOL || value.kind !== 'semantic_page_observation') return false
  if (!isRecord(value.page) || typeof value.page.origin !== 'string' || typeof value.page.url !== 'string' ||
    typeof value.page.title !== 'string' || typeof value.page.documentId !== 'string' ||
    !Number.isSafeInteger(value.page.documentRevision) || !Number.isSafeInteger(value.observationRevision) ||
    !Array.isArray(value.controls)) return false
  if (!isCanonicalPage(value.page) || value.controls.length > 128 || value.observationRevision < 1 ||
    value.controls.some((control) => !isSemanticControl(control))) return false
  const refs = value.controls.map((control) => control.elementRef)
  return new Set(refs).size === refs.length
}

export function isBrowserActionResult(value: unknown): value is BrowserActionResult {
  if (!isRecord(value) || value.protocol !== HARNESS_BROWSER_EXTENSION_PROTOCOL || value.kind !== 'action_result' ||
    !isBrowserActionKind(value.action) || (value.status !== 'succeeded' && value.status !== 'failed') ||
    (value.elementRef !== undefined && typeof value.elementRef !== 'string') ||
    !Number.isSafeInteger(value.documentRevision) || value.documentRevision < 1 ||
    !Number.isSafeInteger(value.observationRevision) || value.observationRevision < 1 || !isRecord(value.evidence) ||
    !['verified', 'dispatched', 'not_verified'].includes(String(value.evidence.state))) return false
  if (value.evidence.length !== undefined && (!Number.isSafeInteger(value.evidence.length) || Number(value.evidence.length) < 0)) return false
  if (value.evidence.sha256 !== undefined && (typeof value.evidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.evidence.sha256))) return false
  if (value.evidence.checked !== undefined && typeof value.evidence.checked !== 'boolean') return false
  if (value.evidence.fileName !== undefined && !boundedString(value.evidence.fileName, 512)) return false
  if (value.evidence.url !== undefined && !isSafeNavigationUrl(value.evidence.url)) return false
  if (value.status === 'succeeded') return value.failure === undefined && value.evidence.state !== 'not_verified'
  return value.evidence.state === 'not_verified' && isRecord(value.failure) &&
    isBrowserFailureCode(value.failure.code) && boundedString(value.failure.message, 512)
}

export function redactedActionResult(value: BrowserActionResult): JsonValue {
  return {
    protocol: value.protocol,
    kind: value.kind,
    action: value.action,
    status: value.status,
    ...(value.elementRef === undefined ? {} : { elementRef: value.elementRef }),
    documentRevision: value.documentRevision,
    observationRevision: value.observationRevision,
    evidence: value.evidence,
    ...(value.failure ? { failure: value.failure } : {}),
  }
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function isSafeNavigationUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch {
    return false
  }
}

function isSemanticControl(value: unknown): value is BrowserSemanticControl {
  if (!isRecord(value) || typeof value.elementRef !== 'string' || !/^element-[0-9a-f-]{36}$/u.test(value.elementRef) ||
    !['textbox', 'button', 'radio', 'file', 'form'].includes(String(value.role)) ||
    !boundedString(value.name, 160) || !boundedString(value.label, 160) || !boundedString(value.placeholder, 160) ||
    !boundedString(value.inputType, 32) || !['empty', 'present'].includes(String(value.valuePresence)) ||
    (value.checked !== undefined && typeof value.checked !== 'boolean') || !Array.isArray(value.actions) ||
    value.actions.length === 0 || value.actions.some((action) => !isBrowserElementActionKind(action)) ||
    value.visible !== true || value.enabled !== true || typeof value.editable !== 'boolean' ||
    !boundedString(value.structuralHint, 160) || !boundedString(value.contextText, 240)) return false
  const permitted: Record<BrowserSemanticControl['role'], readonly BrowserElementActionKind[]> = {
    textbox: ['input'], button: ['click', 'submit'], radio: ['radio'], file: ['upload'], form: ['submit'],
  }
  return value.actions.every((action) => permitted[value.role as BrowserSemanticControl['role']].includes(action))
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
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0')
}

function isBrowserActionKind(value: unknown): value is BrowserActionKind {
  return typeof value === 'string' && ['input', 'click', 'submit', 'radio', 'upload', 'navigate'].includes(value)
}

function isBrowserElementActionKind(value: unknown): value is BrowserElementActionKind {
  return typeof value === 'string' && ['input', 'click', 'submit', 'radio', 'upload'].includes(value)
}

function isBrowserFailureCode(value: unknown): value is BrowserFailureCode {
  return typeof value === 'string' && [
    'inaccessible_page', 'no_supported_control', 'sensitive_control', 'hidden_control', 'disabled_control',
    'read_only_control', 'detached_control', 'ambiguous_control', 'stale_document', 'stale_observation',
    'approval_rejected', 'extension_disconnected', 'invalid_action',
  ].includes(value)
}
