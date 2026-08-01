export const TOKENLESS_LANGUAGES = Object.freeze(['en', 'zh-CN'] as const)

export type TokenlessLanguage = (typeof TOKENLESS_LANGUAGES)[number]

let activeLanguage: TokenlessLanguage = 'en'

export function normalizeTokenlessLanguage(value: unknown): TokenlessLanguage | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replace(/_/g, '-').toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en'
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  return null
}

export function detectSystemLanguage({
  env = process.env,
  locale,
}: {
  env?: NodeJS.ProcessEnv
  locale?: string | undefined
} = {}): TokenlessLanguage {
  const candidate = env.LC_ALL ||
    env.LC_MESSAGES ||
    env.LANG ||
    locale ||
    Intl.DateTimeFormat().resolvedOptions().locale
  return normalizeTokenlessLanguage(candidate.split('.')[0]) ?? 'en'
}

export function setActiveLanguage(language: TokenlessLanguage) {
  activeLanguage = language
}

export function activeTokenlessLanguage() {
  return activeLanguage
}

const ZH_TEXT = new Map<string, string>([
  ['Tokenless setup', 'Tokenless 设置'],
  ['Tokenless upgrade', 'Tokenless 升级'],
  ['Reading config', '读取配置'],
  ['Checking npm version', '检查 npm 版本'],
  ['Finding browsers', '查找浏览器'],
  ['Saving preferences', '保存偏好设置'],
  ['Upserting global Tokenless agent skills', '更新全局 Tokenless agent skills'],
  ['Reconciling current Tokenless daemon', '协调当前 Tokenless daemon'],
  ['Updating global CLI', '更新全局 CLI'],
  ['Verifying installed CLI', '验证已安装的 CLI'],
  ['Refreshing agent skills', '刷新 agent skills'],
  ['Updating local runtime', '更新本地 runtime'],
  ['Running doctor', '运行 doctor'],
  ['Provider sign-in', 'Provider 登录状态'],
  ['Managed browser profile', '托管浏览器 profile'],
  ['Choose a managed profile', '选择一个托管 profile'],
  ['Create a new managed profile', '创建新的托管 profile'],
  ['Profile name', 'Profile 名称'],
  ['Choose a browser', '选择浏览器'],
  ['Choose the browser Tokenless should use.', '选择 Tokenless 要使用的浏览器。'],
  ['Keeps sign-ins between jobs. Imports copy selected provider cookies only; other browser data is excluded.', '在不同 job 之间保留登录状态。导入时只复制所选 provider 的 cookie，不包含其他浏览器数据。'],
  ['Checks visible sign-in state without submitting a prompt.', '检查可见的登录状态，不会提交 prompt。'],
  ['Setup selection must be one of the displayed numbers.', '设置选项必须是界面显示的编号之一。'],
  ['Usage', '用法'],
  ['Advanced Usage', '高级用法'],
  ['Canonical commands for everyday workflows.', '日常工作流的常用命令。'],
  ['Less common commands for detailed control and maintenance.', '用于精细控制和维护的进阶命令。'],
  ['Run', '运行'],
  ['Setup', '设置'],
  ['Profile', 'Profile'],
  ['Provider', 'Provider'],
  ['Other', '其他'],
  ['Send work through a visible AI provider.', '通过可见的 AI provider 执行任务。'],
  ['Get Tokenless ready for first use.', '完成 Tokenless 的首次使用设置。'],
  ['Manage browser profiles and their sign-in sessions.', '管理浏览器 profile 及其登录 session。'],
  ['Manage AI providers and their visible controls.', '管理 AI provider 及其可见控件。'],
  ['Use miscellaneous maintenance and help commands.', '使用其他维护和帮助命令。'],
  ['Customize, inspect, resume, or cancel jobs.', '自定义、检查、恢复或取消 job。'],
  ['Automate setup, profile import, or profile re-import.', '自动执行设置、profile 导入或重新导入。'],
  ['Discover, import, reset, or remove browser profiles.', '发现、导入、重置或移除浏览器 profile。'],
  ['Use low-level actions and provider-specific controls.', '使用底层 action 和 provider 专属控件。'],
  ['Inspect or update persistent Tokenless configuration.', '检查或更新持久化的 Tokenless 配置。'],
  ['Short options:', '短选项：'],
  ['Select a managed browser profile.', '选择托管浏览器 profile。'],
  ['Select an AI provider.', '选择 AI provider。'],
  ['Command reference:', '命令参考：'],
  ['Usage:', '用法：'],
  ['Common options:', '通用选项：'],
  ['Options:', '选项：'],
  ['Valid commands:', '可用命令：'],
  ['error:', '错误：'],
  ['(none)', '（无）'],
  ['Tokenless CLI failed.', 'Tokenless CLI 执行失败。'],
  ['Invalid Tokenless language; expected en or zh-CN.', '无效的 Tokenless language；应为 en 或 zh-CN。'],
  ['User action is required; inspect the structured result for the safe resume step.', '需要用户操作；请查看结构化结果中的安全恢复步骤。'],
])

export function localizeText(value: string, language = activeLanguage): string {
  if (language === 'en') return value
  const direct = ZH_TEXT.get(value)
  if (direct) return direct

  return value
    .replace(/^Unknown Tokenless command: (.+)\.$/, '未知的 Tokenless 命令：$1。')
    .replace(/^Unknown Tokenless argument: (.+)$/, '未知的 Tokenless 参数：$1')
    .replace(/^(tokenless(?: [\w-]+)*) does not accept options?: (.+)\.$/, '$1 不接受选项：$2。')
    .replace(/^(\S+) requires a value\.$/, '$1 需要一个值。')
    .replace(/^(\S+) is required\.$/, '必须提供 $1。')
    .replace(/^Provider must be one of: (.+)\.$/, 'Provider 必须是以下值之一：$1。')
    .replace(/^Browser must be one of: (.+)\.$/, 'Browser 必须是以下值之一：$1。')
    .replace(/^Using (.+)\.$/, '正在使用 $1。')
    .replace(/^Checking providers: (.+)\.$/, '正在检查 provider：$1。')
    .replace(/^Checking (.+) sign-in$/, '检查 $1 登录状态')
    .replace(/^Choose the (.+) profile to import$/, '选择要导入的 $1 profile')
    .replace(/^Choose \[(.+)\]: $/, '请选择 [$1]：')
    .replace(/^(.+) is authenticated \((.+)\)\.$/, '$1 已通过身份验证（$2）。')
    .replace(/^(.+) sign-in status: (.+); access: (.+)\.$/, '$1 登录状态：$2；访问级别：$3。')
    .replace(/^(.+) readiness failed: (.+)\.$/, '$1 就绪检查失败：$2。')
    .replace(/^Opened managed profile '(.+)' in a headed browser\.$/, "已在 headed 浏览器中打开托管 profile '$1'。")
    .replace(/^Cleared managed profile '(.+)'\.$/, "已清除托管 profile '$1'。")
    .replace(/^Cleared (\d+) managed profiles\.$/, '已清除 $1 个托管 profile。')
    .replace(/^No managed profiles to clear\.$/, '没有可清除的托管 profile。')
    .replace(/^Could not check npm latest tokenless version: (.+)\.$/, '无法检查 npm 上最新的 tokenless 版本：$1。')
    .replace(/^tokenless (.+) is available on npm; local CLI is (.+)\.$/, 'npm 上已有 tokenless $1；本地 CLI 为 $2。')
    .replace(/^tokenless (.+) is up to date with npm\.$/, 'tokenless $1 已与 npm 最新版本一致。')
    .replace(/^Re-import (.+) from (.+)\? This replaces its managed browser data\.$/, '是否从 $2 重新导入 $1？这会替换其托管浏览器数据。')
    .replace(/^Re-importing (.+) into managed profile (.+)$/, '正在将 $1 重新导入托管 profile $2')
    .replace(/^Setting managed profile (.+) as default$/, '正在将托管 profile $1 设为默认值')
    .replace(/^Import an existing (.+) profile into Tokenless\?$/, '是否将现有的 $1 profile 导入 Tokenless？')
    .replace(/^Creating managed profile (.+) for import$/, '正在创建用于导入的托管 profile $1')
    .replace(/^Creating clean managed profile (.+)$/, '正在创建干净的托管 profile $1')
    .replace(/^Importing (.+) into managed profile (.+)$/, '正在将 $1 导入托管 profile $2')
    .replace(/ — imported$/, ' — 已导入')
    .replace(/ — clean$/, ' — 干净')
    .replace(/ — default$/, ' — 默认')
    .replace(/^Setup found technical failures for (\d+) provider\(s\) in profile (.+)\.$/, '设置在 profile $2 中发现 $1 个 provider 存在技术故障。')
    .replace(/^Setup checked provider sign-in status once for profile (.+)\.$/, '设置已为 profile $1 检查一次 provider 登录状态。')
    .replace(/^Tokenless setup checked (.+) once in profile (.+)\. Provider summary: (.+)\. Counts: authenticated (\d+), unauthenticated (\d+), unknown (\d+), failed (\d+)\.$/, 'Tokenless 设置已在 profile $2 中检查一次 $1。Provider 汇总：$3。数量：authenticated $4、unauthenticated $5、unknown $6、failed $7。')
    .replace(/^CLI: tokenless (.+); npm latest check unavailable \((.+), non-blocking\)\.$/, 'CLI：tokenless $1；无法检查 npm 最新版本（$2，不阻塞）。')
    .replace(/^CLI: tokenless (.+); npm latest (.+) is available\.$/, 'CLI：tokenless $1；npm 上已有最新版本 $2。')
    .replace(/^CLI: tokenless (.+); npm latest (.+) is up to date\.$/, 'CLI：tokenless $1；已是 npm 最新版本 $2。')
    .replace(/^Daemon: ready on tokenless (.+) \(exact package version required\)\.$/, 'Daemon：已就绪，tokenless $1（要求 package 版本完全一致）。')
    .replace(/^Tokenless (.+) is up to date\. Skills and local runtime are current; doctor is healthy\.$/, 'Tokenless $1 已是最新版本。Skills 和本地 runtime 均为最新；doctor 状态健康。')
    .replace(/^Tokenless upgraded from (.+) to (.+)\. Skills and local runtime are current; doctor is healthy\.$/, 'Tokenless 已从 $1 升级到 $2。Skills 和本地 runtime 均为最新；doctor 状态健康。')
    .replace(/^Tokenless upgrade did not complete\. Rerun tokenless upgrade for a full diagnostic\.$/, 'Tokenless 升级未完成。请重新运行 tokenless upgrade 获取完整诊断。')
    .replace(/^Tokenless upgrade stopped at (.+)\. Resolve that failure, then rerun tokenless upgrade\.$/, 'Tokenless 升级在 $1 停止。解决该故障后，请重新运行 tokenless upgrade。')
}
