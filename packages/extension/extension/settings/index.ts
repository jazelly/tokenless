import {
  createNativeMessage,
  isNativeMessage,
  NATIVE_MESSAGE_TYPES,
  NATIVE_PROTOCOL_VERSION,
} from '../shared/native-protocol.js'
import { listProviders } from '../shared/provider-config.js'
import {
  configWritePayload,
  normalizeHistoryEntries,
  normalizeProviderOrder,
} from './model.js'
import type { HistoryEntry } from './model.js'

type SettingsRecord = Record<string, any>
type NoticeTone = 'error' | 'loading' | 'success'
type ProviderControlAction = 'up' | 'down' | 'remove'
type ProviderFocusIntent = {
  providerId?: string
  action?: ProviderControlAction
  fallback?: 'provider-add' | 'save'
}

const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const NATIVE_REQUEST_TIMEOUT_MS = 10000
const providers = listProviders()
const supportedProviderIds = providers.map((provider) => provider.id)
const configuration = document.querySelector<HTMLElement>('#configuration')
const history = document.querySelector<HTMLElement>('#history')
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')
const pageStatus = document.querySelector<HTMLElement>('#page-status')
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'))
const viewPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-view-panel]'))

let providerOrder: string[] = []
let browserPreference = ''
let daemonUrl = ''
let isSaving = false
let isHistoryRefreshing = false

viewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setActiveView(button.dataset.view)
  })
})

refreshButton?.addEventListener('click', () => {
  void refreshHistory()
})

void loadInitialSettings()

function setActiveView(view: string | undefined) {
  if (view !== 'activity' && view !== 'settings') return
  viewButtons.forEach((button) => {
    const active = button.dataset.view === view
    button.classList.toggle('is-active', active)
    button.setAttribute('aria-selected', String(active))
  })
  viewPanels.forEach((panel) => {
    panel.hidden = panel.dataset.viewPanel !== view
  })
}

async function loadInitialSettings() {
  isHistoryRefreshing = true
  setRefreshState(true)
  setPageStatus('Connecting…', 'loading')
  renderConfigurationState('Loading configuration…', 'loading')
  renderHistoryState('Loading daemon history…', 'loading')

  const [configResult, historyResult] = await Promise.allSettled([
    loadConfig(),
    loadHistory(),
  ])

  isHistoryRefreshing = false
  setRefreshState(false)
  const failures = [configResult, historyResult].filter((result) => result.status === 'rejected')
  if (failures.length === 0) {
    setPageStatus('Native host ready', 'ready')
  } else {
    setPageStatus(failures.length === 2 ? 'Native host unavailable' : 'Partially loaded', 'error')
  }
}

async function refreshHistory() {
  if (isHistoryRefreshing) return
  isHistoryRefreshing = true
  setRefreshState(true)
  setPageStatus('Refreshing history…', 'loading')
  renderHistoryState('Loading daemon history…', 'loading')
  try {
    await loadHistory()
    setPageStatus('Native host ready', 'ready')
  } catch {
    setPageStatus('History refresh failed', 'error')
  } finally {
    isHistoryRefreshing = false
    setRefreshState(false)
  }
}

async function loadConfig() {
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.READ_CONFIG)
    if (!response.ok) {
      throw new Error(response.error?.message || 'The native host could not read configuration.')
    }
    const config = objectRecord(response.result)
    providerOrder = normalizeProviderOrder(config.preferredProviders, supportedProviderIds)
    browserPreference = stringValue(config.browser)
    daemonUrl = stringValue(config.daemonUrl)
    renderConfigEditor()
  } catch (error) {
    renderConfigurationState(errorMessage(error, 'Configuration is unavailable.'), 'error')
    throw error
  }
}

function renderConfigEditor(
  message?: string,
  tone: NoticeTone = 'success',
  focusIntent?: ProviderFocusIntent
) {
  if (!configuration) return
  const form = document.createElement('form')
  form.className = 'configuration-form'

  const providerEditor = document.createElement('div')
  providerEditor.className = 'provider-editor'
  const providerHeading = document.createElement('div')
  providerHeading.className = 'provider-heading'
  providerHeading.textContent = 'Provider preference'
  providerEditor.append(providerHeading)

  const providerList = document.createElement('div')
  providerList.className = 'provider-list'
  if (providerOrder.length === 0) {
    providerList.append(stateNode('No preference saved. New jobs default to ChatGPT.', 'empty'))
  } else {
    providerList.append(...providerOrder.map(renderProviderRow))
  }
  providerEditor.append(providerList)

  const addRow = renderProviderAddRow()
  if (addRow) providerEditor.append(addRow)

  const formGrid = document.createElement('div')
  formGrid.className = 'form-grid'
  const browserField = textField({
    label: 'Browser preference',
    value: browserPreference,
    placeholder: 'Auto-detect Chromium',
    help: 'Optional supported Chromium browser; otherwise Tokenless detects one deterministically.',
    onInput: (value) => { browserPreference = value },
  })
  const daemonField = textField({
    label: 'Daemon URL',
    value: daemonUrl,
    placeholder: 'http://127.0.0.1:7331',
    help: 'The loopback address of the local Tokenless daemon.',
    inputMode: 'url',
    onInput: (value) => { daemonUrl = value },
  })
  formGrid.append(browserField, daemonField)

  const actions = document.createElement('div')
  actions.className = 'form-actions'
  const notice = document.createElement('span')
  notice.className = 'notice'
  if (message) {
    notice.textContent = message
    notice.dataset.tone = tone
  }
  const save = document.createElement('button')
  save.type = 'submit'
  save.className = 'primary-button'
  save.disabled = isSaving
  save.textContent = isSaving ? 'Saving…' : 'Save settings'
  actions.append(notice, save)

  form.append(providerEditor, formGrid, actions)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void saveConfig()
  })
  configuration.replaceChildren(form)
  if (focusIntent) restoreProviderFocus(focusIntent)
}

function renderProviderRow(providerId: string, index: number) {
  const row = document.createElement('div')
  row.className = 'provider-row'
  row.dataset.preferred = String(index === 0)
  row.dataset.providerId = providerId

  const identity = document.createElement('div')
  identity.className = 'provider-identity'
  const rank = document.createElement('span')
  rank.className = 'provider-rank'
  rank.textContent = String(index + 1)
  const copy = document.createElement('div')
  copy.className = 'provider-copy'
  const label = document.createElement('strong')
  label.textContent = providerLabel(providerId)
  const description = document.createElement('span')
  description.textContent = index === 0 ? 'Preferred provider' : 'Fallback provider'
  copy.append(label, description)
  identity.append(rank, copy)

  const controls = document.createElement('div')
  controls.className = 'provider-controls'
  const providerName = providerLabel(providerId)
  controls.append(
    rowButton('↑', `Move ${providerName} up`, providerId, 'up', () => moveProvider(index, -1), index === 0),
    rowButton('↓', `Move ${providerName} down`, providerId, 'down', () => moveProvider(index, 1), index === providerOrder.length - 1),
    rowButton('Remove', `Remove ${providerName}`, providerId, 'remove', () => removeProvider(index), false, 'danger')
  )
  row.append(identity, controls)
  return row
}

function renderProviderAddRow() {
  const remaining = supportedProviderIds.filter((providerId) => !providerOrder.includes(providerId))
  if (remaining.length === 0) return null
  const row = document.createElement('div')
  row.className = 'provider-add'
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Provider to add')
  select.replaceChildren(...remaining.map((providerId) => {
    const option = document.createElement('option')
    option.value = providerId
    option.textContent = providerLabel(providerId)
    return option
  }))
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'secondary-button'
  add.textContent = 'Add provider'
  add.addEventListener('click', () => {
    if (!select.value || providerOrder.includes(select.value)) return
    providerOrder = [...providerOrder, select.value]
    renderConfigEditor('Unsaved changes', 'loading')
  })
  row.append(select, add)
  return row
}

async function saveConfig() {
  if (isSaving) return
  isSaving = true
  renderConfigEditor('Saving settings…', 'loading')
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.WRITE_CONFIG, configWritePayload({
      providerOrder,
      browser: browserPreference,
      daemonUrl,
    }))
    if (!response.ok) {
      throw new Error(response.error?.message || 'The native host could not save configuration.')
    }
    const config = objectRecord(response.result)
    providerOrder = normalizeProviderOrder(config.preferredProviders, supportedProviderIds)
    browserPreference = stringValue(config.browser)
    daemonUrl = stringValue(config.daemonUrl)
    isSaving = false
    renderConfigEditor('Settings saved.', 'success')
    setPageStatus('Native host ready', 'ready')
  } catch (error) {
    isSaving = false
    renderConfigEditor(errorMessage(error, 'Settings could not be saved.'), 'error')
    setPageStatus('Save failed', 'error')
  }
}

async function loadHistory() {
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.LIST_HISTORY, { limit: 100 })
    if (!response.ok) {
      throw new Error(response.error?.message || 'The native host could not list daemon history.')
    }
    renderHistory(response.result)
  } catch (error) {
    renderHistoryState(errorMessage(error, 'Daemon history is unavailable.'), 'error')
    throw error
  }
}

function renderHistory(value: unknown) {
  if (!history) return
  const entries = normalizeHistoryEntries(value)
  if (entries.length === 0) {
    renderHistoryState('No daemon jobs yet.', 'empty')
    return
  }

  history.replaceChildren(...entries.map(renderHistoryJob))
}

function renderHistoryJob(entry: HistoryEntry) {
  const article = document.createElement('article')
  article.className = 'job-card'
  const heading = document.createElement('div')
  heading.className = 'job-heading'
  const title = document.createElement('div')
  title.className = 'job-title'
  title.textContent = entry.chatName
  const badges = document.createElement('div')
  badges.className = 'job-badges'
  badges.append(badgeNode(providerLabel(entry.provider)), badgeNode(entry.status, entry.status))
  heading.append(title, badges)

  const meta = document.createElement('div')
  meta.className = 'job-meta'
  meta.append(
    textNode(`Project: ${entry.projectName}`),
    textNode(`Action: ${formatAction(entry.action)}`),
    textNode(`Updated: ${formatDate(entry.updatedAt)}`),
    textNode(`Task: ${entry.taskId}`)
  )
  const jobId = document.createElement('div')
  jobId.className = 'job-id'
  jobId.textContent = `Job ID: ${entry.jobId}`
  article.append(heading, meta, jobId)
  return article
}

function badgeNode(text: string, status?: string) {
  const badge = document.createElement('span')
  badge.className = 'badge'
  badge.textContent = text.replaceAll('_', ' ')
  if (status) badge.dataset.status = status
  return badge
}

function textField({
  label,
  value,
  placeholder,
  help,
  inputMode,
  onInput,
}: {
  label: string
  value: string
  placeholder: string
  help: string
  inputMode?: 'url'
  onInput: (value: string) => void
}) {
  const field = document.createElement('label')
  field.className = 'field'
  const title = document.createElement('span')
  title.textContent = label
  const input = document.createElement('input')
  input.type = 'text'
  input.value = value
  input.placeholder = placeholder
  if (inputMode) input.inputMode = inputMode
  input.addEventListener('input', () => onInput(input.value.trim()))
  const helpNode = document.createElement('span')
  helpNode.className = 'field-help'
  helpNode.textContent = help
  field.append(title, input, helpNode)
  return field
}

function rowButton(
  label: string,
  accessibleLabel: string,
  providerId: string,
  action: ProviderControlAction,
  onClick: () => void,
  disabled: boolean,
  tone?: 'danger'
) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'row-button'
  button.textContent = label
  button.setAttribute('aria-label', accessibleLabel)
  button.dataset.providerId = providerId
  button.dataset.providerAction = action
  button.disabled = disabled
  if (tone) button.dataset.tone = tone
  button.addEventListener('click', onClick)
  return button
}

function moveProvider(index: number, delta: number) {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= providerOrder.length) return
  const next = [...providerOrder]
  const [providerId] = next.splice(index, 1)
  if (!providerId) return
  next.splice(nextIndex, 0, providerId)
  providerOrder = next
  renderConfigEditor('Unsaved changes', 'loading', {
    providerId,
    action: delta < 0 ? 'up' : 'down',
  })
}

function removeProvider(index: number) {
  const focusProviderId = providerOrder[index + 1] ?? providerOrder[index - 1]
  providerOrder = providerOrder.filter((_, providerIndex) => providerIndex !== index)
  renderConfigEditor('Unsaved changes', 'loading', focusProviderId
    ? { providerId: focusProviderId, action: 'remove' }
    : { fallback: 'provider-add' })
}

function restoreProviderFocus(intent: ProviderFocusIntent) {
  if (!configuration) return
  const buttons = [...configuration.querySelectorAll<HTMLButtonElement>('.row-button')]
  const preferred = buttons.find((button) => (
    button.dataset.providerId === intent.providerId &&
    button.dataset.providerAction === intent.action &&
    !button.disabled
  ))
  const sameProvider = buttons.find((button) => (
    button.dataset.providerId === intent.providerId && !button.disabled
  ))
  const fallback = intent.fallback === 'save'
    ? configuration.querySelector<HTMLButtonElement>('button[type="submit"]')
    : configuration.querySelector<HTMLElement>('.provider-add select, .provider-add button, button[type="submit"]')
  ;(preferred ?? sameProvider ?? fallback)?.focus()
}

function providerLabel(providerId: string) {
  return providers.find((provider) => provider.id === providerId)?.label ?? providerId
}

function renderConfigurationState(message: string, state: 'empty' | 'error' | 'loading') {
  configuration?.replaceChildren(stateNode(message, state))
}

function renderHistoryState(message: string, state: 'empty' | 'error' | 'loading') {
  history?.replaceChildren(stateNode(message, state))
}

function stateNode(message: string, state: 'empty' | 'error' | 'loading') {
  const node = document.createElement('div')
  node.className = 'state-card'
  node.dataset.state = state
  node.textContent = message
  if (state === 'error') node.setAttribute('role', 'alert')
  return node
}

function setPageStatus(message: string, tone: 'error' | 'loading' | 'ready') {
  if (!pageStatus) return
  pageStatus.textContent = message
  pageStatus.dataset.tone = tone
}

function setRefreshState(refreshing: boolean) {
  if (!refreshButton) return
  refreshButton.disabled = refreshing
  refreshButton.textContent = refreshing ? 'Refreshing…' : 'Refresh'
}

function nativeRequest(type: string, payload: SettingsRecord = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    let port: chrome.runtime.Port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      port.disconnect()
      reject(new Error(`Native host did not respond to ${type}.`))
    }, NATIVE_REQUEST_TIMEOUT_MS)
    port.onMessage.addListener((response) => {
      if (settled) return
      if (!isNativeMessage(response) || response.type !== type) {
        settled = true
        clearTimeout(timeout)
        port.disconnect()
        reject(new Error(`Native host response must use ${NATIVE_PROTOCOL_VERSION} and match ${type}.`))
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(response)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(chrome.runtime.lastError?.message || 'Native host disconnected.'))
    })
    port.postMessage(createNativeMessage(type, payload))
  })
}

function objectRecord(value: unknown): SettingsRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as SettingsRecord
    : {}
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function formatDate(value: string) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function formatAction(value: string) {
  return value.replaceAll('_', ' ')
}

function textNode(value: string) {
  const node = document.createElement('span')
  node.textContent = value
  return node
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
