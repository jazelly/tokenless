type Stored = { daemonOrigin?: string; credential?: string }
type Page = { tabId: number; origin: string; url: string; title: string; documentId: string; documentRevision: number }
type Observation = {
  protocol: string
  kind: string
  page: Omit<Page, 'tabId'>
  observationRevision: number
  controls: Array<{ elementRef: string; name: string; label: string; inputType: string; valuePresence: string }>
}
type Proposal = {
  actionId: string
  runId: string
  callId: string
  argumentsDigest: string
  status: 'awaiting_approval' | 'applying'
  target: { elementRef: string; label: string; name: string; inputType: string }
  text: string
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

let credential = ''
let sessionId = ''
let selectedPage: Page | undefined
let observation: Observation | undefined
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
    const result = await chrome.runtime.sendMessage<{ tabId: number; observation: Observation }>({ type: 'observe-active-tab' })
    const next = result.observation
    if (!next || next.kind !== 'semantic_page_observation') throw new Error('The page did not return a semantic observation.')
    observation = next
    selectedPage = { tabId: result.tabId, ...next.page }
    consent.checked = false
    sessionId = `extension-session:${crypto.randomUUID().replaceAll('-', '')}`
    detached = false
    pageStatus.textContent = `${next.page.title || 'Untitled'} · ${next.page.origin}`
    disclosure.textContent = `Origin: ${next.page.origin}. Bounded page content is sent through the approved provider route only after consent. / Origin：${next.page.origin}。只有同意后，有界页面内容才会经已批准 provider route 发送。`
    inventory.textContent = next.controls.length === 0
      ? 'No supported visible textual controls / 没有支持的可见文本控件'
      : next.controls.map((control, index) => `${index + 1}. ${control.label || control.name || 'Text field'} · ${control.inputType} · ${control.valuePresence}`).join('\n')
    setRunStatus(`Tab attached locally · ${next.controls.length} control(s) / 标签页已在本地附着 · ${next.controls.length} 个控件`)
  } catch (error) {
    setRunStatus(errorMessage(error))
  }
}

async function startRun() {
  if (!credential || !observation || !selectedPage || !sessionId) return setRunStatus('Pair and attach a tab first / 请先配对并附着标签页')
  if (!consent.checked) return setRunStatus('Consent is required before page content leaves the extension / 页面内容离开扩展前需要同意')
  if (!task.value.trim()) return setRunStatus('Enter a task / 请输入任务')
  try {
    await saveOrigin()
    await request('/v1/harness/browser-extension/sessions', {
      method: 'POST',
      body: JSON.stringify({ sessionId, page: selectedPage, observation }),
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
  while (!stopped && runId && sessionId) {
    try {
      const next = await request<Proposal | null>(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}/actions?runId=${encodeURIComponent(runId)}`)
      if (!next) {
        proposal = undefined
        approval.hidden = true
      } else {
        proposal = next
        approval.hidden = false
        proposalText.textContent = `${next.target.label || next.target.name || 'Text field'} · ${next.target.inputType}\n\nProposed text / 拟填文本：${next.text}`
        approveButton.disabled = next.status !== 'awaiting_approval'
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
    result = await chrome.runtime.sendMessage({
      type: 'apply-input',
      tabId: action.page.tabId,
      origin: action.page.origin,
      url: action.page.url,
      elementRef: action.target.elementRef,
      text: action.text,
      documentId: action.page.documentId,
      documentRevision: action.page.documentRevision,
      observationRevision: action.observationRevision,
    })
  } catch (error) {
    result = {
      protocol: 'tokenless.harness-browser-extension/v1',
      kind: 'input_result',
      status: 'failed',
      elementRef: action.target.elementRef,
      documentRevision: action.page.documentRevision,
      observationRevision: action.observationRevision,
      valueEvidence: { state: 'not_verified' },
      failure: { code: 'inaccessible_page', message: errorMessage(error) },
    }
  }
  try {
    await request(`/v1/harness/browser-extension/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(action.actionId)}/result`, {
      method: 'POST', body: JSON.stringify({ runId: action.runId, result }),
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
    waiting_for_approval: 'Waiting for input approval / 正在等待填写批准',
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
