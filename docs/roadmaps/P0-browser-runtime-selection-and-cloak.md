# Browser Runtime Selection and Cloak Integration

Status: in progress | Priority: P0 | Last reviewed: 2026-08-01

Depends on: Tokenless setup, managed profile lifecycle, the Playwright runner, the packaged daemon, browser E2E infrastructure, and real-provider acceptance gates

Supports: [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), [Provider Expansion and Parity](P0-provider-expansion.md), and [Concurrency and Session Scheduling](P0-concurrency-and-session-scheduling.md)

## Outcome

Tokenless selects and launches one exact Chromium-family runtime for every managed profile while continuing to use Playwright as the browser-control layer. The default path uses a compatible browser already installed by the user. If no supported system browser exists, setup may lazily install a Tokenless-managed Chrome for Testing runtime. CloakBrowser is an explicit opt-in choice that setup downloads from Cloak's official release source, verifies, caches, and launches through the same runtime interface.

The implementation must improve browser realism without silently changing a profile's browser family, corrupting a profile through a browser downgrade, weakening Chromium sandboxing, accessing browser secrets, or redistributing a Cloak binary in a Tokenless package or release artifact.

## Review Snapshot

Plan identity: `P0-browser-runtime-selection-and-cloak.md` | Lifecycle: active | Delivery status: in progress | Audited: 2026-08-01

The plan is saved in the root of `docs/roadmaps/`, which is the repository's authoritative active-roadmap location, and is linked from `docs/roadmaps/README.md` under the name **Browser Runtime Selection and Cloak Integration**.

| Plan area | Marked complete | Audit interpretation |
| --- | ---: | --- |
| Runtime foundation | 5 / 5 | Production catalog, manager, exact executable resolution, transactional installation, and independent Playwright pin exist. |
| Durable selection and profile binding | 6 / 6 | Production config/profile paths implement exact runtime binding, clean family changes, downgrade protection, and no profile/auth-state copying. |
| Setup and daemon integration | 6 / 6 | Interactive and non-interactive setup, lazy download policy, atomic persistence ordering, and daemon resolution paths exist. |
| Safe Chromium profile inventory | 5 / 5 | Setup enumerates known Chromium profile directories without browser state, resolves safe version metadata, classifies exact platform-pin alignment, presents bilingual results, and requires a clean-profile confirmation before download. |
| Exact Playwright launch | 4 / 4 | The resolved executable and launch policy reach Playwright/CDP; sandboxing, test-only keychain neutrality, and cleanup are preserved. |
| Inspection, recovery, and documentation | 5 / 5 | Doctor, cache reuse/repair, bilingual docs, licensing, and cross-platform release-gate launchers exist. |
| Real-boundary acceptance | 10 / 15 | macOS positive runtime paths and the locally executable fail-closed paths are proven. Five environment-dependent release gates remain open; implementation completion is not release completion. |

The unchecked acceptance items are authoritative: macOS `auto` fallback on a host with no system browser, Windows x64 Intel, Windows x64 AMD, Windows Chrome 150 profile-inventory classification, and authenticated provider closure across the selected runtimes. Public-surface results remain observational even though the latest strict Cloak run completed successfully; they do not replace authenticated provider acceptance.

Detailed Windows AMD64 execution, source-browser version cases, evidence requirements, and completion state are tracked in the active [Windows AMD64 Cloak Setup Acceptance Test Plan](P0-windows-amd64-cloak-setup-acceptance-test-plan.md). This parent roadmap remains the product-support authority; the test plan is its AMD-hardware evidence ledger. Intel-hardware acceptance remains a separate unchecked gate in this parent roadmap.

## Product Decisions

### Target platforms

The first release target set is intentionally narrow:

| Platform | Architecture | System browsers | Managed fallback | Cloak |
| --- | --- | --- | --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) | Chrome, Edge, Brave, Arc, Chromium | Chrome for Testing 145 | Cloak 145 |
| Windows | Intel/AMD 64-bit (`win32-x64`) | Chrome, Edge, Brave, Chromium | Chrome for Testing 145 | Cloak 146 |

Intel macOS, Windows ARM, and Linux are out of scope for the first supported release. Unsupported platforms fail clearly before download or profile mutation.

### Locked runtime catalog

The catalog is owned by production code and records exact version, official source, archive checksum, executable layout, and launch policy for every managed runtime.

| Runtime | Platform | Locked version | Distribution decision |
| --- | --- | --- | --- |
| Cloak | `darwin-arm64` | `145.0.7632.109.2` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Cloak | `win32-x64` | `146.0.7680.177.5` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Managed Chrome for Testing | `darwin-arm64` | Chromium `145.0.7632.6` | Download lazily during setup when selected or when `auto` finds no supported system browser. |
| Managed Chrome for Testing | `win32-x64` | Chromium `145.0.7632.6` | Download lazily during setup when selected or when `auto` finds no supported system browser. |

The managed fallback is described accurately as Chrome for Testing, even when a user-facing choice uses the shorter label "Tokenless-managed Chromium." Playwright's library version and the managed browser catalog are independent pins; upgrading Playwright must not implicitly change the selected browser runtime.

### Cloak support and profile-version classification

Tokenless v1 supports only the no-license-key Cloak artifacts pinned in the production catalog. The upstream release list may contain newer Pro builds, but their existence does not make them Tokenless-supported. Tokenless does not request, store, or manage a Cloak license key in this scope.

| Platform | Supported Cloak artifact | Cloak browser version used for profile classification | Current Tokenless decision |
| --- | --- | --- | --- |
| `darwin-arm64` | `145.0.7632.109.2` | `145.0.7632.109` | Supported and locked. |
| `win32-x64` | `146.0.7680.177.5` | `146.0.7680.177` | Supported and locked. |

The fifth component is Cloak's artifact revision; Chromium profile comparison uses the four-component browser version. A candidate is version-aligned only when its owning browser's complete four-component version equals the platform catalog entry's `browserVersion`. A major-only value such as `150` is insufficient for a positive match. A Windows profile last used by any Chromium 150 build is not aligned with the currently supported Windows Cloak 146 runtime.

Version alignment is informational and does not make a profile importable by Tokenless. Tokenless may enumerate only non-secret metadata: browser identity, executable version, user-data root, and validated profile directory key. It must not read `Local State`, `Preferences`, cookies, tokens, browser storage, encryption keys, account names, emails, avatars, or authentication state for this flow. It must not copy a profile directory or open the source browser's profile with Cloak. The safe follow-up is to create a clean Cloak-bound profile and let the user sign in visibly.

### Selection semantics

Tokenless exposes these durable browser preferences:

- `auto`: the default. Prefer a supported installed system browser; if none exists, install and select the locked managed fallback during setup.
- `chrome`, `edge`, `brave`, `arc`, or `chromium`: require that exact system browser. A missing explicit selection fails; it never silently falls back.
- `managed-chromium`: require the catalog-pinned Tokenless-managed Chrome for Testing runtime.
- `cloak`: explicitly opt in to the catalog-pinned Cloak runtime for the current platform.

`--no-browser-download` prevents setup from downloading a missing managed runtime and turns the condition into an actionable failure. npm install, package postinstall, daemon startup, and ordinary job execution never download a browser. Browser installation is a setup operation; the daemon only resolves and launches already-provisioned runtimes.

### Profile/runtime compatibility

Every managed profile is bound to the exact runtime family that created it:

```json
{
  "runtimeBinding": {
    "runtimeId": "system:chrome",
    "family": "system",
    "browserId": "chrome",
    "createdWithVersion": "150.0.7871.187",
    "profileFormat": 1
  }
}
```

The invariant is strict:

- Tokenless never opens one managed profile with a different runtime family through automatic fallback.
- Changing from a system browser to managed Chrome for Testing or Cloak provisions a new clean managed profile.
- Removing a system browser does not cause its existing profile to open with the managed fallback.
- System browser in-family updates remain supported, but the observed version is recorded and downgrade compatibility fails closed.
- Tokenless never copies a local Chrome, Brave, or Cloak profile into a managed profile. This includes opaque file copies: cookies, tokens, browser storage, Keychain-linked state, and other authentication data are never migrated by Tokenless.
- Users authenticate inside the clean Tokenless-managed profile through the visible browser. The browser owns that profile's session afterward, and Tokenless may reuse the same runtime-bound profile without reading its authentication data.

## Architecture

### Deep runtime module

One `BrowserRuntimeManager` module owns runtime discovery, selection, installation, verification, caching, and profile-compatible resolution. Its external interface remains small:

```ts
interface BrowserRuntimeManager {
  discover(): Promise<BrowserCandidate[]>
  ensure(selection: BrowserSelection, options?: EnsureRuntimeOptions): Promise<ResolvedBrowserRuntime>
  resolveForProfile(profile: ManagedProfileRecord): Promise<ResolvedBrowserRuntime>
  inspect(selectionOrProfile: BrowserSelection | ManagedProfileRecord): Promise<BrowserRuntimeInspection>
}
```

The module contains three real adapters behind internal seams:

- `SystemBrowserAdapter` discovers supported installed browsers and their actual executable versions.
- `ManagedChromiumAdapter` installs and resolves the locked Chrome for Testing runtime.
- `CloakBrowserAdapter` installs and resolves the platform-specific Cloak runtime with its dedicated launch policy.

Callers receive a fully resolved launch target instead of reinterpreting a browser ID:

```ts
type ResolvedBrowserRuntime = {
  runtimeId: string
  family: 'system' | 'managed-chromium' | 'cloak'
  browserId: string
  executablePath: string
  actualVersion: string
  expectedVersion: string | null
  source: 'system' | 'tokenless-cache'
  managed: boolean
  checksumVerified: boolean | null
  launchPolicy: 'standard' | 'cloak'
}
```

Setup, config, profiles, doctor, daemon, and the Playwright context manager must cross this seam. Browser-specific download paths, checksums, archive layouts, and launch arguments must not be duplicated across those callers.

### Cache and installation transaction

Managed artifacts live below the Tokenless home rather than inside the npm package:

```text
~/.tokenless/browser/
├── runtimes/
│   ├── cloak/<platform>/<version>/
│   └── managed-chromium/<platform>/<version>/
├── installed.json
└── install.writer.sqlite
```

An install transaction:

1. obtains the browser install writer lock;
2. downloads the exact catalog artifact into a unique temporary directory;
3. verifies the SHA-256 checksum before extraction;
4. rejects unsafe archive paths and extracts into another temporary directory;
5. verifies the expected executable exists and runs `--version`;
6. performs a real, sandboxed smoke launch with a disposable keychain-neutral profile;
7. writes the installed-runtime manifest; and
8. atomically renames the verified runtime into its final cache directory.

Interrupted or failed installs leave the prior verified runtime intact. Offline setup reuses a verified cached runtime. A checksum, version, executable-layout, smoke-launch, or platform mismatch fails closed and must not update config or profile selection.

### Setup transaction

Setup performs browser work before daemon readiness:

1. read config and stop or quiesce a running local daemon when the selected runtime/profile may change;
2. ask whether to enable Anti-Detect mode and state in that question that accepting will download and install the verified platform-pinned CloakBrowser when needed;
3. when Anti-Detect is declined, follow an explicit browser, then the saved normal-browser preference, then deterministic automatic discovery without asking the user to choose a runtime implementation;
4. when Cloak is selected, enumerate safe metadata for known local Chromium profiles across Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing where that browser exists on the platform;
5. classify exact four-component alignment against the platform Cloak catalog entry and show both aligned and non-aligned candidates without reading browser secrets;
6. when aligned candidates exist, present one profile-source choice containing `Start clean` and the aligned profiles; selecting a profile explicitly authorizes its opaque local copy, with no separate import, copy-consent, or installation confirmation;
7. when no candidate aligns, select a clean Cloak profile without asking a profile-source question;
8. resolve or install the selected runtime, verify it, and immediately persist the concrete browser and executable path;
9. provision or select a compatible managed profile, recheck Cloak/profile version compatibility at the copy boundary, and perform an explicitly authorized opaque copy when selected;
10. persist profile preferences and the provider whitelist;
11. start the daemon, verify runtime/profile readiness, and leave one headed review tab open for every enabled provider.

The Anti-Detect question carries the installation disclosure; there is no later installation confirmation. English and Simplified Chinese flows carry equivalent meaning. In non-interactive setup, explicit `--anti-detect` or `--browser cloak` authorizes installation, while an inherited Cloak preference without either flag fails before download with `setup_cloak_confirmation_required`. Non-interactive profile import additionally requires `--consent-local-profile-copy` because no visible profile-source selection occurred.

### Playwright launch contract

Playwright remains the automation layer, but it always launches the exact `executablePath` supplied by `ResolvedBrowserRuntime`. Production code must not switch back to `channel: 'chrome'` or `channel: 'msedge'` after setup has resolved a particular executable.

The standard policy preserves the browser-managed session while supplying the arguments required for Tokenless operation. The Cloak policy also avoids Playwright defaults that disable or overwrite browser-managed fingerprint behavior. Both policies preserve Chromium sandboxing and process cleanup.

Every production and test Chromium launch retains `--password-store=basic` and `--use-mock-keychain`, regardless of its configured executable. A managed profile therefore keeps one keychain-neutral storage mode across Playwright and CDP launches, and no test may trigger or automate a macOS Keychain prompt.

## Delivery Plan and Alignment Ledger

This ledger is updated as implementation and evidence land. A checked code item means the production path exists; a checked evidence item means the stated real-boundary proof has been inspected and recorded.

### Milestone 1: Runtime foundation

- [x] Add the typed platform/version/checksum catalog for supported managed runtimes.
- [x] Add `BrowserRuntimeManager` and the system, managed-Chromium, and Cloak adapters.
- [x] Resolve actual executable versions and always return an exact executable path.
- [x] Add safe cache layout, writer locking, checksum verification, archive extraction, version verification, smoke launch, and atomic installation.
- [x] Pin the Playwright library independently from the browser catalog.

### Milestone 2: Durable selection and profile binding

- [x] Add `auto`, `managed-chromium`, and `cloak` to the durable browser selection contract.
- [x] Migrate config and managed-profile records without silently rebinding existing profiles.
- [x] Add runtime binding to newly provisioned profiles.
- [x] Fail before browser launch when a profile/runtime family or downgrade invariant is violated.
- [x] Create a clean profile when setup changes runtime family.
- [x] Remove browser-profile and authentication-state copy paths; legacy copy flags fail closed with `browser_profile_copy_disabled`.

### Milestone 3: Setup and daemon integration

- [x] Make setup enumerate system and cached candidates and explain download requirements.
- [x] Implement system-first `auto` behavior and explicit-choice fail-closed behavior.
- [x] Add `--no-browser-download` and localized English/Chinese setup messages.
- [x] Complete installation and profile selection before starting the daemon.
- [x] Persist config only after runtime and profile verification succeed.
- [x] Make the daemon resolve the profile-bound runtime without downloading or reselecting.

### Milestone 3A: Safe Chromium profile inventory

- [x] Replace `Local State`-based setup discovery with directory-only profile enumeration that cannot read account or browser-secret fields.
- [x] Cover known Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing roots on supported macOS and Windows platforms.
- [x] Map every candidate to its safe profile `Last Version`, falling back to the exact owning installed-browser version when needed; never infer Chrome's version for another Chromium browser.
- [x] Classify candidates against the production Cloak catalog and present aligned and non-aligned results in equivalent English and Simplified Chinese output, including the official CloakBrowser reference.
- [x] Add the safe second setup choice to continue with a clean Cloak profile; keep profile/authentication-state import absent and legacy copy flags fail-closed.

### Milestone 4: Exact Playwright launch

- [x] Pass `ResolvedBrowserRuntime.executablePath` through the daemon and runner to the context manager.
- [x] Remove normal-path channel-based executable re-resolution.
- [x] Add a dedicated Cloak launch policy without weakening sandboxing.
- [x] Preserve test-only keychain-neutral flags and verify clean child-process shutdown.

### Milestone 5: Inspection, recovery, and documentation

- [x] Extend doctor output with preference, runtime family, actual/expected version, executable source, checksum state, and profile compatibility.
- [x] Support verified-cache reuse and explicit repair/reinstall through setup; a failed replacement restores the previous cache.
- [x] Align `README.md`, `README.zh-CN.md`, CLI package documentation, command reference, and changeset.
- [x] Document Cloak licensing accurately: Tokenless downloads from the official source on user selection and does not redistribute the proprietary binary.
- [x] Make every live browser release-gate command portable across POSIX shells and Windows `cmd.exe` by setting gate variables inside Node launchers.

### Milestone 6: Real-boundary acceptance

Windows AMD64 execution for the following gates is specified and recorded in the active [Windows AMD64 Cloak Setup Acceptance Test Plan](P0-windows-amd64-cloak-setup-acceptance-test-plan.md). The Intel gate remains tracked only in this parent roadmap.

- [x] macOS Apple Silicon: the built-CLI browser-runtime gate proved `auto` resolves an installed system browser without a managed download and records its exact runtime.
- [ ] macOS Apple Silicon: no system browser causes `auto` to install and launch managed Chrome for Testing 145.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed download, checksum, extraction, version, sandboxed smoke launch, atomic cache commit, profile binding, and doctor inspection for managed Chrome for Testing `145.0.7632.6`.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed the same install, repair, profile-binding, and doctor checks for Cloak `145.0.7632.109.2`; the production daemon resolved and launched that exact runtime, while authenticated built-CLI provider closure remains pending below.
- [ ] Windows x64 on Intel hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 on AMD hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 with a real Chrome 150 profile: setup lists only safe directory/version metadata, classifies it as non-aligned with Cloak 146, offers a clean Cloak profile instead of import, and leaves the source profile unchanged.
- [x] Offline-style rerun with downloads disabled reused the previously verified managed Chrome for Testing runtime and performed no download.
- [x] Corrupted managed-cache checksum or browser-version metadata fails closed without changing config or the profile registry.
- [x] Built-CLI profile open preserves the exact `profile_runtime_mismatch` and `profile_browser_downgrade_blocked` errors and fails without changing config, registry, or profile-directory contents.
- [x] Post-download checksum mismatch, an archive containing unsafe paths, and an artifact whose executable reports the wrong version fail in the shared production verifier before cache commit or config/profile mutation.
- [x] A real unsupported `darwin-x64` process failed before download, config, profile, or cache mutation.
- [x] Test-only installer and surface gates remained keychain-neutral, production Cloak launched without a Keychain prompt, sandboxing stayed enabled, and spawned processes were cleaned up.
- [ ] Built-CLI real-provider gates run against ChatGPT, Claude, Gemini, Qwen, DeepSeek, Grok, Grok Cloud, and Google surfaces using system, managed, and Cloak runtimes where the selected profile is authenticated.
- [x] macOS CAPTCHA/challenge outcomes are recorded for system Chrome, managed Chrome for Testing, and Cloak; the evidence is explicitly observational and does not claim guaranteed CAPTCHA bypass.

### Evidence recorded on 2026-08-01

- The browser surface matrix used system Chrome `150.0.7871.187`, managed Chrome for Testing `145.0.7632.6`, and Cloak `145.0.7632.109.2` with Playwright, real headed browser processes, keychain-neutral isolated test profiles, the real provider network, and no observer process.
- In each Cloak run, ChatGPT, Claude, Gemini, Grok Cloud, Qwen, and DeepSeek completed navigation with real HTTP responses and no detected reCAPTCHA, Cloudflare, hCaptcha, or verification-title challenge.
- In the repeatable sequential comparison, system Chrome reached a Claude Cloudflare interstitial, a DeepSeek Human Verification page, and Google `/sorry/`; managed Chrome for Testing reached Google `/sorry/`; Cloak reached the normal provider surfaces and Google Search. Cloak returned HTTP 200 search results with no detected challenge in three consecutive runs, including runs after both other runtimes had been blocked.
- The built CLI and production daemon successfully resolved and launched the exact profile-bound Cloak runtime. A subsequent durable `auth.status` job timed out in the provider action scheduler, so this evidence does not close authenticated provider actions, prompt submission, or response generation.
- The official Windows x64 Chrome for Testing `145.0.7632.6` and Cloak `146.0.7680.177.5` archives were downloaded on macOS for static verification; both matched the catalog SHA-256 values and contained the expected executable layout. This is artifact evidence only and does not replace Windows launch acceptance.
- An invalid local Anti-Detect setup check launched the production Cloak target instead of a keychain-neutral E2E target and triggered a macOS Keychain prompt. The user selected Deny, the browser and test daemon were stopped, and that run was discarded. `e2eInspection` launches now retain Playwright's `--password-store=basic` and `--use-mock-keychain` defaults while production launch options remain unchanged. Subsequent focused runtime and surface gates completed without a Keychain prompt, closing the regression gate.
- The built-CLI browser-runtime gate mutated only its temporary verified Cloak cache and proved that mismatched checksum and browser-version manifest fields return `browser_runtime_cache_invalid` while config and the profile registry remain byte-for-byte unchanged.
- The same gate created real temporary registry profiles with mismatched and downgrade bindings, called `profiles open` through the built CLI and packaged daemon, received the exact domain errors, and proved that config, registry, and profile-directory contents remained unchanged. This gate exposed and fixed both generic `daemon_store_error` wrapping and a redundant same-value daemon URL write before it passed.
- The cross-platform Node launcher then reran the complete built-CLI browser-runtime gate successfully in 69 seconds. The checked-in npm release-gate commands no longer depend on POSIX-only `VAR=value command` syntax; live Windows execution remains required before declaring Windows support.
- The same launcher attempted a fresh Cloak-only surface gate. The suite failed without retry at Qwen navigation because the machine's active DNS resolver returned Qwen's CNAME but no final address (`ERR_NAME_NOT_RESOLVED`). Qwen's official page and public DNS still identified `https://chat.qwen.ai/` and resolved its current addresses, so the endpoint was not changed and no test-only DNS override was introduced. This run is recorded as failed external-prerequisite evidence, not as provider or CAPTCHA acceptance.
- A gate audit found that provider challenge outcomes were recorded but not asserted. The surface gate now fails when any enabled provider renders a detected reCAPTCHA, Cloudflare, hCaptcha, or verification-title challenge; navigation success alone can no longer produce a false pass.
- A checksum-verified official Node.js `v22.13.1` `darwin-x64` binary ran under Rosetta as a real unsupported process and invoked the built CLI with `install --browser cloak`. The CLI returned exit code 1 with exact code `browser_runtime_platform_unsupported`; the dedicated Tokenless home remained empty, proving that config, profile, browser cache, and download state were not created. The temporary Node and home directories were removed after inspection.
- After the system resolver recovered, the stricter Cloak-only surface gate passed with Cloak browser `145.0.7632.109`: ChatGPT, Claude, Gemini, Grok Cloud, Qwen, and DeepSeek all completed real navigation with no detected challenge, and Google rendered search results with no reCAPTCHA signal.
- A fresh full matrix then visited every enabled provider and Google before evaluating each runtime. System Chrome `150.0.7871.187` failed on the Claude Cloudflare interstitial and Google `/sorry`; managed Chrome for Testing `145.0.7632.6` recorded a Gemini navigation abort and Google `/sorry`; Cloak passed every surface again. The gate was corrected so an early provider failure can no longer prevent later providers or Google from being exercised, and a failed navigation that remains on the prior origin no longer misattributes the prior page's challenge to the next provider.
- The managed-artifact security integration called the same production verifier used immediately after a real download and before cache commit. With real tar.gz bytes, the real filesystem, the system `tar` executable, and a real version subprocess, it received exact `browser_runtime_checksum_mismatch`, `browser_runtime_archive_unsafe`, and `browser_runtime_version_mismatch` errors. The checksum case created no payload, the unsafe entry escaped nowhere, and config/profile sentinel files remained byte-for-byte unchanged in all three cases. The complete built-CLI browser-runtime gate passed again in 75 seconds after this refactor, proving the official managed Chrome and Cloak positive install paths still work. A later targeted managed-browser surface rerun also visited every provider successfully and isolated its current blockers to the Claude Cloudflare interstitial and Google `/sorry`.
- The current selected user profile is bound to system Chrome rather than Cloak, and `doctor` reports no usable provider readiness observations for ChatGPT, Claude, Gemini, or Grok. Tokenless must not silently switch that profile or automate provider login. Authenticated cross-runtime closure therefore requires the user to explicitly select a clean runtime-bound profile, sign in visibly, and then invoke the manual provider gates.
- The official release list now also exposes Cloak Pro Chromium 150 builds for macOS and Windows, but obtaining the current Pro binary requires a Cloak key. The current Tokenless scope remains the no-license-key catalog pins above; Pro 150 is not silently added to the supported set. See the [official CloakBrowser releases](https://github.com/CloakHQ/CloakBrowser/releases).
- The built CLI's real filesystem inventory found the current macOS Chrome, Brave, Edge, Arc, Chromium, and Chrome for Testing roots without parsing `Local State`. Chrome `150.0.7871.127`, Brave `150.1.92.140`, Arc `150.0.7871.115`, and Chrome for Testing `147.0.7727.15` were non-aligned; Chromium `145.0.7632.109` was exactly aligned with the macOS Cloak pin. Edge had no standard persistent profile directory to list.
- Historical evidence: a real interactive built-CLI setup used an isolated Tokenless home, selected Anti-Detect, displayed the official project link, exact Cloak/Chromium pin, all discovered candidate classifications, and the former second clean-profile confirmation. Declining returned `setup_cloak_profile_declined` before mutation. That redundant second confirmation has since been superseded by the installation disclosure in the initial Anti-Detect question and the single profile-source choice.
- The focused built-CLI filesystem integration passed with real `Default` and `Profile 1` directories, an exact aligned `Last Version`, a mismatched Chromium 150 version, and deliberately invalid `Local State` contents. It classified both versions correctly and succeeded without parsing the invalid browser-state file.
- Historical evidence: the former positive interactive path accepted both Anti-Detect confirmations in an isolated home, reused the checksum-verified Cloak cache with downloads disabled, reported exact Cloak browser `145.0.7632.109`, and reached provider/profile selection. The current flow removes the redundant second confirmation. A separate built-CLI clean-profile boundary against that exact cache created a ready default profile bound to runtime `cloak:darwin-arm64:145.0.7632.109.2`, family/browser `cloak`, and created-with version `145.0.7632.109`.
- The non-interactive built-CLI contract now proves that a saved Cloak preference alone fails with `setup_cloak_confirmation_required` before runtime/profile mutation, while explicit `--anti-detect` passes consent handling and reaches the expected runtime ensure boundary. The same contract proves that incomplete two- or three-component `Last Version` metadata is `unknown` rather than a false non-aligned result.

## Release Gate

This roadmap remains in progress until every supported-platform path is implemented and the real-boundary acceptance evidence is complete. A macOS-only proof may advance the implementation but cannot establish Windows support. Prototype scripts, fixture checks, source-string assertions, or a browser opening a page are development evidence only and cannot replace built-CLI setup, daemon, profile, and real-provider verification.

No Cloak binary may be included in npm packages, installers, GitHub release artifacts, or repository history. No release may claim profile portability across runtime families, authentication-state migration, or CAPTCHA bypass. No-license-key support must remain distinct from upstream Pro/keyed builds. The release must instead state the exact supported platforms, locked managed-runtime versions, selection rules, clean-profile isolation behavior, and observed provider evidence.
