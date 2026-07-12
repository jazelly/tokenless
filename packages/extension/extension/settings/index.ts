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
type Locale = 'en' | 'zh-CN'
type PageStatusTone = 'error' | 'loading' | 'ready'

const translations: Record<Locale, Record<string, string>> = {
  en: {
    'navigation.label': 'Tokenless panel views',
    'navigation.activity': 'Activity',
    'navigation.settings': 'Settings',
    'language.label': 'Language',
    'language.description': 'Uses Chrome\'s language until you choose an override.',
    'language.useChromeDefault': 'Use Chrome default',
    'settings.routing': 'Routing',
    'settings.routingDescription': 'Provider preferences are stored locally on this computer.',
    'activity.recent': 'Recent activity',
    'activity.description': 'Newest local jobs first. Prompts and answers are never shown here.',
    'github.link': 'View Tokenless on GitHub',
    'provider.preference': 'Provider preference',
    'provider.noPreference': 'No preference saved. New jobs default to ChatGPT.',
    'provider.preferred': 'Preferred provider',
    'provider.fallback': 'Fallback provider',
    'provider.moveUp': 'Move {provider} up',
    'provider.moveDown': 'Move {provider} down',
    'provider.removeAction': 'Remove',
    'provider.remove': 'Remove {provider}',
    'provider.select': 'Provider to add',
    'provider.add': 'Add provider',
    'provider.addUnavailable': 'Adding providers is temporarily unavailable.',
    'settings.browserPreference': 'Browser preference',
    'settings.browserPlaceholder': 'Auto-detect Chromium',
    'settings.browserHelp': 'Optional supported Chromium browser; otherwise Tokenless detects one deterministically.',
    'settings.daemonUrl': 'Daemon URL',
    'settings.daemonHelp': 'The loopback address of the local Tokenless daemon.',
    'settings.save': 'Save settings',
    'settings.saving': 'Saving…',
    'settings.unsaved': 'Unsaved changes',
    'settings.saved': 'Settings saved.',
    'settings.savingNotice': 'Saving settings…',
    'settings.unavailable': 'Configuration is unavailable.',
    'settings.saveFailed': 'Settings could not be saved.',
    'history.loading': 'Loading daemon history…',
    'history.unavailable': 'Daemon history is unavailable.',
    'history.empty': 'No daemon jobs yet.',
    'history.project': 'Project: {value}',
    'history.action': 'Action: {value}',
    'history.updated': 'Updated: {value}',
    'history.task': 'Task: {value}',
    'history.jobId': 'Job ID: {value}',
    'configuration.loading': 'Loading configuration…',
    'status.connecting': 'Connecting…',
    'status.nativeHostReady': 'Native host ready',
    'status.nativeHostUnavailable': 'Native host unavailable',
    'status.partiallyLoaded': 'Partially loaded',
    'status.refreshingHistory': 'Refreshing history…',
    'status.historyRefreshFailed': 'History refresh failed',
    'status.saveFailed': 'Save failed',
    'action.refresh': 'Refresh',
    'action.refreshing': 'Refreshing…',
    'value.unknown': 'Unknown',
    'action.submit_and_read': 'Submit and read',
    'action.submit': 'Submit',
    'action.read': 'Read',
    'action.open': 'Open',
    'job.queued': 'Queued',
    'job.claimed': 'Claimed',
    'job.running': 'Running',
    'job.succeeded': 'Succeeded',
    'job.failed': 'Failed',
    'job.canceled': 'Canceled',
    'job.timed_out': 'Timed out',
    'error.readConfig': 'The native host could not read configuration.',
    'error.saveConfig': 'The native host could not save configuration.',
    'error.listHistory': 'The native host could not list daemon history.',
    'error.nativeTimeout': 'Native host did not respond to {type}.',
    'error.nativeProtocol': 'Native host response must use {protocol} and match {type}.',
    'error.nativeDisconnected': 'Native host disconnected.',
  },
  'zh-CN': {
    'navigation.label': 'Tokenless 侧栏视图',
    'navigation.activity': '动态',
    'navigation.settings': '设置',
    'language.label': '语言',
    'language.description': '在选择覆盖语言前，跟随 Chrome 的语言。',
    'language.useChromeDefault': '使用 Chrome 默认语言',
    'settings.routing': '路由',
    'settings.routingDescription': 'Provider 偏好仅保存在这台电脑上。',
    'activity.recent': '最近动态',
    'activity.description': '最新本地任务优先显示；这里不会显示 prompt 或回答。',
    'github.link': '在 GitHub 查看 Tokenless',
    'provider.preference': 'Provider 偏好',
    'provider.noPreference': '尚未保存偏好。新任务默认使用 ChatGPT。',
    'provider.preferred': '首选 Provider',
    'provider.fallback': '备用 Provider',
    'provider.moveUp': '将 {provider} 上移',
    'provider.moveDown': '将 {provider} 下移',
    'provider.removeAction': '移除',
    'provider.remove': '移除 {provider}',
    'provider.select': '选择要添加的 Provider',
    'provider.add': '添加 Provider',
    'provider.addUnavailable': '暂不支持添加 Provider。',
    'settings.browserPreference': '浏览器偏好',
    'settings.browserPlaceholder': '自动检测 Chromium',
    'settings.browserHelp': '可选的受支持 Chromium 浏览器；否则 Tokenless 会按固定顺序自动检测。',
    'settings.daemonUrl': 'Daemon URL',
    'settings.daemonHelp': '本地 Tokenless daemon 的 loopback 地址。',
    'settings.save': '保存设置',
    'settings.saving': '正在保存…',
    'settings.unsaved': '尚未保存的更改',
    'settings.saved': '设置已保存。',
    'settings.savingNotice': '正在保存设置…',
    'settings.unavailable': '配置暂时不可用。',
    'settings.saveFailed': '无法保存设置。',
    'history.loading': '正在加载 daemon 历史记录…',
    'history.unavailable': 'Daemon 历史记录暂时不可用。',
    'history.empty': '尚无 daemon 任务。',
    'history.project': '项目：{value}',
    'history.action': '操作：{value}',
    'history.updated': '更新：{value}',
    'history.task': '任务：{value}',
    'history.jobId': '任务 ID：{value}',
    'configuration.loading': '正在加载配置…',
    'status.connecting': '正在连接…',
    'status.nativeHostReady': 'Native host 已就绪',
    'status.nativeHostUnavailable': 'Native host 不可用',
    'status.partiallyLoaded': '部分内容未加载',
    'status.refreshingHistory': '正在刷新历史记录…',
    'status.historyRefreshFailed': '历史记录刷新失败',
    'status.saveFailed': '保存失败',
    'action.refresh': '刷新',
    'action.refreshing': '正在刷新…',
    'value.unknown': '未知',
    'action.submit_and_read': '提交并读取',
    'action.submit': '提交',
    'action.read': '读取',
    'action.open': '打开',
    'job.queued': '排队中',
    'job.claimed': '已领取',
    'job.running': '运行中',
    'job.succeeded': '已完成',
    'job.failed': '失败',
    'job.canceled': '已取消',
    'job.timed_out': '已超时',
    'error.readConfig': 'Native host 无法读取配置。',
    'error.saveConfig': 'Native host 无法保存配置。',
    'error.listHistory': 'Native host 无法读取 daemon 历史记录。',
    'error.nativeTimeout': 'Native host 未响应 {type}。',
    'error.nativeProtocol': 'Native host 响应必须使用 {protocol} 并匹配 {type}。',
    'error.nativeDisconnected': 'Native host 已断开连接。',
  },
}

const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const NATIVE_REQUEST_TIMEOUT_MS = 10000
const providers = listProviders()
const supportedProviderIds = providers.map((provider) => provider.id)
const configuration = document.querySelector<HTMLElement>('#configuration')
const history = document.querySelector<HTMLElement>('#history')
const refreshButton = document.querySelector<HTMLButtonElement>('#refresh')
const pageStatus = document.querySelector<HTMLElement>('#page-status')
const hero = document.querySelector<HTMLElement>('.hero')
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-view]'))
const viewPanels = Array.from(document.querySelectorAll<HTMLElement>('[data-view-panel]'))
const localeButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-locale]'))
const browserLanguageButton = document.querySelector<HTMLButtonElement>('[data-use-browser-language]')

let providerOrder: string[] = []
let browserPreference = ''
let daemonUrl = ''
let isSaving = false
let isHistoryRefreshing = false
let localePreference = readLocalePreference()
let locale = localePreference ?? chromeLocale()
let lastHistoryEntries: HistoryEntry[] | null = null
let currentStatusKey = 'status.connecting'
let currentStatusTone: PageStatusTone = 'loading'

applyLocale()

viewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setActiveView(button.dataset.view)
  })
})

localeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    setLocale(button.dataset.locale)
  })
})

browserLanguageButton?.addEventListener('click', () => {
  useChromeLocale()
})

refreshButton?.addEventListener('click', () => {
  void refreshHistory()
})

setActiveView('activity')
void loadInitialSettings()

function setActiveView(view: string | undefined) {
  if (view !== 'activity' && view !== 'settings') return
  if (hero) hero.dataset.view = view
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
  setPageStatus('status.connecting', 'loading')
  renderConfigurationState(t('configuration.loading'), 'loading')
  renderHistoryState(t('history.loading'), 'loading')

  const [configResult, historyResult] = await Promise.allSettled([
    loadConfig(),
    loadHistory(),
  ])

  isHistoryRefreshing = false
  setRefreshState(false)
  const failures = [configResult, historyResult].filter((result) => result.status === 'rejected')
  if (failures.length === 0) {
    setPageStatus('status.nativeHostReady', 'ready')
  } else {
    setPageStatus(failures.length === 2 ? 'status.nativeHostUnavailable' : 'status.partiallyLoaded', 'error')
  }
}

async function refreshHistory() {
  if (isHistoryRefreshing) return
  isHistoryRefreshing = true
  setRefreshState(true)
  setPageStatus('status.refreshingHistory', 'loading')
  renderHistoryState(t('history.loading'), 'loading')
  try {
    await loadHistory()
    setPageStatus('status.nativeHostReady', 'ready')
  } catch {
    setPageStatus('status.historyRefreshFailed', 'error')
  } finally {
    isHistoryRefreshing = false
    setRefreshState(false)
  }
}

async function loadConfig() {
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.READ_CONFIG)
    if (!response.ok) {
      throw new Error(response.error?.message || t('error.readConfig'))
    }
    const config = objectRecord(response.result)
    providerOrder = normalizeProviderOrder(config.preferredProviders, supportedProviderIds)
    browserPreference = stringValue(config.browser)
    daemonUrl = stringValue(config.daemonUrl)
    renderConfigEditor()
  } catch (error) {
    renderConfigurationState(errorMessage(error, t('settings.unavailable')), 'error')
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
  providerHeading.textContent = t('provider.preference')
  providerEditor.append(providerHeading)

  const providerList = document.createElement('div')
  providerList.className = 'provider-list'
  if (providerOrder.length === 0) {
    providerList.append(stateNode(t('provider.noPreference'), 'empty'))
  } else {
    providerList.append(...providerOrder.map(renderProviderRow))
  }
  providerEditor.append(providerList)

  const addRow = renderProviderAddRow()
  if (addRow) providerEditor.append(addRow)

  const formGrid = document.createElement('div')
  formGrid.className = 'form-grid'
  const browserField = textField({
    label: t('settings.browserPreference'),
    value: browserPreference,
    placeholder: t('settings.browserPlaceholder'),
    help: t('settings.browserHelp'),
    onInput: (value) => { browserPreference = value },
  })
  const daemonField = textField({
    label: t('settings.daemonUrl'),
    value: daemonUrl,
    placeholder: 'http://127.0.0.1:7331',
    help: t('settings.daemonHelp'),
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
  save.textContent = isSaving ? t('settings.saving') : t('settings.save')
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
  description.textContent = index === 0 ? t('provider.preferred') : t('provider.fallback')
  copy.append(label, description)
  identity.append(rank, copy)

  const controls = document.createElement('div')
  controls.className = 'provider-controls'
  const providerName = providerLabel(providerId)
  controls.append(
    rowButton('↑', t('provider.moveUp', { provider: providerName }), providerId, 'up', () => moveProvider(index, -1), index === 0),
    rowButton('↓', t('provider.moveDown', { provider: providerName }), providerId, 'down', () => moveProvider(index, 1), index === providerOrder.length - 1),
    rowButton(t('provider.removeAction'), t('provider.remove', { provider: providerName }), providerId, 'remove', () => removeProvider(index), false, 'danger')
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
  select.setAttribute('aria-label', t('provider.select'))
  select.disabled = true
  select.replaceChildren(...remaining.map((providerId) => {
    const option = document.createElement('option')
    option.value = providerId
    option.textContent = providerLabel(providerId)
    return option
  }))
  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'secondary-button'
  add.textContent = t('provider.add')
  add.disabled = true
  const disabledControl = document.createElement('span')
  disabledControl.className = 'provider-add-disabled'
  disabledControl.dataset.tooltip = t('provider.addUnavailable')
  disabledControl.setAttribute('aria-label', t('provider.addUnavailable'))
  disabledControl.append(select, add)
  row.append(disabledControl)
  return row
}

async function saveConfig() {
  if (isSaving) return
  isSaving = true
  renderConfigEditor(t('settings.savingNotice'), 'loading')
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.WRITE_CONFIG, configWritePayload({
      providerOrder,
      browser: browserPreference,
      daemonUrl,
    }))
    if (!response.ok) {
      throw new Error(response.error?.message || t('error.saveConfig'))
    }
    const config = objectRecord(response.result)
    providerOrder = normalizeProviderOrder(config.preferredProviders, supportedProviderIds)
    browserPreference = stringValue(config.browser)
    daemonUrl = stringValue(config.daemonUrl)
    isSaving = false
    renderConfigEditor(t('settings.saved'), 'success')
    setPageStatus('status.nativeHostReady', 'ready')
  } catch (error) {
    isSaving = false
    renderConfigEditor(errorMessage(error, t('settings.saveFailed')), 'error')
    setPageStatus('status.saveFailed', 'error')
  }
}

async function loadHistory() {
  try {
    const response = await nativeRequest(NATIVE_MESSAGE_TYPES.LIST_HISTORY, { limit: 100 })
    if (!response.ok) {
      throw new Error(response.error?.message || t('error.listHistory'))
    }
    renderHistory(response.result)
  } catch (error) {
    renderHistoryState(errorMessage(error, t('history.unavailable')), 'error')
    throw error
  }
}

function renderHistory(value: unknown) {
  if (!history) return
  const entries = normalizeHistoryEntries(value)
  lastHistoryEntries = entries
  if (entries.length === 0) {
    renderHistoryState(t('history.empty'), 'empty')
    return
  }

  renderHistoryEntries(entries)
}

function renderHistoryEntries(entries: HistoryEntry[]) {
  history?.replaceChildren(...entries.map(renderHistoryJob))
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
  badges.append(badgeNode(providerLabel(entry.provider)), badgeNode(localizeJobStatus(entry.status), entry.status))
  heading.append(title, badges)

  const meta = document.createElement('div')
  meta.className = 'job-meta'
  meta.append(
    textNode(t('history.project', { value: entry.projectName })),
    textNode(t('history.action', { value: formatAction(entry.action) })),
    textNode(t('history.updated', { value: formatDate(entry.updatedAt) })),
    textNode(t('history.task', { value: entry.taskId }))
  )
  const jobId = document.createElement('div')
  jobId.className = 'job-id'
  jobId.textContent = t('history.jobId', { value: entry.jobId })
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
  renderConfigEditor(t('settings.unsaved'), 'loading', {
    providerId,
    action: delta < 0 ? 'up' : 'down',
  })
}

function removeProvider(index: number) {
  const focusProviderId = providerOrder[index + 1] ?? providerOrder[index - 1]
  providerOrder = providerOrder.filter((_, providerIndex) => providerIndex !== index)
  renderConfigEditor(t('settings.unsaved'), 'loading', focusProviderId
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

function setPageStatus(key: string, tone: PageStatusTone) {
  if (!pageStatus) return
  currentStatusKey = key
  currentStatusTone = tone
  pageStatus.textContent = t(key)
  pageStatus.dataset.tone = tone
}

function setRefreshState(refreshing: boolean) {
  if (!refreshButton) return
  refreshButton.disabled = refreshing
  refreshButton.textContent = refreshing ? t('action.refreshing') : t('action.refresh')
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
      reject(new Error(t('error.nativeTimeout', { type })))
    }, NATIVE_REQUEST_TIMEOUT_MS)
    port.onMessage.addListener((response) => {
      if (settled) return
      if (!isNativeMessage(response) || response.type !== type) {
        settled = true
        clearTimeout(timeout)
        port.disconnect()
        reject(new Error(t('error.nativeProtocol', { protocol: NATIVE_PROTOCOL_VERSION, type })))
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
      reject(new Error(chrome.runtime.lastError?.message || t('error.nativeDisconnected')))
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
  if (!value) return t('value.unknown')
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale)
}

function formatAction(value: string) {
  return translationFor(`action.${value}`) ?? value.replaceAll('_', ' ')
}

function localizeJobStatus(value: string) {
  return translationFor(`job.${value}`) ?? value.replaceAll('_', ' ')
}

function textNode(value: string) {
  const node = document.createElement('span')
  node.textContent = value
  return node
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}

function readLocalePreference(): Locale | null {
  try {
    const saved = localStorage.getItem('tokenless.settings.locale')
    return saved === 'en' || saved === 'zh-CN' ? saved : null
  } catch {
    return null
  }
}

function setLocale(value: string | undefined) {
  if (value !== 'en' && value !== 'zh-CN') return
  localePreference = value
  locale = value
  try {
    localStorage.setItem('tokenless.settings.locale', locale)
  } catch {
    // The extension remains usable if local storage is unavailable.
  }
  applyLocale()
  renderConfigEditor()
  if (lastHistoryEntries) renderHistoryEntries(lastHistoryEntries)
  setPageStatus(currentStatusKey, currentStatusTone)
  setRefreshState(isHistoryRefreshing)
}

function useChromeLocale() {
  localePreference = null
  locale = chromeLocale()
  try {
    localStorage.removeItem('tokenless.settings.locale')
  } catch {
    // The extension remains usable if local storage is unavailable.
  }
  applyLocale()
  renderConfigEditor()
  if (lastHistoryEntries) renderHistoryEntries(lastHistoryEntries)
  setPageStatus(currentStatusKey, currentStatusTone)
  setRefreshState(isHistoryRefreshing)
}

function applyLocale() {
  document.documentElement.lang = locale
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((node) => {
    const key = node.dataset.i18n
    if (key) node.textContent = t(key)
  })
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((node) => {
    const key = node.dataset.i18nAriaLabel
    if (key) node.setAttribute('aria-label', t(key))
  })
  localeButtons.forEach((button) => {
    const selected = button.dataset.locale === localePreference
    button.classList.toggle('is-active', selected)
    button.setAttribute('aria-pressed', String(selected))
  })
  const usingChromeDefault = localePreference === null
  browserLanguageButton?.classList.toggle('is-active', usingChromeDefault)
  browserLanguageButton?.setAttribute('aria-pressed', String(usingChromeDefault))
}

function chromeLocale(): Locale {
  const chromeLanguage = chrome.i18n?.getUILanguage?.() ?? navigator.language
  return chromeLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

function t(key: string, values: Record<string, string> = {}) {
  const template = translations[locale][key] ?? translations.en[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? `{${name}}`)
}

function translationFor(key: string) {
  return translations[locale][key] ?? translations.en[key]
}
