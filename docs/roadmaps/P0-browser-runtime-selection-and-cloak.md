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
| Exact Playwright launch | 4 / 4 | The resolved executable and launch policy reach Playwright/CDP; sandboxing, test-only keychain neutrality, and cleanup are preserved. |
| Inspection, recovery, and documentation | 5 / 5 | Doctor, cache reuse/repair, bilingual docs, licensing, and cross-platform release-gate launchers exist. |
| Real-boundary acceptance | 9 / 14 | macOS positive runtime paths and several fail-closed paths are proven. Five release gates remain open; implementation completion is not release completion. |

The unchecked acceptance items are authoritative: macOS `auto` fallback on a host with no system browser, Windows x64 Intel, Windows x64 AMD, download-time malformed-artifact failures, and authenticated provider closure across the selected runtimes. Public-surface results remain observational even though the latest strict Cloak run completed successfully; they do not replace authenticated provider acceptance.

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
2. discover installed and cached candidates with actual versions;
3. ask whether to enable Anti-Detect mode; an affirmative answer selects Cloak, while a negative answer continues to ordinary browser selection;
4. resolve or install the selected runtime;
5. verify the resolved runtime and provision or select a clean, compatible managed profile without copying another browser profile;
6. explain that the user signs in inside the managed profile and that its browser-managed session persists across jobs;
7. atomically persist the browser preference, resolved runtime binding, and default profile;
8. start the daemon and verify runtime/profile readiness; and
9. leave one headed review tab open for every enabled provider.

The prompt shows the exact version, platform, source, and whether a download is required. English and Simplified Chinese flows carry equivalent meaning. Non-interactive setup follows the same rules and produces structured errors rather than silently choosing a different runtime.

### Playwright launch contract

Playwright remains the automation layer, but it always launches the exact `executablePath` supplied by `ResolvedBrowserRuntime`. Production code must not switch back to `channel: 'chrome'` or `channel: 'msedge'` after setup has resolved a particular executable.

The standard policy preserves existing production behavior. The Cloak policy supplies only the arguments required for Tokenless operation and avoids Playwright defaults that disable or overwrite browser-managed fingerprint behavior. Both policies preserve Chromium sandboxing and process cleanup.

The test-only `profile` target retains `--password-store=basic` and `--use-mock-keychain`. Production targets must not inherit test-only credential settings, and no test may trigger or automate a macOS Keychain prompt.

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

- [x] macOS Apple Silicon: the built-CLI browser-runtime gate proved `auto` resolves an installed system browser without a managed download and records its exact runtime.
- [ ] macOS Apple Silicon: no system browser causes `auto` to install and launch managed Chrome for Testing 145.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed download, checksum, extraction, version, sandboxed smoke launch, atomic cache commit, profile binding, and doctor inspection for managed Chrome for Testing `145.0.7632.6`.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed the same install, repair, profile-binding, and doctor checks for Cloak `145.0.7632.109.2`; the production daemon resolved and launched that exact runtime, while authenticated built-CLI provider closure remains pending below.
- [ ] Windows x64 on Intel hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 on AMD hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [x] Offline-style rerun with downloads disabled reused the previously verified managed Chrome for Testing runtime and performed no download.
- [x] Corrupted managed-cache checksum or browser-version metadata fails closed without changing config or the profile registry.
- [x] Built-CLI profile open preserves the exact `profile_runtime_mismatch` and `profile_browser_downgrade_blocked` errors and fails without changing config, registry, or profile-directory contents.
- [ ] Download-time checksum mismatch, an archive containing unsafe paths, and an artifact whose executable reports the wrong version fail before cache commit or config/profile mutation.
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

## Release Gate

This roadmap remains in progress until every supported-platform path is implemented and the real-boundary acceptance evidence is complete. A macOS-only proof may advance the implementation but cannot establish Windows support. Prototype scripts, fixture checks, source-string assertions, or a browser opening a page are development evidence only and cannot replace built-CLI setup, daemon, profile, and real-provider verification.

No Cloak binary may be included in npm packages, installers, GitHub release artifacts, or repository history. No release may claim profile portability across runtime families, authentication-state migration, or CAPTCHA bypass. The release must instead state the exact supported platforms, locked managed-runtime versions, selection rules, clean-profile isolation behavior, and observed provider evidence.
