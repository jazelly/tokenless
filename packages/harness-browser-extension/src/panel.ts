import { actionLabel, destination, getLanguage, originDisclosure, pairingRequested, proposedText, routeValue, stateLabel, t, tabAttachedLocally, type Language } from './i18n.js'

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
  | { kind: 'pairingRequested'; id: string }
  | { kind: 'paired' }
  | { kind: 'pairingExpiredOrRevoked' }
  | { kind: 'pairingExpired' }
  | { kind: 'credentialNeedsPairing' }
  | { kind: 'error'; message: string }
type RouteState = { kind: 'default' } | { kind: 'paired'; provider: string; profileId: string }
type PageState = { kind: 'none' } | { kind: 'attached'; title: string; origin: string }
type DisclosureState = { kind: 'default' } | { kind: 'origin'; origin: string }
type InventoryState = { kind: 'none' } | { kind: 'empty' } | { kind: 'list'; controls: Observation['controls'] }
type RunStatusState =
  | { kind: 'noRun' }
  | { kind: 'pairFirst' }
  | { kind: 'pairAndAttach' }
  | { kind: 'consentRequired' }
  | { kind: 'enterTask' }
  | { kind: 'selectOneFile' }
  | { kind: 'tabAttached'; count: number }
  | { kind: 'state'; state: string }
  | { kind: 'error'; message: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const daemon = $<HTMLInputElement>('daemon')
const connection = $('connection')
const route = $('route')
const pageStatus = $('page')
const disclosure = $('origin')
const inventory = $('inventory')
const consent = $<HTMLInputElement>('consent')
const task = $<HTMLTextAreaElement>('task')
const runStatus = $('run-status')
const finalOutput = $('final')
const approval = $('approval')
const proposalText = $('proposal')
const approveButton = $<HTMLButtonElement>('approve')
const rejectButton = $<HTMLButtonElement>('reject')
const uploadLabel = $('upload-label')
const uploadFile = $<HTMLInputElement>('upload-file')

let credential = ''
let sessionId = ''
let selectedPage: Page | undefined
let observation: Observation | undefined
let initialEvidence: PrivateEvidence | undefined
let runId = ''
let proposal: Proposal | undefined
let stopped = true
let detached = false
const appliedActions = new Set<string>()

let language: Language = 'en'
let connectionState: ConnectionState = { kind: 'notPaired' }
let routeState: RouteState = { kind: 'default' }
let pageState: PageState = { kind: 'none' }
let disclosureState: DisclosureState = { kind: 'default' }
let inventoryState: InventoryState = { kind: 'none' }
let runStatusState: RunStatusState = { kind: 'noRun' }

$('settings').addEventListener('click', () => void chrome.runtime.openOptionsPage())
$('pair').addEventListener('click', () => void pair())
$('unpair').addEventListener('click', () => void unpair())
$('refresh').addEventListener('click', () => void refreshConnection())
$('attach').addEventListener('click', () => void observeTab())
$('run').addEventListener('click', () => void startRun())
$('cancel').addEventListener('click', () => void cancelRun())
approveButton.addEventListener('click', () => void decide(true))
rejectButton.addEventListener('click', () => void decide(false))
uploadFile.addEventListener('change', () => {
  if (proposal?.action === 'upload' && proposal.status === 'awaiting_approval') approveButton.disabled = uploadFile.files?.length !== 1
})
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && 'language' in changes) void applyLanguage()
})

void initialize()

async function initialize() {
  const stored = await chrome.storage.local.get<Stored>(['daemonOrigin', 'credential'])
  if (stored.daemonOrigin) daemon.value = stored.daemonOrigin
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
  $('connection-heading').textContent = t(language, 'connectionHeading')
  $('daemon-label').textContent = t(language, 'daemonLabel')
  $('pair').textContent = t(language, 'pairButton')
  $('unpair').textContent = t(language, 'unpairButton')
  $('refresh').textContent = t(language, 'refreshButton')
  $('pairing-help').textContent = t(language, 'pairingHelp')
  $('current-tab-heading').textContent = t(language, 'currentTabHeading')
  $('consent-label').textContent = t(language, 'consentLabel')
  $('attach').textContent = t(language, 'attachButton')
  $('task-heading').textContent = t(language, 'taskHeading')
  $('task-label').textContent = t(language, 'taskLabel')
  task.placeholder = t(language, 'taskPlaceholder')
  $('run').textContent = t(language, 'startRunButton')
  $('cancel').textContent = t(language, 'cancelButton')
  $('approval-heading').textContent = t(language, 'approvalHeading')
  $('upload-label-text').textContent = t(language, 'uploadLabelText')
  $('approve').textContent = t(language, 'approveButton')
  $('reject').textContent = t(language, 'rejectButton')
  $('privacy-heading').textContent = t(language, 'privacyHeading')
  $('privacy-body').textContent = t(language, 'privacyBody')
  renderConnection()
  renderRoute()
  renderPage()
  renderDisclosure()
  renderInventory()
  renderRunStatus()
  if (proposal) proposalText.textContent = proposalDescription(proposal)
}

async function pair() {
  try {
    await saveOrigin()
    const response = await request<{ pairingId: string; secret: string; dashboardUrl: string; expiresAt: string }>('/v1/harness/browser-extension/pairings', {
      method: 'POST',
      body: JSON.stringify({ extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version }),
    }, false)
    await chrome.tabs.create({ url: response.dashboardUrl })
    setConnection({ kind: 'pairingRequested', id: response.pairingId })
    await pollPairing(response.pairingId, response.secret, Date.parse(response.expiresAt))
  } catch (error) {
    setConnection({ kind: 'error', message: errorMessage(error) })
  }
}

async function pollPairing(pairingId: string, secret: string, deadline: number) {
  while (Date.now() < deadline) {
    await delay(1_200)
    const result = await request<{ state: string; credential?: string; provider?: string; profileId?: string }>(
      `/v1/harness/browser-extension/pairings/${encodeURIComponent(pairingId)}/poll`,
      { method: 'POST', body: JSON.stringify({ secret }) },
      false,
    )
    if (result.state === 'pending') continue
    if (result.state === 'approved' && result.credential) {
      credential = result.credential
      await chrome.storage.local.set({ credential })
      setConnection({ kind: 'paired' })
      setRoute({ kind: 'paired', provider: result.provider ?? '—', profileId: result.profileId ?? '—' })
      return
    }
    setConnection({ kind: 'pairingExpiredOrRevoked' })
    return
  }
  setConnection({ kind: 'pairingExpired' })
}

async function unpair() {
  try {
    if (credential) await request('/v1/harness/browser-extension/connection', { method: 'DELETE' })
  } catch { /* local credential is still removed */ }
  credential = ''
  await chrome.storage.local.remove('credential')
  setConnection({ kind: 'notPaired' })
  setRoute({ kind: 'default' })
}

async function refreshConnection() {
  if (!credential) return setConnection({ kind: 'notPaired' })
  try {
    const value = await request<{ pairing: { provider?: string; profileId?: string } }>('/v1/harness/browser-extension/connection')
    setConnection({ kind: 'paired' })
    setRoute({ kind: 'paired', provider: value.pairing.provider ?? '—', profileId: value.pairing.profileId ?? '—' })
  } catch {
    credential = ''
    await chrome.storage.local.remove('credential')
    setConnection({ kind: 'credentialNeedsPairing' })
  }
}

async function observeTab() {
  if (!credential) return setRunStatus({ kind: 'pairFirst' })
  try {
    const result = await chrome.runtime.sendMessage<{ tabId: number; observation: Observation; evidence: PrivateEvidence }>({ type: 'observe-active-tab' })
    const next = result.observation
    if (!next || next.kind !== 'semantic_page_observation') throw new Error('The page did not return a semantic observation.')
    observation = next
    initialEvidence = result.evidence
    selectedPage = { tabId: result.tabId, ...next.page }
    consent.checked = false
    sessionId = `extension-session:${crypto.randomUUID().replaceAll('-', '')}`
    detached = false
    setPage({ kind: 'attached', title: next.page.title, origin: next.page.origin })
    setDisclosure({ kind: 'origin', origin: next.page.origin })
    setInventory(next.controls.length === 0 ? { kind: 'empty' } : { kind: 'list', controls: next.controls })
    setRunStatus({ kind: 'tabAttached', count: next.controls.length })
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function startRun() {
  if (!credential || !observation || !selectedPage || !sessionId || !initialEvidence) return setRunStatus({ kind: 'pairAndAttach' })
  if (!consent.checked) return setRunStatus({ kind: 'consentRequired' })
  if (!task.value.trim()) return setRunStatus({ kind: 'enterTask' })
  try {
    await saveOrigin()
    await request('/v1/harness/browser-extension/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId, page: selectedPage, observation, evidence: initialEvidence }),
    })
    const started = await request<RunView>('/v1/harness/browser-extension/runs', {
      method: 'POST', body: JSON.stringify({ sessionId, taskPrompt: task.value.trim() }),
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
    await detachSession()
  } catch (error) {
    setRunStatus({ kind: 'error', message: errorMessage(error) })
  }
}

async function detachSession() {
  if (detached || !sessionId) return
  detached = true
  await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => undefined)
}

function proposalDescription(value: Proposal) {
  const target = value.target ? `${value.target.label || value.target.name || t(language, 'control')} · ${value.target.inputType}` : value.page.origin
  const detail = value.action === 'input' ? `\n\n${proposedText(language, value.text ?? '')}`
    : value.action === 'navigate' ? `\n\n${destination(language, value.url ?? '')}`
      : value.action === 'upload' ? `\n\n${t(language, 'selectFileBelow')}`
        : ''
  return `${actionLabel(language, value.action)}\n${target}${detail}`
}

async function saveOrigin() {
  const normalized = normalizeOrigin(daemon.value)
  daemon.value = normalized
  await chrome.storage.local.set({ daemonOrigin: normalized })
}

async function request<T = unknown>(path: string, init: RequestInit | undefined = undefined, withCredential = true): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('content-type', 'application/json')
  if (withCredential && credential) headers.set('authorization', `Bearer ${credential}`)
  const response = await fetch(`${normalizeOrigin(daemon.value)}${path}`, { ...init, headers })
  if (response.status === 204) return null as T
  const body = await response.json().catch(() => null) as { error?: { message?: string } } | T | null
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'error' in body ? body.error?.message ?? `HTTP ${response.status}` : `HTTP ${response.status}`)
  return body as T
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
function setRoute(state: RouteState) { routeState = state; renderRoute() }
function setPage(state: PageState) { pageState = state; renderPage() }
function setDisclosure(state: DisclosureState) { disclosureState = state; renderDisclosure() }
function setInventory(state: InventoryState) { inventoryState = state; renderInventory() }
function setRunStatus(state: RunStatusState) { runStatusState = state; renderRunStatus() }

function renderConnection() {
  const state = connectionState
  connection.textContent = state.kind === 'notPaired' ? t(language, 'notPaired')
    : state.kind === 'pairingRequested' ? pairingRequested(language, state.id)
      : state.kind === 'paired' ? t(language, 'paired')
        : state.kind === 'pairingExpiredOrRevoked' ? t(language, 'pairingExpiredOrRevoked')
          : state.kind === 'pairingExpired' ? t(language, 'pairingExpired')
            : state.kind === 'credentialNeedsPairing' ? t(language, 'credentialNeedsPairing')
              : formatError(state.message)
}

function renderRoute() {
  route.textContent = routeState.kind === 'default' ? t(language, 'routeDefault') : routeValue(language, routeState.provider, routeState.profileId)
}

function renderPage() {
  pageStatus.textContent = pageState.kind === 'none' ? t(language, 'noTabAttached') : `${pageState.title || t(language, 'untitled')} · ${pageState.origin}`
}

function renderDisclosure() {
  disclosure.textContent = disclosureState.kind === 'default' ? t(language, 'pageDisclosureDefault') : originDisclosure(language, disclosureState.origin)
}

function renderInventory() {
  if (inventoryState.kind === 'none') { inventory.textContent = ''; return }
  if (inventoryState.kind === 'empty') { inventory.textContent = t(language, 'noSupportedControls'); return }
  inventory.textContent = inventoryState.controls.map((control, index) => {
    const state = control.role === 'radio' ? (control.checked ? t(language, 'selected') : t(language, 'notSelected')) : control.valuePresence
    return `${index + 1}. ${control.label || control.name || t(language, 'control')} · ${control.inputType} · ${control.actions.join('/')} · ${state}`
  }).join('\n')
}

function renderRunStatus() {
  const state = runStatusState
  runStatus.textContent = state.kind === 'noRun' ? t(language, 'noRun')
    : state.kind === 'pairFirst' ? t(language, 'pairFirst')
      : state.kind === 'pairAndAttach' ? t(language, 'pairAndAttach')
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
