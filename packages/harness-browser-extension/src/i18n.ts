export type Language = 'en' | 'zh'

export const LANGUAGES: Language[] = ['en', 'zh']
const DEFAULT_LANGUAGE: Language = 'en'
const STORAGE_KEY = 'language'

const STRINGS = {
  en: {
    docTitle: 'Tokenless Harness',
    settingsHeading: 'Settings',
    settingsSubheading: 'Keep the side panel focused on the page in front of you.',
    languageHeading: 'Language',
    languageHelp: 'Choose the language used by the extension.',
    languageLabel: 'Interface language',
    connectionHeading: 'Connection',
    connectionHelp: 'Pair once to run page tasks through your selected Tokenless API route.',
    notPaired: 'Not connected',
    daemonLabel: 'Daemon origin',
    routeDefault: 'Route selected in Dashboard',
    pairButton: 'Pair in Dashboard',
    unpairButton: 'Unpair',
    refreshButton: 'Refresh',
    pairingHelp: 'The credential is extension-scoped and revocable. It cannot control the daemon.',
    eyebrow: 'TOKENLESS HARNESS',
    appHeading: 'What should I do on this page?',
    welcomeBody: 'Describe a task. Tokenless Harness will use only the controls it can see and ask before it changes anything.',
    noTabAttached: 'No page context yet',
    untitled: 'Untitled page',
    attachButton: 'Refresh page context',
    taskLabel: 'Task for Tokenless Harness',
    taskPlaceholder: 'Ask Tokenless Harness to fill, click, submit, or navigate…',
    startRunButton: 'Send',
    cancelButton: 'Stop',
    noRun: 'Ready when you are',
    permissionHeading: 'Allow access to this page?',
    permissionBody: 'Tokenless Harness needs the visible page controls to carry out this task. Only a bounded semantic snapshot leaves the extension; full evidence stays private on this device.',
    allowAccessButton: 'Allow and continue',
    notNowButton: 'Not now',
    privacyHeading: 'Page access',
    privacyBody: 'The page is untrusted data. Tokenless Harness receives bounded semantic controls only after you allow access. Raw DOM, entered values, screenshots, the extension credential, and the selected provider session stay in the private local evidence bundle.',
    permissionSummary: 'Page content leaves the extension only after you allow access for the current task.',
    approvalSummary: 'Every proposed page mutation still needs its own approval.',
    evidenceSummary: 'Full local evidence remains on this device with owner-only permissions.',
    approvalHeading: 'Approval required',
    uploadLabelText: 'File selected for this approved upload',
    approveButton: 'Approve action',
    rejectButton: 'Reject',
    settingsButton: 'Settings',
    pairingRequested: (id: string) => `Pairing requested · ${id}`,
    paired: 'Connected',
    pairingExpiredOrRevoked: 'Pairing expired or revoked',
    pairingExpired: 'Pairing expired',
    credentialNeedsPairing: 'Reconnect required',
    routeValue: (provider: string, profileId: string) => `Route: ${provider} · ${profileId}`,
    pairFirst: 'Connect Tokenless API in Settings to start',
    tabAttachedLocally: (count: number) => count === 0 ? 'Page ready · no supported controls found' : `Page ready · ${count} control(s) visible`,
    consentRequired: 'Allow page access to continue',
    enterTask: 'Enter a task first',
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
      waiting_for_approval: 'Waiting for your approval',
      succeeded: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
    },
    proposedText: (text: string) => `Proposed text: ${text}`,
    destination: (url: string) => `Destination: ${url}`,
    selectFileBelow: 'Select one local file below.',
  },
  zh: {
    docTitle: 'Tokenless Harness',
    settingsHeading: '设置',
    settingsSubheading: '让 side panel 只专注于当前页面的任务。',
    languageHeading: '语言',
    languageHelp: '选择 extension 使用的语言。',
    languageLabel: '界面语言',
    connectionHeading: '连接',
    connectionHelp: '完成一次配对后，就可以通过选定的 Tokenless API route 执行页面任务。',
    notPaired: '未连接',
    daemonLabel: 'Daemon origin',
    routeDefault: 'Route 在 Dashboard 中选择',
    pairButton: '在 Dashboard 配对',
    unpairButton: '解除配对',
    refreshButton: '刷新',
    pairingHelp: '凭证只属于本 extension 且可撤销，不能控制 daemon。',
    eyebrow: 'TOKENLESS HARNESS',
    appHeading: '要在这个页面上做什么？',
    welcomeBody: '描述一个任务。Tokenless Harness 只使用它能看到的控件，并在修改前请求批准。',
    noTabAttached: '尚未准备页面上下文',
    untitled: '无标题页面',
    attachButton: '刷新页面上下文',
    taskLabel: '给 Tokenless Harness 的任务',
    taskPlaceholder: '让 Tokenless Harness 填写、点击、提交或打开页面……',
    startRunButton: '发送',
    cancelButton: '停止',
    noRun: '准备就绪',
    permissionHeading: '允许访问此页面？',
    permissionBody: 'Tokenless Harness 需要读取当前页面可见的控件来完成任务。离开 extension 的只有有界语义快照；完整证据只私密保存在本机。',
    allowAccessButton: '允许并继续',
    notNowButton: '暂不',
    privacyHeading: '页面访问',
    privacyBody: '页面是不可信数据。只有在你允许后，Tokenless Harness 才会收到有界语义控件；raw DOM、输入值、截图、extension credential 与所选 provider session 只保存在本机私有证据包中。',
    permissionSummary: '只有在你允许当前任务访问后，页面内容才会离开 extension。',
    approvalSummary: '每个拟执行的页面修改仍然需要单独批准。',
    evidenceSummary: '完整本地证据留在本机，并使用仅 owner 可读权限。',
    approvalHeading: '需要批准',
    uploadLabelText: '为本次批准的上传选择文件',
    approveButton: '批准操作',
    rejectButton: '拒绝',
    settingsButton: '设置',
    pairingRequested: (id: string) => `已请求配对 · ${id}`,
    paired: '已连接',
    pairingExpiredOrRevoked: '配对已过期或撤销',
    pairingExpired: '配对已过期',
    credentialNeedsPairing: '需要重新连接',
    routeValue: (provider: string, profileId: string) => `路由：${provider} · ${profileId}`,
    pairFirst: '请先在设置中连接 Tokenless API',
    tabAttachedLocally: (count: number) => count === 0 ? '页面已准备 · 没有找到支持的控件' : `页面已准备 · 可见控件 ${count} 个`,
    consentRequired: '允许页面访问后继续',
    enterTask: '请先输入任务',
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
      waiting_for_approval: '等待你的批准',
      succeeded: '已完成',
      failed: '失败',
      cancelled: '已取消',
    },
    proposedText: (text: string) => `拟填文本：${text}`,
    destination: (url: string) => `目标地址：${url}`,
    selectFileBelow: '请在下方选择一个本地文件。',
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
export function routeValue(language: Language, provider: string, profileId: string): string { return STRINGS[language].routeValue(provider, profileId) }
export function pairingRequested(language: Language, id: string): string { return STRINGS[language].pairingRequested(id) }
export function tabAttachedLocally(language: Language, count: number): string { return STRINGS[language].tabAttachedLocally(count) }
