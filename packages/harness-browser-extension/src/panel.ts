import { actionLabel, destination, getLanguage, proposedText, stateLabel, t, tabAttachedLocally, type Language } from './i18n.js'

const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:7331'

type Stored = { daemonOrigin?: string; credential?: string }
type Page = { tabId: number; origin: string; url: string; title: string; documentId: string; documentRevision: number }
type Observation = {
  protocol: string
  kind: string
  page: Omit<Page, 'tabId'>
  observationRevision: number
  controls: Array<{
    elementRef: string
    role: string
    name: string
    label: string
    inputType: string
    valuePresence: string
    checked?: boolean
    actions: string[]
  }>
}
type PrivateEvidence = { rawDom: string; screenshotDataUrl: string; capturedAt: string }
type Proposal = {
  actionId: string
  action: 'input' | 'click' | 'submit' | 'radio' | 'upload' | 'navigate'
  runId: string
  callId: string
  argumentsDigest: string
  status: 'awaiting_approval' | 'applying'
  target?: { elementRef: string; label: string; name: string; inputType: string }
  text?: string
  url?: string
  page: Page
  observationRevision: number
}
type RunView = { runId: string; status: string; final?: { output: string }; error?: { message: string } }

type ConnectionState =
  | { kind: 'notPaired' }
  | { kind: 'paired' }
  | { kind: 'credentialNeedsPairing' }
  | { kind: 'error'; message: string }
type PageState = { kind: 'none' } | { kind: 'attached'; title: string; origin: string }
type RunStatusState =
  | { kind: 'noRun' }
  | { kind: 'pairFirst' }
  | { kind: 'consentRequired' }
  | { kind: 'enterTask' }
  | { kind: 'selectOneFile' }
  | { kind: 'tabAttached'; count: number }
  | { kind: 'state'; state: string }
  | { kind: 'error'; message: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const connection = $('connection')
const connectionBadge = $('connection-badge')
const pageStatus = $('page')
const pageOrigin = $('origin')
const contextDot = document.querySelector('.context-dot') as HTMLElement
const attachButton = $<HTMLButtonElement>('attach')
const taskForm = $<HTMLFormElement>('task-form')
const task = $<HTMLTextAreaElement>('task')
const runButton = $<HTMLButtonElement>('run')
const cancelButton = $<HTMLButtonElement>('cancel')
const runStatus = $('run-status')
const finalOutput = $('final')
const approval = $('approval')
const proposalText = $('proposal')
const approveButton = $<HTMLButtonElement>('approve')
const rejectButton = $<HTMLButtonElement>('reject')
const uploadLabel = $('upload-label')
const uploadFile = $<HTMLInputElement>('upload-file')
const permission = $('permission')
const allowAccessButton = $<HTMLButtonElement>('allow-access')
const notNowButton = $<HTMLButtonElement>('not-now')
const privacyToggle = $<HTMLButtonElement>('privacy-toggle')
const privacyPopover = $('privacy-popover')

let credential = ''
let daemonOrigin = DEFAULT_DAEMON_ORIGIN
let sessionId = ''
let selectedPage: Page | undefined
let observation: Observation | undefined
let initialEvidence: PrivateEvidence | undefined
let runId = ''
let proposal: Proposal | undefined
let stopped = true
let detached = false
let consentGranted = false
const appliedActions = new Set<string>()

let language: Language = 'en'
let connectionState: ConnectionState = { kind: 'notPaired' }
let pageState: PageState = { kind: 'none' }
let runStatusState: RunStatusState = { kind: 'noRun' }

$('settings').addEventListener('click', () => void openSettings())
attachButton.addEventListener('click', () => void observeTab())
taskForm.addEventListener('submit', (event) => {
  event.preventDefault()
  void startRun()
})
task.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    taskForm.requestSubmit()
  }
})
cancelButton.addEventListener('click', () => void cancelRun())
allowAccessButton.addEventListener('click', () => {
  consentGranted = true
  permission.hidden = true
  void startRun()
})
notNowButton.addEventListener('click', () => {
  permission.hidden = true
  setRunStatus({ kind: 'noRun' })
})
approveButton.addEventListener('click', () => void decide(true))
rejectButton.addEventListener('click', () => void decide(false))
uploadFile.addEventListener('change', () => {
  if (proposal?.action === 'upload' && proposal.status === 'awaiting_approval') approveButton.disabled = uploadFile.files?.length !== 1
})
privacyToggle.addEventListener('click', () => {
  const nextOpen = privacyPopover.hidden
  privacyPopover.hidden = !nextOpen
  privacyToggle.setAttribute('aria-expanded', String(nextOpen))
})
document.addEventListener('click', (event) => {
  if (privacyPopover.hidden || !(event.target instanceof Node)) return
  if (privacyPopover.contains(event.target) || privacyToggle.contains(event.target)) return
  privacyPopover.hidden = true
  privacyToggle.setAttribute('aria-expanded', 'false')
})
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || privacyPopover.hidden) return
  privacyPopover.hidden = true
  privacyToggle.setAttribute('aria-expanded', 'false')
  privacyToggle.focus()
})
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if ('language' in changes) void applyLanguage()
  if ('credential' in changes) {
    credential = typeof changes.credential.newValue === 'string' ? changes.credential.newValue : ''
    void refreshConnection()
  }
  if ('daemonOrigin' in changes) {
    const nextOrigin = changes.daemonOrigin.newValue
    daemonOrigin = normalizeStoredOrigin(typeof nextOrigin === 'string' ? nextOrigin : undefined)
    void refreshConnection()
  }
})

void initialize()

async function initialize() {
  const stored = await chrome.storage.local.get<Stored>(['daemonOrigin', 'credential'])
  daemonOrigin = normalizeStoredOrigin(stored.daemonOrigin)
  credential = stored.credential ?? ''
  await applyLanguage()
  await refreshConnection()
}

async function applyLanguage() {
  language = await getLanguage()
  document.documentElement.lang = language
  document.title = t(language, 'docTitle')
  $('eyebrow').textContent = t(language, 'eyebrow')
  $('app-heading').textContent = t(language, 'appHeading')
  $('welcome-body').textContent = t(language, 'welcomeBody')
  $('settings').setAttribute('aria-label', t(language, 'settingsButton'))
  $('settings').setAttribute('title', t(language, 'settingsButton'))
  $('task-label').textContent = t(language, 'taskLabel')
  task.placeholder = t(language, 'taskPlaceholder')
  $('run-label').textContent = t(language, 'startRunButton')
  runButton.setAttribute('aria-label', t(language, 'startRunButton'))
  cancelButton.textContent = t(language, 'cancelButton')
  $('attach-label').textContent = t(language, 'attachButton')
  $('attach').setAttribute('title', t(language, 'attachButton'))
  $('permission-heading').textContent = t(language, 'permissionHeading')
  $('permission-body').textContent = t(language, 'permissionBody')
  allowAccessButton.textContent = t(language, 'allowAccessButton')
  notNowButton.textContent = t(language, 'notNowButton')
  $('privacy-heading').textContent = t(language, 'privacyHeading')
  $('privacy-body').textContent = t(language, 'privacyBody')
  $('approval-heading').textContent = t(language, 'approvalHeading')
  $('upload-label-text').textContent = t(language, 'uploadLabelText')
  approveButton.textContent = t(language, 'approveButton')
  rejectButton.textContent = t(language, 'rejectButton')
  renderConnection()
  renderPage()
  renderRunStatus()
  if (proposal) proposalText.textContent = proposalDescription(proposal)
}

async function openSettings() {
  await chrome.runtime.openOptionsPage()
}

async function refreshConnection() {
  if (!credential) {
    setConnection({ kind: 'notPaired' })
    return
  }
  try {
    await request('/v1/harness/browser-extension/connection')
    setConnection({ kind: 'paired' })
  } catch {
    credential = ''
    await chrome.storage.local.remove('credential')
    setConnection({ kind: 'credentialNeedsPairing' })
  }
}

async function observeTab() {
  if (!credential) {
    setRunStatus({ kind: 'pairFirst' })
    void openSettings()
    return
  }
  try {
    const result = await chrome.runtime.sendMessage<{ tabId: number; observation: Observation; evidence: PrivateEvidence }>({ type: 'observe-active-tab' })
    const next = result.observation
    if (!next || next.kind !== 'semantic_page_observation') throw new Error('The page did not return a semantic observation.')
    observation = next
    initialEvidence = result.evidence
    selectedPage = { tabId: result.tabId, ...next.page }
    consentGranted = false
    sessionId = `extension-session:${crypto.randomUUID().replaceAll('-', '')}`
    detached = false
    permission.hidden = true
    setPage({ kind: 'attached', title: next.page.title, origin: next.page.origin })
    setRunStatus({ kind: 'tabAttached', count: next.controls.length })
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function startRun() {
  if (!credential) {
    setRunStatus({ kind: 'pairFirst' })
    void openSettings()
    return
  }
  if (!task.value.trim()) return setRunStatus({ kind: 'enterTask' })
  if (!observation || !selectedPage || !sessionId || !initialEvidence) {
    await observeTab()
    if (!observation || !selectedPage || !sessionId || !initialEvidence) return
  }
  if (!consentGranted) {
    permission.hidden = false
    setRunStatus({ kind: 'consentRequired' })
    return
  }
  try {
    const currentSessionId = sessionId
    await request('/v1/harness/browser-extension/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId: currentSessionId, page: selectedPage, observation, evidence: initialEvidence }),
    })
    const started = await request<RunView>('/v1/harness/browser-extension/runs', {
      method: 'POST', body: JSON.stringify({ sessionId: currentSessionId, taskPrompt: task.value.trim() }),
    })
    runId = started.runId
    stopped = false
    detached = false
    appliedActions.clear()
    finalOutput.hidden = true
    setRunStatus({ kind: 'state', state: started.status })
    void pollUntilTerminal()
    void actionLoop()
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function pollUntilTerminal() {
  while (!stopped && runId) {
    try {
      const view = await request<RunView>(`/v1/harness/browser-extension/runs/${encodeURIComponent(runId)}`)
      setRunStatus(view.error ? { kind: 'error', message: view.error.message } : { kind: 'state', state: view.status })
      if (view.final) {
        finalOutput.textContent = view.final.output
        finalOutput.hidden = false
      }
      if (['succeeded', 'failed', 'cancelled'].includes(view.status)) {
        stopped = true
        approval.hidden = true
        await detachSession()
        clearAttachedPage()
        return
      }
    } catch (error) {
      setRunStatus({ kind: 'error', message: errorMessage(error) })
      stopped = true
      return
    }
    await delay(900)
  }
}

async function actionLoop() {
  let visibleActionId = ''
  while (!stopped && runId && sessionId) {
    try {
      const next = await request<Proposal | null>(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}/actions?runId=${encodeURIComponent(runId)}`)
      if (!next) {
        proposal = undefined
        approval.hidden = true
      } else {
        proposal = next
        approval.hidden = false
        if (visibleActionId !== next.actionId) {
          visibleActionId = next.actionId
          uploadFile.value = ''
        }
        proposalText.textContent = proposalDescription(next)
        uploadLabel.hidden = next.action !== 'upload'
        approveButton.disabled = next.status !== 'awaiting_approval' || (next.action === 'upload' && uploadFile.files?.length !== 1)
        rejectButton.disabled = next.status !== 'awaiting_approval'
        if (next.status === 'applying' && !appliedActions.has(next.actionId)) await applyAction(next)
      }
    } catch (error) {
      setRunStatus({ kind: 'error', message: errorMessage(error) })
    }
    await delay(400)
  }
}

async function decide(approved: boolean) {
  const frozen = proposal
  if (!frozen || frozen.status !== 'awaiting_approval') return
  if (approved && frozen.action === 'upload' && uploadFile.files?.length !== 1) {
    return setRunStatus({ kind: 'selectOneFile' })
  }
  approveButton.disabled = true
  rejectButton.disabled = true
  void request(`/v1/harness/browser-extension/runs/${encodeURIComponent(frozen.runId)}/actions/${encodeURIComponent(frozen.actionId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ approved, callId: frozen.callId, argumentsDigest: frozen.argumentsDigest }),
  }).catch((error) => setRunStatus({ kind: 'error', message: errorMessage(error) }))
}

async function applyAction(action: Proposal) {
  appliedActions.add(action.actionId)
  let result: unknown
  try {
    const file = action.action === 'upload' ? uploadFile.files?.[0] : undefined
    const filePayload = file ? {
      name: file.name,
      type: file.type,
      lastModified: file.lastModified,
      bytes: await file.arrayBuffer(),
    } : undefined
    result = await chrome.runtime.sendMessage({
      type: 'apply-action',
      action: action.action,
      tabId: action.page.tabId,
      origin: action.page.origin,
      url: action.page.url,
      destination: action.url,
      elementRef: action.target?.elementRef,
      text: action.text,
      file: filePayload,
      documentId: action.page.documentId,
      documentRevision: action.page.documentRevision,
      observationRevision: action.observationRevision,
    })
  } catch (error) {
    result = {
      protocol: 'tokenless.harness-browser-extension/v2',
      kind: 'action_result',
      action: action.action,
      status: 'failed',
      ...(action.target ? { elementRef: action.target.elementRef } : {}),
      documentRevision: action.page.documentRevision,
      observationRevision: action.observationRevision,
      evidence: { state: 'not_verified' },
      failure: { code: 'inaccessible_page', message: errorMessage(error) },
    }
  }
  try {
    await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(action.actionId)}/result`, {
      method: 'POST', body: JSON.stringify({ runId: action.runId, result }),
    })
    const screenshot = await chrome.runtime.sendMessage<Pick<PrivateEvidence, 'screenshotDataUrl' | 'capturedAt'>>({
      type: 'capture-tab-evidence', tabId: action.page.tabId,
    })
    await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(action.actionId)}/evidence`, {
      method: 'POST', body: JSON.stringify(screenshot),
    })
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function cancelRun() {
  if (!runId) return
  try {
    await request(`/v1/harness/browser-extension/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' })
    stopped = true
    approval.hidden = true
    await detachSession()
    clearAttachedPage()
    setRunStatus({ kind: 'state', state: 'cancelled' })
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function detachSession() {
  if (detached || !sessionId) return
  detached = true
  await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => undefined)
}

function clearAttachedPage() {
  observation = undefined
  selectedPage = undefined
  initialEvidence = undefined
  sessionId = ''
  consentGranted = false
  permission.hidden = true
  setPage({ kind: 'none' })
}

function proposalDescription(value: Proposal) {
  const target = value.target ? `${value.target.label || value.target.name || t(language, 'taskLabel')} · ${value.target.inputType}` : value.page.origin
  const detail = value.action === 'input' ? `\n\n${proposedText(language, value.text ?? '')}`
    : value.action === 'navigate' ? `\n\n${destination(language, value.url ?? '')}`
      : value.action === 'upload' ? `\n\n${t(language, 'selectFileBelow')}`
        : ''
  return `${actionLabel(language, value.action)}\n${target}${detail}`
}

async function request<T = unknown>(path: string, init: RequestInit | undefined = undefined, withCredential = true): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  if (withCredential && credential) headers.set('authorization', `Bearer ${credential}`)
  const response = await fetch(`${normalizeOrigin(daemonOrigin)}${path}`, { ...init, headers })
  if (response.status === 204) return null as T
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body ? body.error?.message ?? `HTTP ${response.status}` : `HTTP ${response.status}`)
  return body as T
}

function normalizeStoredOrigin(value: string | undefined) {
  try { return normalizeOrigin(value ?? DEFAULT_DAEMON_ORIGIN) } catch { return DEFAULT_DAEMON_ORIGIN }
}

function normalizeOrigin(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '7331' ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use an exact loopback daemon origin such as http://127.0.0.1:7331.')
  }
  return url.origin
}

function setConnection(state: ConnectionState) { connectionState = state; renderConnection() }
function setPage(state: PageState) { pageState = state; renderPage() }
function setRunStatus(state: RunStatusState) { runStatusState = state; renderRunStatus() }

function renderConnection() {
  const state = connectionState
  connection.textContent = state.kind === 'notPaired' ? t(language, 'notPaired')
    : state.kind === 'paired' ? t(language, 'paired')
      : state.kind === 'credentialNeedsPairing' ? t(language, 'credentialNeedsPairing')
        : formatError(state.message)
  connectionBadge.classList.toggle('is-connected', state.kind === 'paired')
}

function renderPage() {
  if (pageState.kind === 'attached') {
    pageStatus.textContent = pageState.title || t(language, 'untitled')
    pageOrigin.textContent = pageState.origin
  } else {
    pageStatus.textContent = t(language, 'noTabAttached')
    pageOrigin.textContent = ''
  }
  contextDot.classList.toggle('is-connected', pageState.kind === 'attached')
}

function renderRunStatus() {
  const state = runStatusState
  const terminal = state.kind === 'state' && ['succeeded', 'failed', 'cancelled'].includes(state.state)
  const active = state.kind === 'state' && !terminal
  runButton.disabled = active
  attachButton.disabled = active
  cancelButton.hidden = !active
  runStatus.textContent = state.kind === 'noRun' ? t(language, 'noRun')
    : state.kind === 'pairFirst' ? t(language, 'pairFirst')
      : state.kind === 'consentRequired' ? t(language, 'consentRequired')
        : state.kind === 'enterTask' ? t(language, 'enterTask')
          : state.kind === 'selectOneFile' ? t(language, 'selectOneFile')
            : state.kind === 'tabAttached' ? tabAttachedLocally(language, state.count)
              : state.kind === 'state' ? stateLabel(language, state.state)
                : formatError(state.message)
}

function formatError(message: string) { return `${message} ${t(language, 'errorSuffix')}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : t(language, 'requestFailed') }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
