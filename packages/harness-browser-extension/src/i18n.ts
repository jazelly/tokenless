export type Language = 'en' | 'zh'

export const LANGUAGES: Language[] = ['en', 'zh']
const DEFAULT_LANGUAGE: Language = 'en'
const STORAGE_KEY = 'language'

const STRINGS = {
  en: {
    docTitle: 'Tokenless Harness',
    settingsHeading: 'Settings',
    languageLabel: 'Language',
    eyebrow: 'Tokenless Harness API',
    appHeading: 'Browser task',
    connectionHeading: 'Connection',
    notPaired: 'Not paired',
    daemonLabel: 'Daemon origin',
    routeDefault: 'Provider route is selected and approved in Dashboard.',
    pairButton: 'Pair in Dashboard',
    unpairButton: 'Unpair',
    refreshButton: 'Refresh',
    pairingHelp: 'The credential is extension-scoped and revocable. It cannot control the daemon.',
    currentTabHeading: 'Current tab',
    noTabAttached: 'No tab attached',
    untitled: 'Untitled',
    pageDisclosureDefault: 'A bounded semantic page snapshot is sent through the selected Tokenless API provider route only after consent. Full local evidence is saved privately on this device.',
    consentLabel: 'I consent to send bounded page content to the selected Harness Task Model and save full local evidence.',
    attachButton: 'Attach or repair selected tab',
    taskHeading: 'Task',
    taskLabel: 'Natural-language task',
    taskPlaceholder: 'Fill the name field with Jazelly.',
    startRunButton: 'Start Harness run',
    cancelButton: 'Cancel',
    noRun: 'No run',
    approvalHeading: 'Approval required',
    uploadLabelText: 'File selected for this approved upload',
    approveButton: 'Approve action',
    rejectButton: 'Reject',
    privacyHeading: 'Privacy',
    privacyBody: 'Page text is untrusted data. The model receives only bounded semantic controls. Raw DOM, entered values, screenshots, the extension credential, and the selected provider session are retained only in the private local evidence bundle.',
    settingsButton: 'Settings',
    pairingRequested: (id: string) => `Pairing requested · ${id}`,
    paired: 'Paired',
    pairingExpiredOrRevoked: 'Pairing expired or revoked',
    pairingExpired: 'Pairing expired',
    credentialNeedsPairing: 'Credential needs pairing again',
    routeValue: (provider: string, profileId: string) => `Route: ${provider} · ${profileId}`,
    pairFirst: 'Pair the extension first',
    noSupportedControls: 'No supported visible controls',
    control: 'Control',
    selected: 'selected',
    notSelected: 'not selected',
    tabAttachedLocally: (count: number) => `Tab attached locally · ${count} control(s)`,
    pairAndAttach: 'Pair and attach a tab first',
    consentRequired: 'Consent is required before page content leaves the extension or full evidence is saved',
    enterTask: 'Enter a task',
    selectOneFile: 'Select exactly one file before approval',
    requestFailed: 'Request failed',
    errorSuffix: 'Check the current page or connection.',
    actionLabels: {
      input: 'Text input',
      click: 'Button click',
      submit: 'Form submit',
      radio: 'Radio selection',
      upload: 'File upload',
      navigate: 'Page navigation',
    },
    stateLabels: {
      discovering_tools: 'Capturing page tools',
      submitting_provider: 'Waiting for Harness Task Model',
      running: 'Harness run is running',
      waiting_for_approval: 'Waiting for action approval',
      succeeded: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    proposedText: (text: string) => `Proposed text: ${text}`,
    destination: (url: string) => `Destination: ${url}`,
    selectFileBelow: 'Select one local file below.',
    originDisclosure: (origin: string) => `Origin: ${origin}. Bounded page content is sent through the approved provider route after consent; full evidence remains in the local private bundle.`,
  },
  zh: {
    docTitle: 'Tokenless Harness',
    settingsHeading: '设置',
    languageLabel: '语言',
    eyebrow: 'Tokenless Harness API',
    appHeading: '浏览器任务',
    connectionHeading: '连接',
    notPaired: '未配对',
    daemonLabel: 'Daemon origin',
    routeDefault: 'Provider route 在 Dashboard 中选择并批准。',
    pairButton: '在 Dashboard 配对',
    unpairButton: '解除配对',
    refreshButton: '刷新',
    pairingHelp: '凭证只属于本扩展且可撤销，不能控制 daemon。',
    currentTabHeading: '当前标签页',
    noTabAttached: '尚未附着标签页',
    untitled: '无标题',
    pageDisclosureDefault: '只有在同意后，有界语义页面快照才会经所选 Tokenless API provider route 发送；完整证据会私密保存在本机。',
    consentLabel: '我同意将有界页面内容发送给所选 Harness Task Model，并保存完整本地证据。',
    attachButton: '附着或修复当前标签页',
    taskHeading: '任务',
    taskLabel: '自然语言任务',
    taskPlaceholder: '将姓名字段填写为 Jazelly。',
    startRunButton: '启动 Harness run',
    cancelButton: '取消',
    noRun: '尚无 run',
    approvalHeading: '需要批准',
    uploadLabelText: '为本次批准上传选择文件',
    approveButton: '批准操作',
    rejectButton: '拒绝',
    privacyHeading: '隐私',
    privacyBody: '页面文字是不可信数据。模型只接收有界语义控件；raw DOM、输入值、截图、扩展凭证与所选 provider session 只保存在私有本地证据包中。',
    settingsButton: '设置',
    pairingRequested: (id: string) => `已请求配对 · ${id}`,
    paired: '已配对',
    pairingExpiredOrRevoked: '配对已过期或撤销',
    pairingExpired: '配对已过期',
    credentialNeedsPairing: '凭证需要重新配对',
    routeValue: (provider: string, profileId: string) => `路由：${provider} · ${profileId}`,
    pairFirst: '请先配对扩展',
    noSupportedControls: '没有支持的可见控件',
    control: '控件',
    selected: '已选中',
    notSelected: '未选中',
    tabAttachedLocally: (count: number) => `标签页已在本地附着 · ${count} 个控件`,
    pairAndAttach: '请先配对并附着标签页',
    consentRequired: '发送页面内容或保存完整证据前需要同意',
    enterTask: '请输入任务',
    selectOneFile: '批准前请选择一个文件',
    requestFailed: '请求失败',
    errorSuffix: '请检查当前页面或连接。',
    actionLabels: {
      input: '文本填写',
      click: '按钮点击',
      submit: '表单提交',
      radio: '单选项选择',
      upload: '文件上传',
      navigate: '页面导航',
    },
    stateLabels: {
      discovering_tools: '正在准备页面工具',
      submitting_provider: '正在等待 Harness Task Model',
      running: 'Harness run 正在运行',
      waiting_for_approval: '正在等待操作批准',
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
    },
    proposedText: (text: string) => `拟填文本：${text}`,
    destination: (url: string) => `目标地址：${url}`,
    selectFileBelow: '请在下方选择一个本地文件。',
    originDisclosure: (origin: string) => `Origin：${origin}。同意后有界页面内容会经批准的 provider route 发送；完整证据只保留在本机私有证据包。`,
  },
} as const satisfies Record<Language, unknown>

type Strings = typeof STRINGS.en
export type StringKey = { [K in keyof Strings]: Strings[K] extends string ? K : never }[keyof Strings]

export async function getLanguage(): Promise<Language> {
  const stored = await chrome.storage.local.get<{ language?: string }>([STORAGE_KEY])
  return LANGUAGES.includes(stored.language as Language) ? (stored.language as Language) : DEFAULT_LANGUAGE
}

export async function setLanguage(language: Language): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: language })
}

export function t(language: Language, key: StringKey): string {
  return STRINGS[language][key] as string
}

export function actionLabel(language: Language, action: keyof Strings['actionLabels']): string {
  return STRINGS[language].actionLabels[action]
}

export function stateLabel(language: Language, state: string): string {
  const labels: Record<string, string> = STRINGS[language].stateLabels
  return labels[state] ?? state
}

export function proposedText(language: Language, text: string): string { return STRINGS[language].proposedText(text) }
export function destination(language: Language, url: string): string { return STRINGS[language].destination(url) }
export function originDisclosure(language: Language, origin: string): string { return STRINGS[language].originDisclosure(origin) }
export function routeValue(language: Language, provider: string, profileId: string): string { return STRINGS[language].routeValue(provider, profileId) }
export function pairingRequested(language: Language, id: string): string { return STRINGS[language].pairingRequested(id) }
export function tabAttachedLocally(language: Language, count: number): string { return STRINGS[language].tabAttachedLocally(count) }
