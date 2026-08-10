# tokenless

## 0.5.0

### Minor Changes

- f89070a: Add an opt-in Codex integration with reversible global guidance, native lifecycle hooks, exact project/chat/turn/tool-call binding, App Server enrichment, and durable provider conversation continuity.
- 1347720: Enable output savings measurement by default, durably process first-response tokenization after provider completion in an isolated child process, and keep a prominent savings summary on the dashboard with a clear disabled state.
- e840aee: Add Dola as an experimental managed-browser provider with signed-in chat, Fast/Pro selection, file input, image/writing/video/translation/homework capability candidates, navigation, sanitized-DOM capture, and real-provider release gates.

  新增实验性 Dola managed-browser provider，覆盖登录态 chat、Fast/Pro、file input、图片/写作/视频/翻译/作业能力候选、navigation、sanitized DOM capture 与真实 provider release gates。

- 3eb3f73: Add native Google Chrome and Brave selection after the Anti-Detect setup choice, support a verified user-supplied executable path, attach through the selected browser's managed CDP endpoint, and retire browser-profile import compatibility checks. Missing native browsers now produce an end-of-setup action warning; the first browser action validates the configured path or standard installation before use.
- 6075a7f: Replace managed browser profile imports with headed native connections to the user's running Google Chrome 144+ instance. After the user enables Remote Debugging, Chrome manages the CDP endpoint and Tokenless discovers it without a fixed-port setting. Tokenless checks support by connecting, manages only its own tabs, and disconnects without closing Chrome when the daemon stops.
- e0c7f3c: Store complete per-profile provider configuration in `config.json` under `profiles`, migrate the legacy side table with the registered profiles, and expose profile configuration directly in CLI and dashboard payloads.
- 15ebb8c: Separate provider-native workflows from canonical capabilities, remove `skill.invoke`, and deliver caller-selected Harness Skills through the standard chat and file-upload route.

  将 provider-native workflow 与 canonical capability 分离，删除 `skill.invoke`，并通过标准 chat 与 file-upload route 交付 caller-selected Harness Skills。

- 1c0d2e9: Add explicit `tokenless setup --install-codex` onboarding and bind Codex CLI calls to concrete `CODEX_THREAD_ID` tasks while preserving Hook session-tree provenance and automatically reusing native provider workspaces.

### Patch Changes

- 75ad601: Consolidate managed browser control on CDP, remove the obsolete browser connection mode from configuration and UI contracts, and keep Playwright's page and locator APIs for automation. Existing configuration files must remove `browserConnectionMode`; all legacy values are rejected.
- 1bf51f9: Add checksum-pinned official CloakBrowser downloads for Intel macOS and Linux arm64/x64 while retaining the existing Apple Silicon macOS and Windows x64 pins.
- f1ea0fb: Advertise experimental DeepSeek chat and Markdown file-upload routes after a real headed managed-browser run proved three visible attachment cards, prompt submission, and response reading.

  在真实 headed managed browser 运行验证三张可见附件卡片、prompt 提交与回复读取后，公开实验性的 DeepSeek chat 和 Markdown 文件上传 routes。

- cccf099: Open the loopback local console directly without a bootstrap ticket while preserving UI CSRF and machine API bearer protections.
- dbb999c: Report configuration completeness in `tokenless doctor`, including stale or missing user-supplied Chrome and Brave executable paths.
- f1ea0fb: Update Dola's relative upload and submit controls and recognize physical Markdown attachment cards, while leaving chat and file-upload routes unadvertised because the selected profile accepted only one visible document card.

  更新 Dola 的相对 upload 与 submit controls，并识别物理可见的 Markdown 附件卡片；由于选定 profile 仅接收一张可见文档卡片，chat 与 file-upload routes 仍不公开。

- 562baed: Recognize Gemini's signed-in navigation and Z.ai's visible user menu before reporting a guest session from `auth.status`.
- a26661a: Add experimental Gemini Markdown file upload with physical attachment-card acceptance and the visible Upload & tools flow. Implement Qwen's visible Upload attachment chooser and Markdown card detector while keeping its route unadvertised because the real built-product send click had no visible transition and submission remained ambiguous.

  新增实验性的 Gemini Markdown 文件上传，通过物理附件卡片与可见 Upload & tools 流程证明接收。实现 Qwen 的可见 Upload attachment chooser 与 Markdown 卡片检测；由于真实 built-product 的发送点击没有可见转换，submission 仍存在歧义，继续不公开其 route。

- 94bf3c1: Keep hook-injected project and chat names as task identity unless Workspace handling is explicitly requested.
- 7871659: Keep managed browsers resident across jobs and daemon restarts. Dashboard provider-readiness refreshes run headlessly when the profile is idle, reuse an existing headed browser without replacing or foregrounding it, and reserve visible browser handoff for explicit user actions.

  Managed browsers 会跨 jobs 和 daemon 重启保持常驻。Dashboard 刷新 Provider 就绪状态时，会在 Profile 空闲时以 headless 方式运行；已有 headed browser 时则静默复用且不替换或带到前台，仅在用户显式操作时启动可见 handoff。

- ed476a9: Upload the Harness System Prompt and every selected Skill as independent Markdown files in one visible provider batch.
- f1ea0fb: Reconnect a managed browser that was already running before resident-browser session metadata existed, instead of trying to launch a second browser against the same profile.

  重新连接在驻留浏览器 session 元数据出现前已运行的托管浏览器，避免对同一 profile 启动第二个浏览器。

- c3a7c2d: Refresh Tokenless skills in the canonical shared directory and existing direct agent skill directories during setup and upgrade, including Codex and Claude Code.
- 913b9d0: Let production managed browsers use native credential storage so compatible copied profiles can preserve macOS Keychain-encrypted sign-in state, and document the expected Safe Storage prompt.
- f1ea0fb: Perplexity file upload remains unadvertised when the selected Free plan visibly requires an upgrade for a third document.

  当选定的 Free plan 对第三个文档显示可见升级要求时，Perplexity 文件上传继续不对外公开。

- 0290c36: Move browser opening from the global dashboard header to profile-specific controls, always open those controls in a visible managed browser, and let headed dashboard pages respond to the managed browser window size.
- 83b6352: Use profile slugs as the only profile names across the CLI and local console.
- f1ea0fb: Recognize Claude attachment filenames before concatenated card metadata and Kimi filenames with separate extension badges, while retaining count-plus-extension evidence. During the CDP-only transition, accept only the exact legacy `browserConnectionMode: 'playwright'` value and omit that retired field from normalized config.

  正确识别 Claude 附件卡片中拼接元数据前的文件名，以及 Kimi 将扩展名拆分为独立标记的成功文件卡片，同时保留数量加扩展名证据。迁移到 CDP-only 控制期间，仅接受精确的旧值 `browserConnectionMode: 'playwright'`，并从规范化配置中省略该已退役字段。

- 6148137: Keep headed provider tabs and the local dashboard open when another provider tab is closed or the dashboard is refreshed.
- 0290c36: Simplify interactive setup provider selection with an all-enabled list and numbered removals.
- 5db3fdd: Wait for Qwen attachments to finish visible parsing before prompt submission, use provider-specific interaction windows, require provider acknowledgement after one actionable submit click, and fail response reads that have no visible answer.

  在提交 prompt 前等待 Qwen 附件完成可见解析，使用 provider-specific 交互等待窗口，在唯一一次可操作提交点击后要求 provider acknowledgement，并让没有可见答案的 response read 明确失败。

- dfd367c: Add an Overview refresh control that rechecks sign-in readiness for every enabled provider in the selected managed profile.
- f129343: Stop rejecting managed profile registries based on POSIX mode bits so valid Windows profiles remain usable while Tokenless continues to create registry files with private permissions where supported.

  不再根据 POSIX mode 位拒绝托管浏览器配置注册表，避免有效的 Windows 配置被误判；Tokenless 仍会在平台支持时以私有权限创建注册表文件。

- 091258f: Persist bounded, text-free response selector diagnostics with sanitized snapshots and response reads.
- 83b6352: Stop the daemon only after background output-savings work has released the shared database, and let live release gates inspect an already-resident configured browser.

  等待后台 output-savings 工作释放共享数据库后再停止 daemon，并允许实时发布门禁检查已常驻的配置浏览器。

- 0480d5b: Dismiss blocking Z.ai announcements before prompt entry, reuse open Doubao mode menus, wait for hydrated provider choice controls, preserve mapped native Project conversations, read complete Claude responses, apply Claude Project instructions through the visible instructions dialog, and stop advertising incomplete DeepSeek and Qwen conversation, Grok and Kimi native Project, Qwen mode, and Kimi model, library, or long-running workflows.

  在输入提示词前关闭阻塞操作的 Z.ai 公告、复用已打开的豆包模式菜单、等待 provider choice 控件完成加载、保留已映射的原生 Project 对话、完整读取 Claude 回复并通过可见的说明对话框应用 Claude Project instructions，同时停止宣称未闭环的 DeepSeek、Qwen 对话、Grok、Kimi 原生 Project、Qwen mode 以及 Kimi model、library 和 long-running workflows。

- e177aef: Require a stable visible provider response before a completed run is returned.
- 35343ce: Check provider readiness in batches of up to three task-owned background tabs and close every temporary tab after observation.

  Provider 就绪检查会以最多三个一批的方式使用任务自有后台 tab，并在观察结束后关闭所有临时 tab。

- 47b7373: Wait for provider responses and managed job completion without a universal elapsed-time deadline while preserving explicit cancellation and runner shutdown. Explicit `--timeout-ms` continues to cancel the waiting job when it elapses.

  等待 provider 响应和托管任务完成时不再使用统一的耗时截止，同时保留显式取消与 runner 停止能力。显式 `--timeout-ms` 到期时仍会取消正在等待的任务。

- e0c7f3c: Use stable locale catalog keys for CLI output and local-console error summaries, with Simplified Chinese privacy guidance.
- 15ebb8c: Accept multi-file provider uploads from newly visible attachment evidence by count and file-extension multiset, even when providers rename files.

  通过新增可见附件证据的数量与文件扩展名多重集接受多文件 Provider 上传，即使 Provider 重命名文件也能正常识别。

- f08835d: Add an authenticated loopback Web AI Interaction Protocol V0 control-plane surface for configured managed provider profiles.
- 7a01fb8: Add durable cancellation fencing for local Web AI V0 request references.
- 5f5e54d: Make local Web AI bootstrap `requestRef` retries durable and conflict-safe across daemon restarts.
- f1ea0fb: Add experimental Z.ai Markdown file upload after the real headed managed-browser flow proves physical visible attachment chips.

  在真实 headed managed browser 流程验证物理可见附件卡片后，新增实验性 Z.ai Markdown 文件上传。

## 0.4.1

### Patch Changes

- b4556a9: Fix `tokenless upgrade --json` rejecting its default empty capability argument state before starting the upgrade workflow.

## 0.4.0

### Minor Changes

- f676cd6: Add experimental signed-in Kimi chat, text-file upload, Web search with citations, model and thinking-effort controls, and provider-native Plugin and Skill controls with real Cloak capability gates.
- 2986940: Add profile-bound browser runtime selection with system-first auto discovery, a locked managed Chrome for Testing fallback, explicit Anti-Detect CloakBrowser setup, safe known-Chromium profile/version inventory before Cloak download, exact four-component Cloak compatibility classification, interactive or explicit non-interactive clean-profile confirmation, clean runtime-isolated profiles, exact daemon runtime errors, transactional artifact security verification, per-provider setup review tabs, keychain-neutral E2E Cloak launches, separate doctor profile/runtime compatibility checks, and gated real-browser acceptance coverage.
- bf24d96: Cache the verified browser executable path in persistent config, resolve concrete browser selections during setup and install, retry standard-path discovery after stale cache entries, and add CLI and dashboard recovery controls for custom system-browser paths. Interactive setup no longer asks users to choose a normal browser runtime. Anti-Detect setup discloses Cloak installation in its initial question and uses one clean-or-compatible-profile source choice, without redundant import, copy-consent, or final installation prompts. Opaque import remains limited to profiles whose Chromium version exactly matches the supported CloakBrowser runtime, with a final compatibility check at the copy boundary.
- f6dd951: Add experimental four-provider capability inspection, explicit Workspace fallback modes, trusted conversation continuation, and visible file-upload acceptance evidence.
- 1d44047: Add a canonical task-capability catalog, expose evidence-backed provider routes through `tokenless capabilities list`, and route normal runs by explicit and inferred capability requirements before browser mutation.
- 3f21056: Rank automatic provider fallback by the run's complete capability requirements, recheck live eligibility before mutation, reject under-declared routes, preserve a versioned context envelope, expose structured durable fallback evidence, and fail closed when file selection lacks visible provider acceptance.
- ef33467: Unify and simplify the local CLI-daemon HTTP boundary under one Tokenless Daemon API v1 OpenAPI contract: keep only public job and browser-runtime routes, run Playwright coordination in-process, require proof before bearer use, and remove unreleased legacy payloads and extension compatibility.
- d099d88: Add experimental Qwen guest-session support through the shared provider registry and visible Playwright workflow.
- 09f5f07: Add the experimental DeepSeek visible-session provider with safe navigation, sign-in detection, baseline chat controls, and evidence-gated capability classification.
- 3f21056: Add experimental DeepSeek visible provider support with exact Instant, Expert, and Vision mode selection, independent DeepThink and Search controls, hCaptcha detection, mode-aware capability inspection, and provenance-bound real-session DOM fixtures.
- b9421d3: Add an experimental signed-in Doubao adapter with visible account and free-tier inspection, Cloak-tested file upload, exact mode and coding-oriented Web skill controls, visible unavailable-state handling, prompt and response handling, and provider challenge detection.
- 50a20b5: Add the secure bilingual local web control plane, verified browser discovery and executable-path recovery, explicit opaque local profile import and re-import, profile-scoped provider and browser preferences, reserved dashboard tabs, setup handoff, dashboard CLI command, and browser-facing administration API.
- d3d78ce: Add English and Simplified Chinese CLI output selected during setup or through the persistent language config.
- e3c1ca0: Add opt-in output savings measurement with a lazily downloaded checksum-pinned local tokenizer, durable per-job attribution and aggregates, explicit CLI and bilingual dashboard controls, doctor diagnostics, and a real cross-platform runtime verification workflow.
- 3f21056: Add experimental Perplexity guest chat routing with live prompt submission, completed responses, normalized citations, and visible citation-link closure through a managed Cloak profile.
- bd4b7c9: Route implicit provider jobs through cached setup observations, report pre-submission errors when no cached provider is usable, and make doctor report provider usability plus normally stopped on-demand runtime state without treating either as damage.
- 3f21056: Add a packaged subscription-aware provider rate-limit catalog, durable submission history, cadence-based admission and deferral, in-scope provider fallback, visible cooldown handling, and `tokenless limits inspect` diagnostics.
- 2986940: Automatically fallback implicit runs across capability-compatible providers before human handoff while preserving one durable job and provider-attempt history.
- b9421d3: Rename persistent preferred provider configuration to `providerWhitelist`, default it to every non-disabled provider except Gemini, and migrate existing config on the next write.
- bb7bf16: Ship Tokenless as a pure JavaScript package with the TypeScript daemon embedded in the CLI package, removing platform-specific native runtime packages and standalone Playwright runner artifacts.
- 09f5f07: Preserve independent browser tabs for different providers, projects, and conversations unless a local job explicitly requests replacement.
- 7df255f: Add concise human-readable CLI output by default, `--verbose` diagnostics, and cross-platform `--color`/`--no-color` controls without changing JSON output.
- 7652158: Add Qwen-specific mode discovery and selection, including Deep Research variants and Auto/Thinking/Fast effort controls.
- 2f0f90f: Add real Claude and Grok native Project creation, exact reuse, instruction outcomes, and durable Project-scoped conversation identity. Use the canonical Qwen Studio chat surface with hydration-safe guest submission.
- df5edf7: Fail provider authentication checks closed on visible account controls and include visible provider usernames and subscription labels in managed profile output.
- 3f21056: Add experimental Z.ai guest chat routing with Cloak-verified prompt submission, completed visible responses, conversation mapping, and durable state.

### Patch Changes

- f676cd6: Keep headed automation tabs and navigation in the background, foregrounding the browser only for explicit user handoffs.
- f6dd951: Add case-sensitive `-P` profile and `-p` provider CLI shortcuts.
- 107ee7e: Add an experimental config-only Playwright/CDP browser connection mode and a two-mode real-browser capability matrix while preserving the existing default.
- 28cfb6d: Reorganize CLI help into concise canonical and advanced command groups.
- bacffef: Classify Claude Cloudflare human checks as a narrow live E2E release-gate known issue when the durable blocker code is structured as `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`.
- 21844cc: Publish a complete bilingual CLI command reference and link it from built-in help and public READMEs.
- 350fba0: Start the local daemon on demand with SQLite-backed dynamic endpoint discovery, recover leased and checkpointed jobs after restart, and add agent-scoped one-time outcome replay with durable full-result lookup.
- 0d438ec: Accept non-empty visible composer content after prompt input instead of requiring an exact DOM text match.
- f6dd951: Report Grok profiles as Free or SuperGrok from visible model entitlements and inventory redacted provider DOM fixtures by page URL.
- 0dc3e49: Add provider access/tier reporting and a provider-session state machine that runs ChatGPT and Gemini guest sessions, hands unauthenticated Claude and Grok jobs to the user before task input, and persists redacted structural DOM snapshots.
- 2986940: Preserve limited Chromium compatibility state when importing a browser profile with explicit user consent.
- 7df255f: Include Gemini in new default provider profiles and write real-provider E2E results as provider-grouped capability reports.
- b9421d3: Keep every production Chromium launch keychain-neutral with `--password-store=basic` and `--use-mock-keychain`, regardless of the configured browser executable or connection mode.
- 0d438ec: Keep managed-profile initialization user-run instead of triggering it from agent skills.
- f676cd6: Reuse an already approved provider page instead of refreshing it before every action, preserving visible conversation and control state across CLI jobs for the same task.
- 378ed4c: Keep one stable browser instance per active managed profile while removing the macOS-specific inspection launcher.
- 0d438ec: Wait for visible prompt input and submit controls, distinguish availability timeouts from action failures, and allow free or anonymous prompt surfaces without an authentication precheck.
- 1d44047: Allow `tokenless profiles open` to launch a managed profile without selecting or navigating to a provider unless `--provider` is passed.
- abc58bb: Record intermittent Qwen DNS failures as retryable suspected rate limits without claiming confirmed provider throttling, and document the distinction and recovery steps.
- f676cd6: Wait for Qwen's visible Deep Research variant menu to settle and scroll the selected option into view before clicking it.
- bcabe9a: Gracefully restart a proof-verified stale local daemon from the current CLI package when its package version or control API revision no longer matches.
- 0dc3e49: Make ordinary daemon reuse depend on verified ready identity plus the exact package version, and let `tokenless setup` reconcile same-home version drift only after proof verification.
- df5edf7: Check each provider's setup sign-in status once and report it without opening a login handoff or retrying.
- 0d438ec: Make `tokenless setup` report the local CLI version against npm latest and reconcile installed-runtime drift after verified same-home ready identity.
- 0dc3e49: Simplify daemon readiness to the same-home proof plus exact package version, and keep shutdown on the bearer-authenticated control endpoint.
- 28cfb6d: Negotiate daemon reuse independently from package versions, and add `tokenless daemon stop` with same-home ready verification followed by bearer-authenticated graceful self-shutdown that waits for the daemon-managed browser to release its profile before returning.
- 4317e00: Reject unknown and command-incompatible CLI options before dispatch, include command usage in human and JSON errors, and add common per-command `-h`/`--help`.
- 77ebc9f: Unify setup and upgrade maintenance so the verified current CLI always upserts global Tokenless skills and reconciles its matching TypeScript daemon.
- bf24d96: Move provider entry points and known page URL patterns into one navigation catalog, and use `https://z.ai/chat` as the Z.ai entry while retaining its official chat runtime origin.

## 0.3.0

### Minor Changes

- 462123b: Add browser visibility policy support to Tokenless config and managed Playwright job requests, including durable resume after a headless job parks for user handoff.

### Patch Changes

- 6d52df5: Ship the current Tokenless reliability release as one patch:

  - Retire the browser extension and Native Messaging host, leaving the managed Playwright daemon as the active runtime.
  - Remove the experimental direct runtime, direct broker, account/project routing commands, direct public exports, and direct-only documentation so managed Playwright through the authenticated local daemon is the only execution path.
  - Provision and verify the local daemon before provider sign-in, restart only process-correlated stale daemons, and keep doctor diagnostics read-only.
  - Add prompt-free `tokenless upgrade` with concise human progress and structured `--json` output to update the global CLI, refresh Tokenless agent skills, reconcile the packaged daemon through the verified new CLI, and report its final doctor result.
  - Keep animated setup progress stable on one terminal line, including in narrow and hosted terminals.
  - Make setup check every supported visible provider, preserve ChatGPT as the default run provider, reject obsolete setup-only provider filters, and document the supported browser-profile import scope.

- 08000f1: Enable Chromium sandboxing for managed visible browser sessions so Chrome no longer launches with the unsupported `--no-sandbox` flag.

## 0.2.0

### Minor Changes

- 551561f: Add Grok as a visible browser-session provider across CLI setup, provider preferences, and extension routing.

## 0.1.2

### Patch Changes

- 3900934: Publish the platform-native daemon and Native Messaging runtime packages required by the universal CLI.
