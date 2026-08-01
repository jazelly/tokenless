# Browser Runtime Selection and Cloak Integration

Status: in progress | Priority: P0 | Last reviewed: 2026-08-01

Depends on: Tokenless setup, managed profile lifecycle, the Playwright runner, the packaged daemon, browser E2E infrastructure, and real-provider acceptance gates

Supports: [Real Provider Browser E2E and Native Projects](real-provider-browser-e2e-and-native-projects.md), [Provider Expansion and Parity](provider-expansion.md), and [Concurrency and Session Scheduling](concurrency-and-session-scheduling.md)

## Outcome

Tokenless selects and launches one exact Chromium-family runtime for every managed profile while continuing to use Playwright as the browser-control layer. The default path uses a compatible browser already installed by the user. If no supported system browser exists, setup may lazily install a Tokenless-managed Chrome for Testing runtime. CloakBrowser is an explicit opt-in choice that setup downloads from Cloak's official release source, verifies, caches, and launches through the same runtime interface.

The implementation must improve browser realism without silently changing a profile's browser family, corrupting a profile through a browser downgrade, weakening Chromium sandboxing, accessing browser secrets, or redistributing a Cloak binary in a Tokenless package or release artifact.

## Product Decisions

### Supported platforms

The first supported platform set is intentionally narrow:

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
- Changing from a system browser to Cloak or managed Chrome for Testing provisions a new clean managed profile.
- Removing a system browser does not cause its existing profile to open with the managed fallback.
- System browser in-family updates remain supported, but the observed version is recorded and downgrade compatibility fails closed.
- Direct full-profile import from Chrome into Cloak is not supported in the first release. Any future import must be a separate, consented migration with real-boundary compatibility evidence.
- Tokenless never inspects, exports, logs, copies, or decrypts cookies, credentials, Keychain items, or browser-storage secrets.

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
3. present system choices first, followed by managed Chromium and explicit Cloak choices;
4. resolve or install the selected runtime;
5. verify the resolved runtime and provision or select a compatible managed profile;
6. atomically persist the browser preference, resolved runtime binding, and default profile; and
7. start the daemon and verify runtime/profile readiness.

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
- [ ] Support verified-cache reuse and explicit repair/reinstall through setup.
- [x] Align `README.md`, `README.zh-CN.md`, CLI package documentation, command reference, and changeset.
- [x] Document Cloak licensing accurately: Tokenless downloads from the official source on user selection and does not redistribute the proprietary binary.

### Milestone 6: Real-boundary acceptance

- [ ] macOS Apple Silicon: `auto` uses installed Chrome without download and launches its exact executable.
- [ ] macOS Apple Silicon: no system browser causes `auto` to install and launch managed Chrome for Testing 145.
- [x] macOS Apple Silicon development evidence: direct runtime-manager installation completed download, checksum, extraction, version, sandboxed smoke launch, and atomic cache commit for managed Chrome for Testing `145.0.7632.6`.
- [x] macOS Apple Silicon: explicit runtime-manager installation completed the same checks and sandboxed smoke launch for Cloak `145.0.7632.109.2`; built-CLI provider proof remains pending below.
- [ ] Windows x64 on Intel hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 on AMD hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [x] Offline-style rerun with downloads disabled reused the previously verified managed Chrome for Testing runtime and performed no download.
- [ ] Corrupt checksum, wrong version, unsafe archive, unsupported platform, and profile/runtime mismatch all fail before config/profile mutation or browser launch.
- [ ] Test-only launch remains keychain-neutral, production launch is not unintentionally changed, sandboxing remains enabled, and spawned processes are cleaned up.
- [ ] Built-CLI real-provider gates run against ChatGPT, Claude, Gemini, Qwen, DeepSeek, Grok, Grok Cloud, and Google surfaces using system, managed, and Cloak runtimes where the selected profile is authenticated.
- [ ] CAPTCHA/challenge outcomes are recorded as observed evidence per runtime; Cloak is not described as bypassing CAPTCHA without a repeatable real-session result.

## Release Gate

This roadmap remains in progress until every supported-platform path is implemented and the real-boundary acceptance evidence is complete. A macOS-only proof may advance the implementation but cannot establish Windows support. Prototype scripts, fixture checks, source-string assertions, or a browser opening a page are development evidence only and cannot replace built-CLI setup, daemon, profile, and real-provider verification.

No Cloak binary may be included in npm packages, installers, GitHub release artifacts, or repository history. No release may claim profile portability across runtime families or CAPTCHA bypass. The release must instead state the exact supported platforms, locked managed-runtime versions, selection rules, profile isolation behavior, and observed provider evidence.
