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
  ['Finding Google Chrome and Brave profiles', '查找 Google Chrome 和 Brave profiles'],
  ['Saving preferences', '保存偏好设置'],
  ['Installing Tokenless Codex integration', '安装 Tokenless Codex 集成'],
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
  ['Anti-Detect mode', 'Anti-Detect 反爬模式'],
  ['Preparing automatic browser selection', '准备自动 browser selection'],
  ['Preparing Tokenless-managed Chrome for Testing', '准备由 Tokenless 管理的 Chrome for Testing'],
  ['Preparing CloakBrowser', '准备 CloakBrowser'],
  ['At least one browser runtime selection is required.', '至少需要选择一个 browser runtime。'],
  ['Browser runtime repair requires an explicit managed-chromium or cloak selection.', 'Browser runtime repair 需要显式选择 managed-chromium 或 cloak。'],
  ['--repair-browser cannot be combined with --no-browser-download.', '--repair-browser 不能与 --no-browser-download 同时使用。'],
  ['Browser must be auto, chrome, chrome-for-testing, chromium, edge, managed-chromium, or cloak.', 'Browser 必须是 auto、chrome、chrome-for-testing、chromium、edge、managed-chromium 或 cloak。'],
  ['Invalid Tokenless browser; expected auto, a supported system browser, managed-chromium, or cloak.', '无效的 Tokenless browser；应为 auto、受支持的 system browser、managed-chromium 或 cloak。'],
  ['Invalid Tokenless browser executable path; expected null or an absolute path.', '无效的 Tokenless browser executable path；应为 null 或绝对路径。'],
  ['Browser executable path must be absolute.', 'Browser executable path 必须是绝对路径。'],
  ['Use Anti-Detect mode? Tokenless will download and install the verified, platform-pinned CloakBrowser if needed.', '是否使用 Anti-Detect 模式？如有需要，Tokenless 将下载并安装经过验证、按平台固定版本的 CloakBrowser。'],
  ['Start clean', '从 clean profile 开始'],
  ['Non-interactive CloakBrowser setup requires explicit --anti-detect or --browser cloak confirmation.', '非交互 CloakBrowser setup 必须通过显式的 --anti-detect 或 --browser cloak 进行确认。'],
  ['--browser-user-data-dir requires one explicit browser instead of all.', '--browser-user-data-dir 必须指定一个具体浏览器，不能使用 all。'],
  ['Browser profile discovery supports all, Chrome, Brave, Edge, Chromium, or Chrome for Testing.', 'Browser profile discovery 支持 all、Chrome、Brave、Edge、Chromium 或 Chrome for Testing。'],
  ['Checks visible sign-in state without submitting a prompt.', '检查可见的登录状态，不会提交 prompt。'],
  ['Supported providers (all are enabled by default):', '支持的 provider（默认全部启用）：'],
  ['Reply with the provider numbers to remove, separated by commas. Press Enter to keep all: ', '请输入要移除的 provider 编号，多个编号用逗号分隔。直接回车保留全部：'],
  ['Provider removal selection must contain only the displayed numbers.', '移除 provider 时只能输入界面显示的编号。'],
  ['Tokenless setup requires at least one supported visible provider.', 'Tokenless setup 至少需要一个受支持且可见的 provider。'],
  ['Setup selection must be one of the displayed numbers.', '设置选项必须是界面显示的编号之一。'],
  ['Usage', '用法'],
  ['Advanced Usage', '高级用法'],
  ['Canonical commands for everyday workflows.', '日常工作流的常用命令。'],
  ['Automate managed browser runtime and profile setup.', '自动完成 managed browser runtime 和 profile 设置。'],
  ['Discover metadata or manage browser profiles.', '发现元数据或管理 browser profiles。'],
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
  ['Automate browser runtime and clean-profile setup.', '自动设置 browser runtime 与 clean profile。'],
  ['Discover metadata or manage clean browser profiles.', '发现 browser 元数据或管理 clean profile。'],
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
  ['Details:', '详情：'],
  ['Completed', '已完成'],
  ['Failed', '失败'],
  ['Waiting for user', '等待用户'],
  ['Resume:', '恢复：'],
  ['Show live status and diagnostic details.', '显示实时状态和诊断详情。'],
  ['error:', '错误：'],
  ['(none)', '（无）'],
  ['Tokenless CLI failed.', 'Tokenless CLI 执行失败。'],
  ['Tokenless agent integration currently supports codex.', 'Tokenless agent integration 当前只支持 codex。'],
  ['Usage: tokenless agents <install|status|inspect|uninstall> codex.', '用法：tokenless agents <install|status|inspect|uninstall> codex。'],
  ['Restart Codex, open /hooks, and trust the Tokenless hook definition before expecting automatic chat and turn binding.', '请重启 Codex，打开 /hooks，并信任 Tokenless hook definition，之后才能使用自动 chat/turn 绑定。'],
  ['Tokenless is installed for normal Codex sessions. Restart Codex and trust the Tokenless hooks in /hooks.', 'Tokenless 已安装到普通 Codex sessions。请重启 Codex，并在 /hooks 中信任 Tokenless hooks。'],
  ['Codex integration was not installed; add --install-codex to opt in.', '未安装 Codex 集成；如需启用，请添加 --install-codex。'],
  ['To install the optional Codex integration, rerun setup with --install-codex.', '如需安装可选的 Codex 集成，请使用 --install-codex 重新运行 setup。'],
  ['--codex-home requires --install-codex during setup.', 'setup 中使用 --codex-home 时必须同时提供 --install-codex。'],
  ['Tokenless Codex guidance and hook handlers were removed without changing other Codex instructions or hooks.', 'Tokenless Codex guidance 和 hook handlers 已移除；其他 Codex instructions 与 hooks 未被修改。'],
  ['--task-id cannot replace the conversation identity supplied by the Tokenless Codex hook.', '--task-id 不能替换 Tokenless Codex hook 提供的 conversation identity。'],
  ['Invalid Tokenless language; expected en or zh-CN.', '无效的 Tokenless language；应为 en 或 zh-CN。'],
  ['Proxy configuration requires --profile <slug>.', 'Proxy 配置必须提供 --profile <slug>。'],
  ['--profile can scope only provider membership, browser visibility, and proxy settings.', '--profile 只能限定 provider membership、browser visibility 和 proxy 设置。'],
  ['--clear-proxy cannot be combined with --proxy-server or --proxy-bypass.', '--clear-proxy 不能与 --proxy-server 或 --proxy-bypass 同时使用。'],
  ['--browser-executable-path cannot be combined with --clear-browser-executable-path.', '--browser-executable-path 不能与 --clear-browser-executable-path 同时使用。'],
  ['--browser-executable-path requires an explicit system browser selection.', '--browser-executable-path 必须先明确选择 system browser。'],
  ['--browser-executable-path must be an absolute path.', '--browser-executable-path 必须是绝对路径。'],
  ['--proxy-bypass requires an existing proxy or --proxy-server.', '--proxy-bypass 需要已有 proxy 或同时提供 --proxy-server。'],
  ['Proxy must use HTTP, HTTPS, or SOCKS5 without embedded credentials.', 'Proxy 必须使用 HTTP、HTTPS 或 SOCKS5，且不能嵌入凭据。'],
  ['Your help is needed: complete provider sign-in or verification in the visible browser. Tokenless will preserve this job and continue afterward.', '需要你的协助：请在可见浏览器中完成 provider 登录或验证。Tokenless 会保留当前 job，完成后继续。'],
  ['Your help is needed, but no browser window is open. Resume this same job in headed mode; do not create a replacement job.', '需要你的协助，但当前没有打开浏览器窗口。请以 headed mode 恢复同一个 job，不要创建替代 job。'],
  ['After completing sign-in or verification, query this same job or task; Tokenless will continue from its saved checkpoint.', '完成登录或验证后，请查询同一个 job 或 task；Tokenless 会从已保存的 checkpoint 继续。'],
  ['The managed Chrome for Testing browser did not exit after shutdown.', '托管 Chrome for Testing browser 在关闭后仍未退出。'],
  ['Too many managed browser profiles are active; existing profile browsers remain open.', '当前 active 的托管 browser profiles 过多；已有 profile browsers 会保持打开。'],
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
    .replace(/^Hook-bound Tokenless context is missing (.+)\.$/, 'Hook-bound Tokenless context 缺少 $1。')
    .replace(/^(--\S+) cannot replace identity supplied by the Tokenless Codex hook\.$/, '$1 不能替换 Tokenless Codex hook 提供的 identity。')
    .replace(/^Provider must be one of: (.+)\.$/, 'Provider 必须是以下值之一：$1。')
    .replace(/^Provider capacity for (.+) \/ (.+): (.+)\.$/, 'Provider $1 / profile $2 的容量：$3。')
    .replace(/^Browser must be one of: (.+)\.$/, 'Browser 必须是以下值之一：$1。')
    .replace(/^Browser must be auto, a supported system browser, managed-chromium, or cloak\.$/, 'Browser 必须是 auto、受支持的 system browser、managed-chromium 或 cloak。')
    .replace(/^Automatic — (.+)$/, '自动 — $1')
    .replace(/^Enable (.+) for this profile\?$/, '为此 profile 启用 $1？')
    .replace(/^CloakBrowser project: (.+)$/, 'CloakBrowser 项目：$1')
    .replace(/^Supported CloakBrowser on this platform: artifact (.+) \(Chromium (.+)\)\.$/, '当前平台支持的 CloakBrowser：artifact $1（Chromium $2）。')
    .replace(/^Supported (.+) on this platform: artifact (.+) \(Chromium (.+)\)\.$/, '当前平台支持的 $1：artifact $2（Chromium $3）。')
    .replace(/^Choose how (.+) should initialize its managed profile$/, '选择 $1 managed profile 的初始化方式')
    .replace(/^No compatible local Google Chrome or Brave profile was found; (.+) will use a clean profile\.$/, '未找到兼容的本地 Google Chrome 或 Brave profile；$1 将使用 clean profile。')
    .replace(/^Copy (.+) profile (.+) — version (.+) — (.+)$/, '复制 $1 profile $2 — 版本 $3 — $4')
    .replace(/^(.+) profile (.+) at (.+): version (.+); version-aligned \(eligible for import\)\.$/, '$1 profile $2（$3）：版本 $4；版本匹配（可导入）。')
    .replace(/^(.+) profile (.+) at (.+): version (.+); not version-aligned\.$/, '$1 profile $2（$3）：版本 $4；版本不匹配。')
    .replace(/^(.+) profile (.+) at (.+): version (.+); not supported on this platform\.$/, '$1 profile $2（$3）：版本 $4；当前平台不支持。')
    .replace(/^(.+) profile (.+) at (.+): version (.+); browser not supported\.$/, '$1 profile $2（$3）：版本 $4；不支持此来源浏览器。')
    .replace(/^(.+) profile (.+) at (.+): version (.+); target not supported\.$/, '$1 profile $2（$3）：版本 $4；不支持此 target。')
    .replace(/^(.+) profile (.+) at (.+): version (.+); version unknown\.$/, '$1 profile $2（$3）：版本 $4；版本未知。')
    .replace(/^Opening (.+) review tab$/, '打开 $1 审核 tab')
    .replace(/^Opened (\d+) provider review tab\(s\)\.$/, '已打开 $1 个 provider 审核 tab。')
    .replace(/^Could not open (\d+) provider review tab\(s\)\.$/, '无法打开 $1 个 provider 审核 tab。')
    .replace(/^Could not keep the provider review browser open\.$/, '无法让 provider 审核浏览器保持打开。')
    .replace(/^Setup could not open (\d+) provider review tab\(s\) in profile (.+)\.$/, '设置无法在 profile $2 中打开 $1 个 provider 审核 tab。')
    .replace(/^Setup could not keep provider review tabs open in profile (.+)\.$/, '设置无法让 profile $1 的 provider 审核 tab 保持打开。')
    .replace(/^Opened the Tokenless dashboard in managed profile '(.+)'.$/, '已在托管 profile「$1」中打开 Tokenless 控制台。')
    .replace(/^Dashboard ready for managed profile '(.+)': (.+)$/, '托管 profile「$1」的控制台已就绪：$2')
    .replace(/ — installed system browser$/, ' — 已安装的 system browser')
    .replace(/ — official download required$/, ' — 需要从官方来源下载')
    .replace(/ — download required$/, ' — 需要下载')
    .replace(/ — cached$/, ' — 已缓存')
    .replace(/^(.+) (\S+): download\.$/, '$1 $2：下载。')
    .replace(/^(.+) (\S+): verify\.$/, '$1 $2：校验。')
    .replace(/^(.+) (\S+): extract\.$/, '$1 $2：解包。')
    .replace(/^(.+) (\S+): version\.$/, '$1 $2：检查版本。')
    .replace(/^(.+) (\S+): smoke-launch\.$/, '$1 $2：执行 smoke launch。')
    .replace(/^(.+) (\S+): install\.$/, '$1 $2：安装。')
    .replace(/^(.+) (\S+) is not installed\. Run tokenless setup with browser downloads enabled\.$/, '$1 $2 尚未安装。请启用 browser download 后重新运行 tokenless setup。')
    .replace(/^Browser executable for '(.+)' was not found\. Set it with tokenless config --browser (.+) --browser-executable-path "\/absolute\/path\/to\/browser" --json, or open tokenless dashboard and update System > Browser executable path\.$/, "找不到 '$1' 的浏览器 executable。请运行 tokenless config --browser $2 --browser-executable-path \"/浏览器的绝对路径\" --json，或打开 tokenless dashboard，在 System > Browser executable path 中设置。")
    .replace(/^Managed profile '(.+)' cannot use (.+); create a clean profile for that browser runtime\.$/, "Managed profile '$1' 不能使用 $2；请为该 browser runtime 创建 clean profile。")
    .replace(/^Unsupported Tokenless browser platform: (.+)\. Supported platforms are darwin-arm64 and win32-x64\.$/, 'Tokenless 不支持 browser platform：$1。支持 darwin-arm64 和 win32-x64。')
    .replace(/^Managed profile '(.+)' predates browser runtime binding\. Rerun tokenless setup and explicitly select a compatible browser\.$/, "Managed profile '$1' 尚未记录 browser runtime binding。请重新运行 tokenless setup 并显式选择兼容的 browser。")
    .replace(/^Managed profile '(.+)' is bound to (.+), but Tokenless resolved (.+)\.$/, "Managed profile '$1' 绑定到 $2，但 Tokenless 解析出 $3。")
    .replace(/^Managed profile '(.+)' was created with browser (.+); refusing to open it with older browser (.+)\.$/, "Managed profile '$1' 由 browser $2 创建；拒绝使用更旧的 browser $3 打开。")
    .replace(/^Managed profile '(.+)' is already bound to (.+); create a clean profile for (.+)\.$/, "Managed profile '$1' 已绑定到 $2；请为 $3 创建 clean profile。")
    .replace(/^(.+) download checksum mismatch; refusing to extract the artifact\.$/, '$1 下载文件的 checksum 不匹配；已拒绝解包。')
    .replace(/^(.+) reported browser (.+); expected (.+)\.$/, '$1 报告 browser $2；预期为 $3。')
    .replace(/^(.+) cache reported browser (.+); expected (.+)\.$/, '$1 cache 报告 browser $2；预期为 $3。')
    .replace(/^Cannot install (.+) (.+)\.$/, '无法安装 $1 $2。')
    .replace(/^Browser download failed with HTTP (.+)\.$/, 'Browser 下载失败，HTTP 状态为 $1。')
    .replace(/^Browser download failed\.$/, 'Browser 下载失败。')
    .replace(/^Browser download was aborted\.$/, 'Browser 下载已中止。')
    .replace(/^Browser archive is empty\.$/, 'Browser archive 为空。')
    .replace(/^Browser archive contains an unsafe path: (.+)$/, 'Browser archive 包含不安全路径：$1')
    .replace(/^Browser smoke launch timed out\.$/, 'Browser smoke launch 超时。')
    .replace(/^Browser smoke launch failed\.$/, 'Browser smoke launch 失败。')
    .replace(/^Using (.+)\.$/, '正在使用 $1。')
    .replace(/^Checking providers: (.+)\.$/, '正在检查 provider：$1。')
    .replace(/^Checking (.+) sign-in$/, '检查 $1 登录状态')
    .replace(/^Choose the (.+) profile to import$/, '选择要导入的 $1 profile')
    .replace(/^Chose \[(.+)\]: $/, '已选择 [$1]：')
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
    .replace(/^Daemon: ready on tokenless (.+) \/ control API r(.+) \(exact match required\)\.$/, 'Daemon：已就绪，tokenless $1 / control API r$2（要求完全一致）。')
    .replace(/^Tokenless (.+) is up to date\. Skills and local runtime are current; doctor is healthy\.$/, 'Tokenless $1 已是最新版本。Skills 和本地 runtime 均为最新；doctor 状态健康。')
    .replace(/^Tokenless upgraded from (.+) to (.+)\. Skills and local runtime are current; doctor is healthy\.$/, 'Tokenless 已从 $1 升级到 $2。Skills 和本地 runtime 均为最新；doctor 状态健康。')
    .replace(/^Tokenless upgrade did not complete\. Rerun tokenless upgrade for a full diagnostic\.$/, 'Tokenless 升级未完成。请重新运行 tokenless upgrade 获取完整诊断。')
    .replace(/^Tokenless upgrade stopped at (.+)\. Resolve that failure, then rerun tokenless upgrade\.$/, 'Tokenless 升级在 $1 停止。解决该故障后，请重新运行 tokenless upgrade。')
}
