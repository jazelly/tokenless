import { capabilitiesPayload } from '../shared/bridge-protocol.js'

const NATIVE_HOST_NAME = 'dev.tokenless.native_host'
const status = document.querySelector('#status')
const providers = document.querySelector('#providers')
const configuration = document.querySelector('#configuration')
const history = document.querySelector('#history')
const refreshHistory = document.querySelector('#refresh-history')
const capabilities = capabilitiesPayload()
const supportedProviderIds = capabilities.providers.map((provider) => provider.id)
let configProviderOrder = []

status.textContent = 'Ready'

providers.replaceChildren(...capabilities.providers.map((provider) => {
  const row = document.createElement('div')
  row.className = 'provider'

  const label = document.createElement('strong')
  label.textContent = provider.label

  const meta = document.createElement('span')
  meta.textContent = new URL(provider.homeUrl).hostname

  row.append(label, meta)
  return row
}))

refreshHistory?.addEventListener('click', () => {
  refreshLocalState()
})

refreshLocalState()

function refreshLocalState() {
  loadConfig().catch((error) => renderConfigError(error))
  loadHistory().catch((error) => renderHistoryError(error))
}

async function loadConfig() {
  if (!configuration) return
  configuration.replaceChildren(messageNode('Loading local configuration...'))
  const response = await nativeRequest({ type: 'tokenless.native.read_config' })
  if (!response.ok) {
    throw new Error(response.error?.message || 'Tokenless native host could not load configuration.')
  }
  renderConfig(response.result)
}

function renderConfig(config) {
  if (!configuration) return
  configProviderOrder = normalizeProviderOrder(config?.preferredProviders)
  renderConfigEditor()
}

function renderConfigEditor(message) {
  if (!configuration) return
  const editor = document.createElement('div')
  editor.className = 'provider-editor'

  if (configProviderOrder.length === 0) {
    editor.append(messageNode('No local provider order configured; CLI falls back to ChatGPT.'))
  } else {
    editor.append(...configProviderOrder.map((providerId, index) => renderProviderEditorRow(providerId, index)))
  }

  const addRow = renderProviderAddRow()
  if (addRow) {
    editor.append(addRow)
  }

  const actions = document.createElement('div')
  actions.className = 'provider-editor-actions'

  const save = document.createElement('button')
  save.type = 'button'
  save.textContent = 'Save'
  save.addEventListener('click', () => {
    saveConfig().catch((error) => renderConfigEditor(error?.message || 'Local configuration could not be saved.'))
  })

  const clear = document.createElement('button')
  clear.type = 'button'
  clear.textContent = 'Clear'
  clear.addEventListener('click', () => {
    configProviderOrder = []
    renderConfigEditor('Cleared locally. Save to update ~/.tokenless/config.json.')
  })

  actions.append(save, clear)
  editor.append(actions)

  if (message) {
    editor.append(messageNode(message))
  }

  configuration.replaceChildren(editor)
}

function renderProviderEditorRow(providerId, index) {
  const row = document.createElement('div')
  row.className = 'provider-editor-row'

  const label = document.createElement('strong')
  label.textContent = providerLabel(providerId)

  const controls = document.createElement('div')
  controls.className = 'provider-editor-controls'
  controls.append(
    providerButton('^', () => moveProvider(index, -1), index === 0),
    providerButton('v', () => moveProvider(index, 1), index === configProviderOrder.length - 1),
    providerButton('Remove', () => removeProvider(index), false)
  )

  row.append(label, controls)
  return row
}

function renderProviderAddRow() {
  const remaining = supportedProviderIds.filter((providerId) => !configProviderOrder.includes(providerId))
  if (remaining.length === 0) return null

  const row = document.createElement('div')
  row.className = 'provider-editor-add'

  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Provider')
  select.replaceChildren(...remaining.map((providerId) => {
    const option = document.createElement('option')
    option.value = providerId
    option.textContent = providerLabel(providerId)
    return option
  }))

  const add = document.createElement('button')
  add.type = 'button'
  add.textContent = 'Add'
  add.addEventListener('click', () => {
    if (!select.value || configProviderOrder.includes(select.value)) return
    configProviderOrder = [...configProviderOrder, select.value]
    renderConfigEditor()
  })

  row.append(select, add)
  return row
}

function providerButton(text, onClick, disabled) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = text
  button.disabled = disabled
  button.addEventListener('click', onClick)
  return button
}

function moveProvider(index, delta) {
  const nextIndex = index + delta
  if (nextIndex < 0 || nextIndex >= configProviderOrder.length) return
  const next = [...configProviderOrder]
  const [provider] = next.splice(index, 1)
  next.splice(nextIndex, 0, provider)
  configProviderOrder = next
  renderConfigEditor()
}

function removeProvider(index) {
  configProviderOrder = configProviderOrder.filter((_, providerIndex) => providerIndex !== index)
  renderConfigEditor()
}

async function saveConfig() {
  if (!configuration) return
  const response = await nativeRequest({
    type: 'tokenless.native.write_config',
    preferredProviders: configProviderOrder,
  })
  if (!response.ok) {
    throw new Error(response.error?.message || 'Tokenless native host could not save configuration.')
  }
  configProviderOrder = normalizeProviderOrder(response.result?.preferredProviders)
  renderConfigEditor('Saved to ~/.tokenless/config.json.')
}

async function loadHistory() {
  if (!history) return
  history.replaceChildren(messageNode('Loading local history...'))
  const response = await nativeRequest({ type: 'tokenless.native.list_history', limit: 60 })
  if (!response.ok) {
    throw new Error(response.error?.message || 'Tokenless native host could not load history.')
  }
  renderHistory(response.result?.history ?? [])
}

function renderHistory(entries) {
  if (!history) return
  if (entries.length === 0) {
    history.replaceChildren(messageNode('No mapped local tasks yet.'))
    return
  }

  const projects = new Map()
  for (const entry of entries) {
    const key = entry.projectName || 'Unspecified project'
    const group = projects.get(key) ?? []
    group.push(entry)
    projects.set(key, group)
  }

  history.replaceChildren(...[...projects.entries()].map(([projectName, conversations]) => {
    const project = document.createElement('section')
    project.className = 'project'

    const title = document.createElement('div')
    title.className = 'project-title'
    title.textContent = projectName

    project.append(title, ...conversations.map(renderConversation))
    return project
  }))
}

function renderConversation(entry) {
  const row = document.createElement('article')
  row.className = 'conversation'

  const header = document.createElement('div')
  header.className = 'conversation-header'

  const title = document.createElement('div')
  title.className = 'conversation-title'
  title.textContent = entry.chatName || entry.idempotencyKey || 'Unspecified chat'

  const provider = document.createElement('span')
  provider.className = 'pill'
  provider.textContent = providerLabel(entry.provider)

  header.append(title, provider)

  const meta = document.createElement('div')
  meta.className = 'conversation-meta'
  meta.append(
    metaLine('Status', entry.lastStatus || 'mapped'),
    metaLine('Runs', String(entry.jobCount ?? 0)),
    metaLine('Updated', formatDate(entry.updatedAt))
  )
  if (entry.targetUrl) {
    meta.append(urlLine(entry.targetUrl))
  }

  row.append(header, meta)
  return row
}

function metaLine(label, value) {
  const line = document.createElement('div')
  line.textContent = `${label}: ${value}`
  return line
}

function urlLine(url) {
  const line = document.createElement('div')
  const label = document.createTextNode('Provider URL: ')
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.textContent = url
  line.append(label, link)
  return line
}

function messageNode(text) {
  const node = document.createElement('p')
  node.className = 'muted'
  node.textContent = text
  return node
}

function renderHistoryError(error) {
  if (!history) return
  history.replaceChildren(messageNode(error?.message || 'Local history is unavailable.'))
}

function renderConfigError(error) {
  if (!configuration) return
  configuration.replaceChildren(messageNode(error?.message || 'Local configuration is unavailable.'))
}

function providerLabel(providerId) {
  return capabilities.providers.find((provider) => provider.id === providerId)?.label ?? providerId ?? 'Provider'
}

function normalizeProviderOrder(providers) {
  if (!Array.isArray(providers)) return []
  const seen = new Set()
  const normalized = []
  for (const provider of providers) {
    if (!supportedProviderIds.includes(provider) || seen.has(provider)) continue
    seen.add(provider)
    normalized.push(provider)
  }
  return normalized
}

function formatDate(value) {
  if (!value) return 'Unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function nativeRequest(message) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME)
    let settled = false
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true
        port.disconnect()
        reject(new Error(`Native host did not respond to ${message.type}.`))
      }
    }, 5000)
    port.onMessage.addListener((response) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(response)
      port.disconnect()
    })
    port.onDisconnect.addListener(() => {
      if (!settled) {
        clearTimeout(timeout)
        reject(new Error(chrome.runtime.lastError?.message || 'Native host disconnected.'))
      }
    })
    port.postMessage(message)
  })
}
