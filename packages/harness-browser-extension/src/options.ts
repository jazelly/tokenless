import { getLanguage, pairingRequested, routeValue, setLanguage, t, type Language } from './i18n.js'

const DEFAULT_DAEMON_ORIGIN = 'http://127.0.0.1:7331'

type Stored = { daemonOrigin?: string; credential?: string }
type ConnectionState =
  | { kind: 'notPaired' }
  | { kind: 'pairingRequested'; id: string }
  | { kind: 'paired' }
  | { kind: 'pairingExpiredOrRevoked' }
  | { kind: 'pairingExpired' }
  | { kind: 'credentialNeedsPairing' }
  | { kind: 'error'; message: string }
type RouteState = { kind: 'default' } | { kind: 'paired'; provider: string; profileId: string }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const heading = $('settings-heading')
const subheading = $('settings-subheading')
const connectionHeading = $('connection-heading')
const connectionHelp = $('connection-help')
const connection = $('connection')
const daemonLabel = $('daemon-label')
const daemon = $<HTMLInputElement>('daemon')
const route = $('route')
const pairButton = $<HTMLButtonElement>('pair')
const unpairButton = $<HTMLButtonElement>('unpair')
const refreshButton = $<HTMLButtonElement>('refresh')
const pairingHelp = $('pairing-help')
const languageHeading = $('language-heading')
const languageHelp = $('language-help')
const languageLabel = $('language-label')
const languageSelect = $<HTMLSelectElement>('language')
const privacyHeading = $('privacy-heading')
const privacyBody = $('privacy-body')
const permissionSummary = $('permission-summary')
const approvalSummary = $('approval-summary')
const evidenceSummary = $('evidence-summary')

let language: Language = 'en'
let credential = ''
let daemonOrigin = DEFAULT_DAEMON_ORIGIN
let busy = false
let connectionState: ConnectionState = { kind: 'notPaired' }
let routeState: RouteState = { kind: 'default' }

languageSelect.addEventListener('change', () => void onLanguageChange())
pairButton.addEventListener('click', () => void pair())
unpairButton.addEventListener('click', () => void unpair())
refreshButton.addEventListener('click', () => void refreshFromSettings())
daemon.addEventListener('change', () => void refreshFromSettings())
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if ('language' in changes) void applyLanguage()
  if ('credential' in changes) {
    credential = typeof changes.credential.newValue === 'string' ? changes.credential.newValue : ''
    void refreshConnection()
  }
  if ('daemonOrigin' in changes) {
    daemonOrigin = normalizeStoredOrigin(typeof changes.daemonOrigin.newValue === 'string' ? changes.daemonOrigin.newValue : undefined)
    daemon.value = daemonOrigin
    void refreshConnection()
  }
})

void initialize()

async function initialize() {
  const stored = await chrome.storage.local.get<Stored>(['daemonOrigin', 'credential'])
  daemonOrigin = normalizeStoredOrigin(stored.daemonOrigin)
  daemon.value = daemonOrigin
  credential = stored.credential ?? ''
  await applyLanguage()
  await refreshConnection()
}

async function onLanguageChange() {
  const next = languageSelect.value as Language
  if (next !== 'en' && next !== 'zh') return
  await setLanguage(next)
  await applyLanguage()
}

async function applyLanguage() {
  language = await getLanguage()
  languageSelect.value = language
  document.documentElement.lang = language
  document.title = t(language, 'settingsHeading')
  heading.textContent = t(language, 'settingsHeading')
  subheading.textContent = t(language, 'settingsSubheading')
  connectionHeading.textContent = t(language, 'connectionHeading')
  connectionHelp.textContent = t(language, 'connectionHelp')
  daemonLabel.textContent = t(language, 'daemonLabel')
  pairButton.textContent = t(language, 'pairButton')
  unpairButton.textContent = t(language, 'unpairButton')
  refreshButton.textContent = t(language, 'refreshButton')
  pairingHelp.textContent = t(language, 'pairingHelp')
  languageHeading.textContent = t(language, 'languageHeading')
  languageHelp.textContent = t(language, 'languageHelp')
  languageLabel.textContent = t(language, 'languageLabel')
  privacyHeading.textContent = t(language, 'privacyHeading')
  privacyBody.textContent = t(language, 'privacyBody')
  permissionSummary.textContent = t(language, 'permissionSummary')
  approvalSummary.textContent = t(language, 'approvalSummary')
  evidenceSummary.textContent = t(language, 'evidenceSummary')
  renderConnection()
  renderRoute()
  renderBusy()
}

async function pair() {
  try {
    await saveOrigin()
    setBusy(true)
    const response = await request<{ pairingId: string; secret: string; dashboardUrl: string; expiresAt: string }>(
      '/v1/harness/browser-extension/pairings',
      {
        method: 'POST',
        body: JSON.stringify({ extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version }),
      },
      false,
    )
    setConnection({ kind: 'pairingRequested', id: response.pairingId })
    await chrome.tabs.create({ url: response.dashboardUrl })
    await pollPairing(response.pairingId, response.secret, Date.parse(response.expiresAt))
  } catch (error) {
    setConnection({ kind: 'error', message: errorMessage(error) })
  } finally {
    setBusy(false)
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
    setBusy(true)
    await saveOrigin()
    if (credential) await request('/v1/harness/browser-extension/connection', { method: 'DELETE' })
  } catch {
    // Removing the local credential still disconnects this extension.
  } finally {
    credential = ''
    await chrome.storage.local.remove('credential')
    setConnection({ kind: 'notPaired' })
    setRoute({ kind: 'default' })
    setBusy(false)
  }
}

async function refreshFromSettings() {
  try {
    await saveOrigin()
    await refreshConnection()
  } catch (error) {
    setConnection({ kind: 'error', message: errorMessage(error) })
  }
}

async function refreshConnection() {
  if (!credential) {
    setConnection({ kind: 'notPaired' })
    setRoute({ kind: 'default' })
    return
  }
  try {
    const value = await request<{ pairing: { provider?: string; profileId?: string } }>('/v1/harness/browser-extension/connection')
    setConnection({ kind: 'paired' })
    setRoute({ kind: 'paired', provider: value.pairing.provider ?? '—', profileId: value.pairing.profileId ?? '—' })
  } catch {
    credential = ''
    await chrome.storage.local.remove('credential')
    setConnection({ kind: 'credentialNeedsPairing' })
    setRoute({ kind: 'default' })
  }
}

async function saveOrigin() {
  daemonOrigin = normalizeOrigin(daemon.value.trim() || DEFAULT_DAEMON_ORIGIN)
  daemon.value = daemonOrigin
  await chrome.storage.local.set({ daemonOrigin })
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

function setConnection(state: ConnectionState) {
  connectionState = state
  renderConnection()
}

function setRoute(state: RouteState) {
  routeState = state
  renderRoute()
}

function setBusy(value: boolean) {
  busy = value
  renderBusy()
}

function renderConnection() {
  const state = connectionState
  connection.textContent = state.kind === 'notPaired' ? t(language, 'notPaired')
    : state.kind === 'pairingRequested' ? pairingRequested(language, state.id)
      : state.kind === 'paired' ? t(language, 'paired')
        : state.kind === 'pairingExpiredOrRevoked' ? t(language, 'pairingExpiredOrRevoked')
          : state.kind === 'pairingExpired' ? t(language, 'pairingExpired')
            : state.kind === 'credentialNeedsPairing' ? t(language, 'credentialNeedsPairing')
              : formatError(state.message)
  connection.classList.toggle('is-connected', state.kind === 'paired')
}

function renderRoute() {
  route.textContent = routeState.kind === 'default' ? t(language, 'routeDefault') : routeValue(language, routeState.provider, routeState.profileId)
}

function renderBusy() {
  pairButton.disabled = busy
  unpairButton.disabled = busy || !credential
  refreshButton.disabled = busy
}

function formatError(message: string) { return `${message} ${t(language, 'errorSuffix')}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : t(language, 'requestFailed') }
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
