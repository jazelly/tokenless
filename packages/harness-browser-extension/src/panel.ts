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

void initialize()

async function initialize() {
  const stored = await chrome.storage.local.get<Stored>(['daemonOrigin', 'credential'])
  if (stored.daemonOrigin) daemon.value = stored.daemonOrigin
  credential = stored.credential ?? ''
  await refreshConnection()
}

async function pair() {
  try {
    await saveOrigin()
    const response = await request<{ pairingId: string; secret: string; dashboardUrl: string; expiresAt: string }>('/v1/harness/browser-extension/pairings', {
      method: 'POST',
      body: JSON.stringify({ extensionId: chrome.runtime.id, extensionVersion: chrome.runtime.getManifest().version }),
    }, false)
    await chrome.tabs.create({ url: response.dashboardUrl })
    setConnection(`Pairing requested / 已请求配对 · ${response.pairingId}`)
    await pollPairing(response.pairingId, response.secret, Date.parse(response.expiresAt))
  } catch (error) {
    setConnection(errorMessage(error))
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
      setConnection('Paired / 已配对')
      route.textContent = `Route / 路由：${result.provider ?? '—'} · ${result.profileId ?? '—'}`
      return
    }
    setConnection('Pairing expired or revoked / 配对已过期或撤销')
    return
  }
  setConnection('Pairing expired / 配对已过期')
}

async function unpair() {
  try {
    if (credential) await request('/v1/harness/browser-extension/connection', { method: 'DELETE' })
  } catch { /* local credential is still removed */ }
  credential = ''
  await chrome.storage.local.remove('credential')
  setConnection('Not paired / 未配对')
  route.textContent = 'Provider route is selected and approved in Dashboard. / Provider route 在 Dashboard 中选择并批准。'
}

async function refreshConnection() {
  if (!credential) return setConnection('Not paired / 未配对')
  try {
    const value = await request<{ pairing: { provider?: string; profileId?: string } }>('/v1/harness/browser-extension/connection')
    setConnection('Paired / 已配对')
    route.textContent = `Route / 路由：${value.pairing.provider ?? '—'} · ${value.pairing.profileId ?? '—'}`
  } catch {
    credential = ''
    await chrome.storage.local.remove('credential')
    setConnection('Credential needs pairing again / 凭证需要重新配对')
  }
}

async function observeTab() {
  if (!credential) return setRunStatus('Pair the extension first / 请先配对扩展')
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
    pageStatus.textContent = `${next.page.title || 'Untitled'} · ${next.page.origin}`
    disclosure.textContent = `Origin: ${next.page.origin}. Bounded page content is sent through the approved provider route after consent; full evidence remains in the local private bundle. / Origin：${next.page.origin}。同意后有界页面内容会经批准的 provider route 发送；完整证据只保留在本机私有证据包。`
    inventory.textContent = next.controls.length === 0
      ? 'No supported visible controls / 没有支持的可见控件'
      : next.controls.map((control, index) => {
        const state = control.role === 'radio' ? (control.checked ? 'selected' : 'not selected') : control.valuePresence
        return `${index + 1}. ${control.label || control.name || 'Control'} · ${control.inputType} · ${control.actions.join('/')} · ${state}`
      }).join('\n')
    setRunStatus(`Tab attached locally · ${next.controls.length} control(s) / 标签页已在本地附着 · ${next.controls.length} 个控件`)
  } catch (error) {
    setRunStatus(errorMessage(error))
  }
}

async function startRun() {
  if (!credential || !observation || !selectedPage || !sessionId || !initialEvidence) return setRunStatus('Pair and attach a tab first / 请先配对并附着标签页')
  if (!consent.checked) return setRunStatus('Consent is required before page content leaves the extension or full evidence is saved / 发送页面内容或保存完整证据前需要同意')
  if (!task.value.trim()) return setRunStatus('Enter a task / 请输入任务')
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
    setRunStatus(stateLabel(started.status))
    void pollUntilTerminal()
    void actionLoop()
  } catch (error) {
    setRunStatus(errorMessage(error))
  }
}

async function pollUntilTerminal() {
  while (!stopped && runId) {
    try {
      const view = await request<RunView>(`/v1/harness/browser-extension/runs/${encodeURIComponent(runId)}`)
      setRunStatus(view.error ? errorMessage(new Error(view.error.message)) : stateLabel(view.status))
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
      setRunStatus(errorMessage(error))
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
      setRunStatus(errorMessage(error))
    }
    await delay(400)
  }
}

async function decide(approved: boolean) {
  const frozen = proposal
  if (!frozen || frozen.status !== 'awaiting_approval') return
  if (approved && frozen.action === 'upload' && uploadFile.files?.length !== 1) {
    return setRunStatus('Select exactly one file before approval / 批准前请选择一个文件')
  }
  approveButton.disabled = true
  rejectButton.disabled = true
  void request(`/v1/harness/browser-extension/runs/${encodeURIComponent(frozen.runId)}/actions/${encodeURIComponent(frozen.actionId)}/decision`, {
    method: 'POST',
    body: JSON.stringify({ approved, callId: frozen.callId, argumentsDigest: frozen.argumentsDigest }),
  }).catch((error) => setRunStatus(errorMessage(error)))
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
    setRunStatus(errorMessage(error))
  }
}

async function cancelRun() {
  if (!runId) return
  try {
    await request(`/v1/harness/browser-extension/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' })
    stopped = true
    await detachSession()
  } catch (error) {
    setRunStatus(errorMessage(error))
  }
}

async function detachSession() {
  if (detached || !sessionId) return
  detached = true
  await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => undefined)
}

function proposalDescription(value: Proposal) {
  const target = value.target ? `${value.target.label || value.target.name || 'Control'} · ${value.target.inputType}` : value.page.origin
  const detail = value.action === 'input' ? `\n\nProposed text / 拟填文本：${value.text ?? ''}`
    : value.action === 'navigate' ? `\n\nDestination / 目标地址：${value.url ?? ''}`
      : value.action === 'upload' ? '\n\nSelect one local file below. / 请在下方选择一个本地文件。'
        : ''
  return `${actionLabel(value.action)}\n${target}${detail}`
}

function actionLabel(action: Proposal['action']) {
  const labels: Record<Proposal['action'], string> = {
    input: 'Text input / 文本填写',
    click: 'Button click / 按钮点击',
    submit: 'Form submit / 表单提交',
    radio: 'Radio selection / 单选项选择',
    upload: 'File upload / 文件上传',
    navigate: 'Page navigation / 页面导航',
  }
  return labels[action]
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

function stateLabel(state: string) {
  const labels: Record<string, string> = {
    discovering_tools: 'Capturing page tools / 正在准备页面工具',
    submitting_provider: 'Waiting for Harness Task Model / 正在等待 Harness Task Model',
    running: 'Harness run is running / Harness run 正在运行',
    waiting_for_approval: 'Waiting for action approval / 正在等待操作批准',
    succeeded: 'Completed / 已完成',
    failed: 'Failed / 失败',
    cancelled: 'Cancelled / 已取消',
  }
  return labels[state] ?? `${state} / ${state}`
}

function setConnection(value: string) { connection.textContent = value }
function setRunStatus(value: string) { runStatus.textContent = value }
function errorMessage(error: unknown) {
  if (!(error instanceof Error)) return 'Request failed / 请求失败'
  return error.message.includes(' / ') ? error.message : `${error.message} / 操作失败，请检查当前页面或连接。`
}
function delay(milliseconds: number) { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
