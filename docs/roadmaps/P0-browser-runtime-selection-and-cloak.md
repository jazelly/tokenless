# Browser Runtime Selection and Cloak Integration

Status: in progress | Priority: P0 | Last reviewed: 2026-08-09

Depends on: Tokenless setup, managed profile lifecycle, the Playwright runner, the packaged daemon, browser E2E infrastructure, and real-provider acceptance gates

Supports: [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md), [Provider Expansion and Parity](P0-provider-expansion.md), and [Concurrency and Session Scheduling](P0-concurrency-and-session-scheduling.md)

## Outcome

Tokenless selects and launches one exact Chromium-family runtime for every managed profile while continuing to use Playwright as the browser-control layer. New normal setup installs or reuses platform-pinned Tokenless-managed Chrome for Testing on Apple Silicon macOS and Windows x64. CloakBrowser is an explicit opt-in choice with official checksum-pinned catalog entries for macOS arm64/x64, Linux arm64/x64, and Windows x64; the added catalog paths remain subject to real-host acceptance.

The implementation must improve browser realism without silently changing a profile's browser family, corrupting a profile through a browser downgrade, weakening Chromium sandboxing, accessing browser secrets, or redistributing a Cloak binary in a Tokenless package or release artifact.

## Review Snapshot

Plan identity: `P0-browser-runtime-selection-and-cloak.md` | Lifecycle: active | Delivery status: in progress | Audited: 2026-08-06

The plan is saved in the root of `docs/roadmaps/`, which is the repository's authoritative active-roadmap location, and is linked from `docs/roadmaps/README.md` under the name **Browser Runtime Selection and Cloak Integration**.

| Plan area | Marked complete | Audit interpretation |
| --- | ---: | --- |
| Runtime foundation | 5 / 5 | Production catalog, manager, exact executable resolution, transactional installation, and independent Playwright pin exist. |
| Durable selection and profile binding | 6 / 6 | Production config/profile paths implement exact runtime binding, clean family changes, downgrade protection, and explicit-consent opaque profile copying without authentication-value inspection. |
| Setup and daemon integration | 6 / 6 | Interactive and non-interactive setup, lazy download policy, atomic persistence ordering, and daemon resolution paths exist. |
| Safe Chromium profile inventory | 5 / 5 | Diagnostic discovery enumerates known Chromium-family profile directories without browser state; experimental setup import admits only the macOS Chrome/Brave source majors listed in the shipping matrix, presents bilingual limitations, and keeps Arc and every unverified combination ineligible. |
| Exact Playwright launch | 4 / 4 | The resolved executable and launch policy reach Playwright/CDP; sandboxing, production native credential storage, disposable-profile keychain neutrality, and cleanup are preserved. |
| Inspection, recovery, and documentation | 5 / 5 | Doctor, cache reuse/repair, bilingual docs, licensing, and cross-platform release-gate launchers exist. |
| Real-boundary acceptance | Existing macOS gates retained; new host gates open | macOS Apple Silicon evidence remains valid. Intel macOS and both Linux architectures have catalog/runtime implementation only until their real-host gates run; implementation completion is not release completion. |

The unchecked acceptance items are authoritative: Brave 144 format behavior, authenticated Brave sign-in portability, Windows Brave parity, Windows x64 Intel, Windows x64 AMD, Windows Chrome 150 profile-inventory classification, Windows 146 managed-to-Cloak importability parity, and authenticated provider closure across the selected runtimes. Arc import is a deliberate product exclusion rather than an open support gate. Public-surface results remain observational even though the latest strict Cloak run completed successfully; they do not replace authenticated provider acceptance.

Detailed Windows AMD64 execution, source-browser version cases, headed/headless surface coverage, Chrome challenge observation, isolated Cloak fallback, evidence requirements, and completion state are tracked in the active [Windows AMD64 Browser Runtime, Surface, and Fallback Acceptance Test Plan](P0-windows-amd64-cloak-setup-acceptance-test-plan.md). This parent roadmap remains the product-support authority; the test plan is its AMD-hardware evidence ledger. Intel-hardware acceptance remains a separate unchecked gate in this parent roadmap.

## Product Decisions

### Target platforms

Normal managed Chrome for Testing setup remains narrow, while explicit Cloak setup follows the official no-license-key artifact set:

| Platform | Architecture | Legacy/advanced explicit system browsers | Normal setup runtime | Cloak |
| --- | --- | --- | --- | --- |
| macOS | Apple Silicon (`darwin-arm64`) | Chrome, Edge, Chromium | Chrome for Testing 145 | Cloak 145 |
| macOS | Intel (`darwin-x64`) | Chrome, Edge, Chromium | Not cataloged | Cloak 145 |
| Linux | ARM 64-bit (`linux-arm64`) | Explicit custom executable path only | Not cataloged | Cloak 146 (`.3`) |
| Linux | Intel/AMD 64-bit (`linux-x64`) | Explicit custom executable path only | Not cataloged | Cloak 146 (`.5`) |
| Windows | Intel/AMD 64-bit (`win32-x64`) | Chrome, Edge, Chromium | Chrome for Testing 146 | Cloak 146 |

Windows ARM and every other unlisted OS/architecture remain unsupported. On Intel macOS and Linux, `cloak` is the supported managed-runtime selection; `auto` and `managed-chromium` still fail because Tokenless has no verified Chrome for Testing artifact for those platforms.

### Locked runtime catalog

The catalog is owned by production code and records exact version, official source, archive checksum, executable layout, and launch policy for every managed runtime.

| Runtime | Platform | Locked version | Distribution decision |
| --- | --- | --- | --- |
| Cloak | `darwin-arm64` | `145.0.7632.109.2` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Cloak | `darwin-x64` | `145.0.7632.109.2` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Cloak | `linux-arm64` | `146.0.7680.177.3` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Cloak | `linux-x64` | `146.0.7680.177.5` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Cloak | `win32-x64` | `146.0.7680.177.5` | Download from the official Cloak GitHub release during explicit setup selection; do not bundle or redistribute. |
| Managed Chrome for Testing | `darwin-arm64` | Chromium `145.0.7632.6` | Download the official checksum-pinned artifact during normal setup when it is not already cached; do not embed it in the npm package. |
| Managed Chrome for Testing | `win32-x64` | Chromium `146.0.7680.165` | Download the official checksum-pinned artifact during normal setup when it is not already cached; do not embed it in the npm package. |

The normal managed runtime is described accurately as Chrome for Testing. Playwright's library version and the managed browser catalog are independent pins; upgrading Playwright must not implicitly change the selected browser runtime.

### Managed-target profile import classification

Tokenless v1 supports only the no-license-key Cloak artifacts pinned in the production catalog. The upstream release list may contain newer Pro builds, but their existence does not make them Tokenless-supported. Tokenless does not request, store, or manage a Cloak license key in this scope.

| Platform | Supported Cloak artifact | Cloak browser version used for profile classification | Current Tokenless decision |
| --- | --- | --- | --- |
| `darwin-arm64` | `145.0.7632.109.2` | `145.0.7632.109` | Supported and locked. |
| `darwin-x64` | `145.0.7632.109.2` | `145.0.7632.109` | Cataloged and locked; real-host acceptance pending. |
| `linux-arm64` | `146.0.7680.177.3` | `146.0.7680.177` | Cataloged and locked; real-host acceptance pending. |
| `linux-x64` | `146.0.7680.177.5` | `146.0.7680.177` | Cataloged and locked; real-host acceptance pending. |
| `win32-x64` | `146.0.7680.177.5` | `146.0.7680.177` | Supported and locked. |

The fifth component is Cloak's artifact revision; source classification uses the Chromium major recorded by the owning browser's safe `Last Version` metadata. Admission is an evidence-bound product policy, not a Chromium compatibility guarantee. The first shipping matrix is intentionally narrow:

| Platform | Source browser | Eligible source Chromium major | Managed CFT target | Cloak target | Shipping decision |
| --- | --- | :---: | :---: | :---: | --- |
| `darwin-arm64` | Google Chrome | `145` | ✅ `145` | ✅ `145` | Experimental; explicit consent required. |
| `darwin-arm64` | Brave | `143`, `145` | ✅ `145` | ✅ `145` | Experimental; explicit source-browser selection and consent required. |
| `darwin-arm64` | Brave | every other major | ❌ | ❌ | Fail before copy. |
| `darwin-arm64` | Arc | every major | ❌ | ❌ | Not supported; Arc is not offered as an import source. |
| `win32-x64` | Any browser | any major | ❌ | ❌ | Not supported until the Windows matrix is completed. |

Edge, Chromium, Chrome for Testing, Arc, and every other source browser remain ineligible even when an experimental format row opened successfully. Tokenless may enumerate only non-secret metadata: browser identity, user-data root, validated profile directory key, and safe `Last Version` metadata. The setup UI requires the user to identify Google Chrome or Brave before a custom root is scanned; the CLI equivalent is `--import-browser <chrome|brave>`. After explicit consent, Tokenless may copy the selected profile only as an opaque local filesystem tree into a new user-controlled managed Chrome for Testing 145 or CloakBrowser 145 profile. It must not parse `Local State`, `Preferences`, cookies, tokens, browser storage, encryption keys, account names, emails, avatars, or authentication state. Unsupported browsers, platforms, targets, unknown versions, and unlisted source majors fail before copy; `Start clean` remains the safe default. A successful open does not guarantee authentication-state portability.

### Selection semantics

Tokenless exposes these durable browser preferences:

- `auto`: resolve to the platform-pinned managed Chrome for Testing runtime where Tokenless catalogs one. New setup never adopts an installed system browser; Intel macOS and Linux must select `cloak` explicitly.
- `chrome`, `edge`, `chromium`, or `chrome-for-testing`: legacy/advanced explicit selections that require that exact system browser. A missing explicit selection fails; it never silently falls back.
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
- Changing runtime family provisions a new clean managed profile; Tokenless does not currently expose managed Chrome-for-Testing-to-Cloak profile migration.
- Removing a system browser does not cause its existing profile to open with the managed fallback.
- System browser in-family updates remain supported, but the observed version is recorded and downgrade compatibility fails closed.
- Tokenless experimentally copies only a Google Chrome source profile, only after explicit user selection or the non-interactive consent flag, only into a new CloakBrowser-bound managed profile, and only as an opaque filesystem tree. The source remains untouched.
- Tokenless never inspects, exports, logs, or promises migration of authentication values. Browser-managed login state may remain unusable when the source and target rely on different macOS Safe Storage identities even if the copied profile opens.
- Users may instead authenticate inside a clean Tokenless-managed profile through the visible browser. The browser owns that profile's session afterward, and Tokenless may reuse the same runtime-bound profile without reading its authentication data.

The matching managed/Cloak major on each platform is intentional preparation for a possible future explicit migration flow, not a current portability guarantee. The macOS Chrome for Testing 145 to Cloak 145 importability check passed, but same-major Chrome for Testing 150 to Cloak 150 checks failed. Windows 146 remains untested on Windows, and neither platform has authenticated-state migration evidence. Any future managed-profile migration must be explicit, opaque, platform-gated, and must create a separate destination profile rather than rebinding the source in place.

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
3. when Anti-Detect is declined, select the platform-pinned managed Chrome for Testing runtime; do not discover or adopt the user's installed browser as the target runtime;
4. for either managed Chrome for Testing or Cloak, label source-profile import as experimental, state that it may fail by version or platform and does not guarantee sign-in transfer, and enumerate safe metadata only for local Google Chrome and Brave profiles;
5. classify candidates against the platform-specific shipping matrix above and show eligible and ineligible Google Chrome/Brave candidates without reading browser secrets;
6. present one profile-source choice containing `Start clean` and only eligible profiles; choosing Brave or a custom root requires an explicit source-browser selection, and selecting a profile authorizes its opaque local copy with no separate interactive copy confirmation;
7. when no candidate is eligible, use a clean managed profile;
8. resolve or install the selected runtime, verify it, and immediately persist the concrete browser and executable path;
9. provision or select a compatible managed profile, recheck Cloak/profile version compatibility at the copy boundary, and perform an explicitly authorized opaque copy when selected;
10. persist profile preferences and the provider whitelist;
11. start the daemon, verify runtime/profile readiness, and leave one headed review tab open for every enabled provider.

The Anti-Detect question carries the installation disclosure; there is no later installation confirmation. The profile-source step separately carries the experimental status, exact Chrome/Brave eligibility, Arc exclusion, version/platform variability, and sign-in non-guarantee disclosures. English and Simplified Chinese flows carry equivalent meaning. In non-interactive setup, explicit `--anti-detect` or `--browser cloak` authorizes installation, while an inherited Cloak preference without either flag fails before download with `setup_cloak_confirmation_required`. Non-interactive profile import additionally requires `--import-browser <chrome|brave>` when the source is not Chrome and always requires `--consent-local-profile-copy` because no visible profile-source selection occurred.

### Playwright launch contract

Playwright remains the automation layer, but it always launches the exact `executablePath` supplied by `ResolvedBrowserRuntime`. Production code must not switch back to `channel: 'chrome'` or `channel: 'msedge'` after setup has resolved a particular executable.

The standard policy preserves the browser-managed session while supplying the arguments required for Tokenless operation. The Cloak policy also avoids Playwright defaults that disable or overwrite browser-managed fingerprint behavior. Both policies preserve Chromium sandboxing and process cleanup.

Production managed-profile launches suppress Playwright's `--password-store=basic` and `--use-mock-keychain` defaults so the selected browser can use its normal OS credential storage. On macOS this permits the matching browser runtime to request access to its Safe Storage Keychain item and decrypt browser-managed profile state. Tokenless never reads that item itself, and approval remains a manual user action. Disposable installer smoke profiles and unauthenticated browser-surface profiles remain keychain-neutral because they carry no reusable authentication state.

### Opaque profile importability runbook

This manual runbook measures whether a copied profile can be opened by a target Cloak runtime and whether one non-sensitive browser-history marker survives the copy. It does not measure login-state portability, provider readiness, CAPTCHA behavior, or product support.

1. Record the source executable's exact four-component Chromium version and the target Cloak artifact/browser versions using executable `--version` output or other safe version metadata.
2. Use a new unauthenticated source user-data directory. In a real headed browser, issue one uniquely named Google Search and confirm the resulting URL is present through the visible unfiltered `chrome://history/` surface. Do not read the History database, browser storage, `Local State`, `Preferences`, credentials, or account content.
3. Close the source with `context.close()` and verify that its browser process exited before copying.
4. Invoke the production `copyOpaqueChromiumProfile` boundary with explicit consent. Copy `Default` plus the approved root metadata as an opaque tree into a new UUID destination; never modify the source.
5. Launch exactly one target persistent context with Chromium sandboxing enabled. Production-style target launches suppress Playwright's `--password-store=basic` and `--use-mock-keychain` defaults so macOS uses native credential storage.
6. Treat a returned context plus the expected target `browser.version()` as launch success. For a source with the non-sensitive marker, open the visible unfiltered `chrome://history/` UI and require the marker URL to appear.
7. Close every returned context with `context.close()`. For keyed Cloak, query the server-side seat with an info probe that cannot launch Chromium and require `active: 0` before the next case. If the process exits before a context is returned, record the signal or exit category and do not describe it as a clean close.
8. Run cases sequentially without internal retry. Record real Google outcomes separately; a `/sorry/` response does not invalidate the history-copy check and is not a CAPTCHA-support result.

### Managed runtime parity on macOS (2026-08-06)

This focused `darwin-arm64` run used the production opaque-copy boundary, a new unauthenticated Chrome for Testing `145.0.7632.6` source profile, native target credential storage, Chromium sandboxing, and clean `context.close()` shutdown. It copied 159 opaque files. No account, login state, browser storage, or authentication value was inspected.

| Source profile | Target runtime | Opened | History marker preserved | Clean close |
| --- | --- | :---: | :---: | :---: |
| Chrome for Testing `145.0.7632.6` | Chrome for Testing `145.0.7632.6` | ✅ | ✅ | ✅ |
| Chrome for Testing `145.0.7632.6` | Cloak `145.0.7632.109.2` | ✅ | ✅ | ✅ |

This verifies macOS profile importability parity for the pinned major-145 pair. It does not verify login portability and does not enable a product migration path by itself.

### Cross-family profile format experiment on macOS (2026-08-06)

This follow-up `darwin-arm64` experiment compared new unauthenticated Google Chrome, Chrome for Testing, and Brave source profiles with both major-145 targets, and attempted to establish the same safe source prerequisite for Arc. The targets were managed Chrome for Testing `145.0.7632.6` and Cloak `145.0.7632.109.2` (browser `145.0.7632.109`). It used the production opaque-copy boundary, visible unfiltered `chrome://history/` markers, native target credential storage, enabled Chromium sandboxing, and sequential cleanup. It did not inspect login state, browser storage, profile databases, credentials, or Keychain values.

✅ means the target returned a context, displayed the source marker in the visible History UI, or closed cleanly, according to the column. ❌ means the copied target exited with `SIGTRAP` before returning a context; the marker and clean-close criteria were therefore not reached rather than independently disproved. ⏳ means a safe source prerequisite was not established, so the target was not exercised and no compatibility conclusion exists.

All newly downloaded archives, extracted app bundles, scripts, reports, and the prior Windows static artifact are centralized under `~/.tokenless/experimental/browser-importability/`. Downloaded app bundles remain inside that hidden experiment root; neither `/Applications` nor `~/Applications` was modified. The experiment root is excluded from Spotlight indexing, and all top-level and helper app registrations under the new and legacy experiment roots were removed; the final Launch Services and Spotlight queries returned zero matching app entries. `materials.json` records source URLs, archive SHA-256 values, official Brave checksum matches, Developer ID teams, notarization/signature results, and target-runtime references. `legacy-cft-matrix` is a central symlink to the earlier absolute-path evidence root, which remains in place so its existing reports and scripts stay reproducible.

#### macOS — Google Chrome and Chrome for Testing to both major-145 targets

Google's [official macOS package guidance](https://support.google.com/chrome/a/answer/9915669) provides the current Chrome package but not a trustworthy public archive of arbitrary historical branded Stable builds. The actual Google Chrome row therefore uses the installed Stable `151.0.7922.75` executable with a new isolated source profile. Historical major coverage remains explicitly labeled Chrome for Testing and must not be represented as branded Google Chrome evidence. The managed-target cells are from the 2026-08-06 run; the Cloak-target Chrome for Testing cells reuse the sequential 2026-08-05 report under the central legacy evidence link.

| Source profile | CFT 145 opened | CFT 145 marker | CFT 145 close | Cloak 145 opened | Cloak 145 marker | Cloak 145 close |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Google Chrome `151.0.7922.75` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `113.0.5672.63` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `115.0.5790.170` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `120.0.6099.109` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `125.0.6422.141` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `130.0.6723.116` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `135.0.7049.114` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `140.0.7339.207` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `141.0.7390.122` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `142.0.7444.175` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `143.0.7499.192` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `144.0.7559.133` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `145.0.7632.6` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Chrome for Testing `146.0.7680.165` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `147.0.7727.15` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `148.0.7778.96` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `149.0.7827.55` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `150.0.7871.49` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Chrome for Testing `150.0.7871.124` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

The runnable evidence is consistent across both targets: sources through major 145 opened and preserved the marker, while tested newer-major sources did not downgrade into either target. Major 120 remains unresolved because both tested official source builds crashed before source-profile creation on this host. This is observed format behavior, not a Chromium compatibility guarantee.

#### macOS — Brave to both major-145 targets

The three historical sources came from [official Brave GitHub releases](https://github.com/brave/brave-browser/releases) and matched their upstream SHA-256 files; each extracted app also passed deep/strict code-signature verification for Brave team `KL8N8XSYF4`. The [official Brave release schedule](https://github.com/brave/brave-browser/wiki/Brave-Release-Schedule) provides the Brave-to-Chromium major mapping. The current Brave row used the installed executable with a new isolated unauthenticated profile.

| Source profile | CFT 145 opened | CFT 145 marker | CFT 145 close | Cloak 145 opened | Cloak 145 marker | Cloak 145 close |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Brave `1.85.120` / Chromium `143.0.7499.192` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brave release on Chromium `144` (exact artifact pending) | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave `1.87.192` / Chromium `145.0.7632.160` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Brave `1.88.138` / Chromium `146.0.7680.178` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| Brave `1.92.140` / Chromium `150.0.7871.125` | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

Brave reproduces the same observed major boundary as Chrome for Testing for these anchors. The isolated roots wrote `Last Version` values `143.1.85.120`, `145.1.87.192`, `146.1.88.138`, and `150.1.92.140`, so production can identify the tested Chromium major without reading `Local State` or another browser-state file. Setup now experimentally admits only the observed macOS Brave 143 and 145 source majors into either pinned major-145 target; Brave 146, Brave 150, unknown versions, and every Windows combination fail before copy.

#### macOS — Arc to both major-145 targets

Official Arc archives `1.129.0` / Chromium `143.0.7499.194`, `1.137.0` / Chromium `145.0.7632.160`, and `1.140.0` / Chromium `146.0.7680.165` passed deep/strict code-signature verification for The Browser Company team `S6N382Y83G`; the Chromium mappings match the [official Arc macOS release notes](https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2024-2026-Release-Notes). The installed Arc `1.156.0` reported Chromium `150.0.7871.125`. Arc ignored Chromium's `--user-data-dir` switch and continued to identify its standard profile path. Redirecting only Arc's Foundation home created a separate hidden Application Support tree, but a fresh Arc home exposed a mandatory sign-in window with no clean-profile skip and did not create an automation-ready `Default` context. No credential was entered, no account was created, and no existing Arc profile was copied.

The attempts that touched Arc's standard profile path were discarded as invalid evidence. They are not counted as source or target results. Every target cell therefore remains pending rather than failed.

| Source candidate | CFT 145 opened | CFT 145 marker | CFT 145 close | Cloak 145 opened | Cloak 145 marker | Cloak 145 close |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| Arc `1.129.0` / Chromium `143.0.7499.194` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc `1.137.0` / Chromium `145.0.7632.160` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc `1.140.0` / Chromium `146.0.7680.165` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc `1.156.0` / Chromium `150.0.7871.125` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

Arc can be researched again only with a safely isolated, user-authorized Arc profile that is already past mandatory sign-in. Tokenless must not automate Arc login, copy the user's ordinary Arc profile implicitly, or weaken this prerequisite merely to fill the matrix. Regardless of that future experiment, Arc is explicitly excluded from the v1 setup import source list and is not an open support requirement.

### Experimental macOS importability observations (2026-08-05)

The following broader research matrix ran on `darwin-arm64` with real headed browsers, the real Google network, production opaque-copy code, native target credential storage, enabled Chromium sandboxing, and sequential cleanup. Cloak targets were no-key artifact `145.0.7632.109.2` (browser `145.0.7632.109`) and keyed Pro artifact `150.0.7871.114.3` (browser `150.0.7871.114`) through JavaScript wrapper `0.5.4`. Pro/free licensing and the Cloak 150 artifact remain outside the supported Tokenless catalog. Chrome for Testing, Chromium, and native Cloak rows measure format behavior only; the shipping import UI and copy boundary accept Google Chrome sources only.

Each target has its own matrix so every outcome cell represents one observable criterion. ✅ means the criterion was observed. ❌ means the criterion was not reached because the target exited with `SIGTRAP` before returning a context; for marker preservation and clean close, it does not independently prove marker loss or a cleanup defect.

#### macOS — Cloak 145 target

| Source profile | Opened | History marker preserved | Clean close |
| --- | :---: | :---: | :---: |
| Chrome for Testing `113.0.5672.63` | ✅ | ✅ | ✅ |
| Chrome for Testing `115.0.5790.170` | ✅ | ✅ | ✅ |
| Chrome for Testing `125.0.6422.141` | ✅ | ✅ | ✅ |
| Chrome for Testing `130.0.6723.116` | ✅ | ✅ | ✅ |
| Chrome for Testing `135.0.7049.114` | ✅ | ✅ | ✅ |
| Chrome for Testing `140.0.7339.207` | ✅ | ✅ | ✅ |
| Chrome for Testing `141.0.7390.122` | ✅ | ✅ | ✅ |
| Chrome for Testing `142.0.7444.175` | ✅ | ✅ | ✅ |
| Chrome for Testing `143.0.7499.192` | ✅ | ✅ | ✅ |
| Chrome for Testing `144.0.7559.133` | ✅ | ✅ | ✅ |
| Chrome for Testing `145.0.7632.6` | ✅ | ✅ | ✅ |
| Chromium `145.0.7632.159` | ✅ | ✅ | ✅ |
| Chrome for Testing `146.0.7680.165` | ❌ | ❌ | ❌ |
| Chrome for Testing `147.0.7727.15` | ❌ | ❌ | ❌ |
| Chrome for Testing `148.0.7778.96` | ❌ | ❌ | ❌ |
| Chrome for Testing `149.0.7827.55` | ❌ | ❌ | ❌ |
| Chrome for Testing `150.0.7871.49` | ❌ | ❌ | ❌ |
| Chrome for Testing `150.0.7871.124` | ❌ | ❌ | ❌ |
| Cloak `150.0.7871.114` native source | ❌ | ❌ | ❌ |

#### macOS — Cloak 150 target (experimental keyed build)

| Source profile | Opened | History marker preserved | Clean close |
| --- | :---: | :---: | :---: |
| Chrome for Testing `113.0.5672.63` | ✅ | ✅ | ✅ |
| Chrome for Testing `115.0.5790.170` | ✅ | ✅ | ✅ |
| Chrome for Testing `125.0.6422.141` | ✅ | ✅ | ✅ |
| Chrome for Testing `130.0.6723.116` | ✅ | ✅ | ✅ |
| Chrome for Testing `135.0.7049.114` | ✅ | ✅ | ✅ |
| Chrome for Testing `140.0.7339.207` | ✅ | ✅ | ✅ |
| Chrome for Testing `141.0.7390.122` | ✅ | ✅ | ✅ |
| Chrome for Testing `142.0.7444.175` | ✅ | ✅ | ✅ |
| Chrome for Testing `143.0.7499.192` | ✅ | ✅ | ✅ |
| Chrome for Testing `144.0.7559.133` | ✅ | ✅ | ✅ |
| Chrome for Testing `145.0.7632.6` | ✅ | ✅ | ✅ |
| Chromium `145.0.7632.159` | ✅ | ✅ | ✅ |
| Chrome for Testing `146.0.7680.165` | ✅ | ✅ | ✅ |
| Chrome for Testing `147.0.7727.15` | ✅ | ✅ | ✅ |
| Chrome for Testing `148.0.7778.96` | ✅ | ✅ | ✅ |
| Chrome for Testing `149.0.7827.55` | ✅ | ✅ | ✅ |
| Chrome for Testing `150.0.7871.49` | ❌ | ❌ | ❌ |
| Chrome for Testing `150.0.7871.124` | ❌ | ❌ | ❌ |
| Cloak `150.0.7871.114` native source | ✅ | ✅ | ✅ |

Chrome for Testing 120 is intentionally absent from both matrices: official builds `120.0.6099.71` and `120.0.6099.109` exited with `SIGSEGV`/139 before a source profile could be created on this host, so no target criterion was exercised. The existing full Chrome `150.0.7871.187` opaque copy is also kept outside the marker matrices because user history was intentionally not inspected: it exited with `SIGTRAP` before context in Cloak 145, and the previously tested full, profile-only, and tab-restore-stripped Cloak 150 variants did the same; the decisive stripped case started and ended with `active: 0`.

### Windows importability observations — pending

No profile-importability result in this document was produced on Windows. The production Windows catalog currently downloads the official Cloak `146.0.7680.177.5` artifact (browser `146.0.7680.177`) after explicit user selection; it does not bundle Cloak in Tokenless. The macOS matrices above must not be used as evidence for Windows admission decisions.

Run the same opaque profile importability runbook on `win32-x64` against both pinned targets before changing the Windows compatibility policy. The exact source executable version, architecture, and archive provenance must be recorded for every case. ⏳ means the criterion has not been exercised on Windows; it is neither a pass nor a failure.

| Windows source candidate | Isolated source + marker | CFT 146 opened | CFT 146 marker | CFT 146 close | Cloak 146 opened | Cloak 146 marker | Cloak 146 close |
| --- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| Google Chrome, exact installed major below `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Google Chrome, exact installed major `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Google Chrome, exact installed major above `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `143.0.7499.192` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `145.0.7632.6` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `146.0.7680.165` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `147.0.7727.15` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Chrome for Testing `150.0.7871.124` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave `1.85.120` / Chromium `143` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave release on Chromium `144` (exact artifact pending) | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave `1.87.192` / Chromium `145` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave `1.88.138` / Chromium `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Brave current stable above Chromium `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc candidate on Chromium `143` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc candidate on Chromium `145` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc candidate on Chromium `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |
| Arc current stable above Chromium `146` | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ | ⏳ |

The branded Google Chrome rows require real installed builds or vendor-controlled enterprise rollback media; Chrome for Testing must not be relabeled as branded Chrome. The Arc rows also require an isolated source path that does not reuse the user's ordinary Arc profile or automate account login. The Brave rows are required evidence before any Windows Brave admission can be enabled. Arc rows remain research-only and cannot broaden the shipping import policy.

Keep each platform's evidence and admission policy independent.

Additional observations and limits:

- A separately user-prepared Chrome for Testing `145.0.7632.6` profile also copied 258 opaque files into Cloak 145 and opened a visible window. Account and login state were not inspected.
- Eighteen anonymous Chrome/Chromium source profiles recorded exactly one unique Google URL in their visible History UI before copy. All 28 successful Chrome/Chromium copied targets preserved that marker and closed cleanly; the same-runtime Cloak 150 control did as well, bringing the expanded automated target ledger to 29 successes and 10 pre-context `SIGTRAP` failures.
- The contiguous 140–145 source range opened in Cloak 145, while 146–150 did not. Cloak 150 opened every runnable Chrome/Chromium source tested in the 113–149 range; major 120 could not be exercised because two official Chrome for Testing 120 builds crashed directly on the host before profile creation.
- Ordinary Chrome/Chromium source searches returned HTTP 200 at Google `/sorry/index`; the native Cloak 150 source returned HTTP 200 at `/search`. These are network observations only and make no CAPTCHA-bypass claim.
- Every successful Cloak 150 context closed cleanly and its free-tier seat returned to `active: 0` before the next case. Earlier stale-seat observations explain prior exit-code-76 noise but do not explain these `SIGTRAP` results.
- A clean Chrome for Testing 150 profile with one history item failed, as did the previously tab-restore-stripped Chrome 150 copy. Profile size, restored tabs, login state, and a source patch newer than the target are therefore not necessary for the Chrome/CFT 150 failure.
- The observed boundary is not simply "same major works": Cloak 145 accepted the tested runnable sources through major 145 and rejected newer majors, while Cloak 150 accepted every runnable Chrome/Chromium source tested through 149 plus its own native 150 profile but rejected the tested Chrome/Chrome for Testing 150 profiles on both sides of target patch `.114`.
- Chrome for Testing 143 succeeding does not prove that every older Chrome version works. The older 113, 115, 125, 130, and 135 anchors increase confidence in long upgrade paths, but untested majors and patches remain unproven, pre-Chrome-for-Testing releases are outside this runbook, and major 120 is explicitly unresolved on this host.
- The evidence does not identify the crashing file or prove a Chromium guarantee. The opaque-profile rule intentionally prevents file-by-file inspection, and successful history migration does not prove macOS Keychain-encrypted login portability.
- Keep production admission fail-closed to the explicit platform/source/target matrix in this document. The macOS evidence supports only Chrome 145 and Brave 143/145 into the two locked major-145 targets; it does not establish Brave 144, any other source major, Windows compatibility with either locked major-146 target, or login portability. Experimental successes outside the shipping rows must not silently broaden setup eligibility.

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
- [x] Add experimental, explicit-consent opaque Google Chrome/Brave profile copying into a new managed Chrome for Testing 145 or CloakBrowser 145 profile while keeping clean creation as the default and unsupported-browser, platform, target, unconsented, unsafe-destination, symlink, and source-version mismatch paths fail-closed.

### Milestone 3: Setup and daemon integration

- [x] Keep system and cached runtime discovery available for diagnostics and legacy/advanced explicit configuration.
- [x] Make new setup and `auto` deterministically select the platform-pinned managed Chrome for Testing while keeping explicit legacy system-browser choices fail-closed.
- [x] Add `--no-browser-download` and localized English/Chinese setup messages.
- [x] Complete installation and profile selection before starting the daemon.
- [x] Persist config only after runtime and profile verification succeed.
- [x] Make the daemon resolve the profile-bound runtime without downloading or reselecting.

### Milestone 3A: Safe Chromium profile inventory

- [x] Replace `Local State`-based setup discovery with directory-only profile enumeration that cannot read account or browser-secret fields.
- [x] Keep safe diagnostic discovery for known Chrome, Brave, Edge, Chromium, and Chrome for Testing roots on supported macOS and Windows platforms while admitting only the explicit macOS Chrome/Brave shipping rows to profile import.
- [x] Map every candidate to its safe profile `Last Version`, falling back to the exact owning installed-browser version when needed; never infer Chrome's version for another Chromium browser.
- [x] Classify Google Chrome and Brave candidates against both production managed targets and present eligible and ineligible results in equivalent English and Simplified Chinese output, including the official CloakBrowser reference and experimental-import disclosure.
- [x] Add one safe setup profile-source choice containing `Start clean` plus eligible local Google Chrome/Brave sources, with an explicit source-browser selector for custom roots; selection authorizes only an opaque copy and never authentication-value inspection.

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

Windows AMD64 execution for the following gates is specified and recorded in the active [Windows AMD64 Browser Runtime, Surface, and Fallback Acceptance Test Plan](P0-windows-amd64-cloak-setup-acceptance-test-plan.md). The Intel setup/runtime gate remains tracked only in this parent roadmap.

- [x] macOS Apple Silicon: the revised built-CLI browser-runtime gate proved `auto` installs or reuses and launches managed Chrome for Testing 145 even when supported system browsers are present.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed download, checksum, extraction, version, sandboxed smoke launch, atomic cache commit, profile binding, and doctor inspection for managed Chrome for Testing `145.0.7632.6`.
- [x] macOS Apple Silicon: the direct manager and built-CLI gates completed the same install, repair, profile-binding, and doctor checks for Cloak `145.0.7632.109.2`; the production daemon resolved and launched that exact runtime, while authenticated built-CLI provider closure remains pending below.
- [x] macOS Apple Silicon: an unauthenticated managed Chrome for Testing `145.0.7632.6` profile copied through the production opaque boundary, opened in both managed Chrome for Testing 145 and Cloak 145, preserved its visible history marker, and closed cleanly.
- [x] macOS Apple Silicon: Chrome for Testing source anchors through major 145 opened in both major-145 targets while tested 146-150 sources did not; isolated Brave 143 and 145 sources passed both targets while Brave 146 and 150 did not. The isolated Google Chrome 151 source also failed both downgrade targets before context.
- [x] Arc is explicitly excluded from v1 setup import: the source browser is absent from the selector and the built CLI rejects `--import-browser arc` before copy. The unexercised Arc format experiment is research-only because Arc ignores `--user-data-dir` and a safely redirected fresh Arc home requires account sign-in.
- [ ] macOS Apple Silicon: establish Brave 144 source behavior against both major-145 targets before considering it eligible; interpolation from Brave 143 and 145 is not sufficient.
- [ ] macOS Apple Silicon: after explicit user login and native Keychain approval, verify that Brave 143 and Brave 145 sign-in state—not only visible History—remains usable in both managed Chrome for Testing 145 and Cloak 145, with clean browser shutdown after every case.
- [ ] Windows x64 on Intel hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 on AMD hardware: system, managed, and Cloak paths pass the same setup/runtime checks.
- [ ] Windows x64 on AMD hardware: Cloak 146 passes the complete public-provider surface matrix in both headed and headless modes.
- [ ] Windows x64 on AMD hardware: system Chrome and managed Chrome for Testing complete headed and headless observations, and naturally observed provider failures are cleared by isolated Cloak fallback profiles.
- [ ] Windows x64: every surface attempt writes evidence before assertion; no required provider is skipped or internally retried, and no fixture, interception, simulation, profile reuse, automated login, or challenge interaction is used.
- [ ] Windows x64: an unauthenticated managed Chrome for Testing `146.0.7680.165` profile passes the same importability criteria in both managed Chrome for Testing 146 and Cloak 146.
- [ ] Windows x64: Brave 143 and Brave 145 isolated profiles are tested against both managed Chrome for Testing 146 and Cloak 146 before any Windows Brave source is admitted.
- [ ] Windows x64 with a real Chrome 150 profile: setup lists only safe directory/version metadata, classifies it as non-aligned with Cloak 146, offers a clean Cloak profile instead of import, and leaves the source profile unchanged.
- [ ] macOS Intel: the built CLI installs, verifies, smoke-launches, binds, and reuses Cloak `145.0.7632.109.2` on a real x64 host.
- [ ] Linux x64: the built CLI installs, verifies, smoke-launches, binds, and reuses Cloak `146.0.7680.177.5` on a real host, including WSL x64 as a named environment.
- [ ] Linux arm64: the built CLI installs, verifies, smoke-launches, binds, and reuses Cloak `146.0.7680.177.3` on a real host.
- [x] Offline-style rerun with downloads disabled reused the previously verified managed Chrome for Testing runtime and performed no download.
- [x] Corrupted managed-cache checksum or browser-version metadata fails closed without changing config or the profile registry.
- [x] Built-CLI profile open preserves the exact `profile_runtime_mismatch` and `profile_browser_downgrade_blocked` errors and fails without changing config, registry, or profile-directory contents.
- [x] Post-download checksum mismatch, an archive containing unsafe paths, and an artifact whose executable reports the wrong version fail in the shared production verifier before cache commit or config/profile mutation.
- [x] Test-only installer and surface gates remained keychain-neutral, production Cloak launched without a Keychain prompt, sandboxing stayed enabled, and spawned processes were cleaned up.
- [ ] Built-CLI real-provider gates run against ChatGPT, Claude, Gemini, Qwen, DeepSeek, Grok, Grok Cloud, and Google surfaces using system, managed, and Cloak runtimes where the selected profile is authenticated.
- [x] macOS CAPTCHA/challenge outcomes are recorded for system Chrome, managed Chrome for Testing, and Cloak; the evidence is explicitly observational and does not claim guaranteed CAPTCHA bypass.
- [x] macOS Apple Silicon: Cloak `145.0.7632.109` headless reached every enabled public provider surface and normal Google Search through a disposable keychain-neutral profile with no detected challenge or HTTP rejection.
- [x] macOS Apple Silicon: system Chrome `151.0.7922.75` headless produced real provider-side HTTP/Cloudflare failures, after which an isolated Cloak 145 headless fallback attempt cleared every provider failure without profile reuse, fixture routing, interception, retry, or skip. Google remains a recorded anti-bot control rather than a provider-fallback acceptance target.

### Evidence recorded through 2026-08-09

- Official CloakBrowser GitHub release metadata and `SHA256SUMS` establish the five pinned no-license-key artifacts. The upstream wrapper's platform map and executable resolver independently establish `Chromium.app/Contents/MacOS/Chromium` on macOS, `chrome` on Linux, and `chrome.exe` on Windows. This is catalog/layout evidence only; Intel macOS and Linux real-host launch/provider gates remain open.

- The browser surface matrix used system Chrome `150.0.7871.187`, managed Chrome for Testing `145.0.7632.6`, and Cloak `145.0.7632.109.2` with Playwright, real headed browser processes, keychain-neutral isolated test profiles, the real provider network, and no observer process.
- In each Cloak run, ChatGPT, Claude, Gemini, Grok Cloud, Qwen, and DeepSeek completed navigation with real HTTP responses and no detected reCAPTCHA, Cloudflare, hCaptcha, or verification-title challenge.
- In the repeatable sequential comparison, system Chrome reached a Claude Cloudflare interstitial, a DeepSeek Human Verification page, and Google `/sorry/`; managed Chrome for Testing reached Google `/sorry/`; Cloak reached the normal provider surfaces and Google Search. Cloak returned HTTP 200 search results with no detected challenge in three consecutive runs, including runs after both other runtimes had been blocked.
- The headless surface gate now accepts an explicit browser visibility and records one JSON result under `test-results/live-browser-surfaces/` before assertion. A strict Cloak-only run completed all ten enabled provider surfaces plus Google Search with no provider failure or Google control failure. The gate treats provider HTTP status 400 or higher as failure even when no known challenge selector or title is present.
- The explicit Chrome-to-Cloak headless fallback gate requires the primary browser to exhibit at least one real provider failure, launches the fallback in a separate disposable profile, and fails unless the fallback clears every provider failure. The passing run recorded Chrome 151 Cloudflare/HTTP failures on ChatGPT, Claude, DeepSeek, and Perplexity; Cloak 145 cleared all four. Google `/sorry/` is retained separately as control evidence because an IP-associated Google challenge may survive a browser change and cannot establish provider fallback behavior.
- The built CLI and production daemon successfully resolved and launched the exact profile-bound Cloak runtime. A subsequent durable `auth.status` job timed out in the provider action scheduler, so this evidence does not close authenticated provider actions, prompt submission, or response generation.
- The official Windows x64 Chrome for Testing `146.0.7680.165` archive was downloaded on macOS for static verification, matched catalog SHA-256 `65d1d4d993da8b24fc871f59f7c8100ffc3719afd58cbf843d81d6ada9bc9880`, and contained `chrome-win64/chrome.exe`. The Cloak `146.0.7680.177.5` archive had already received the same static layout/checksum verification. This is artifact evidence only and does not replace Windows launch or profile-importability acceptance.
- The 2026-08-06 source-family run centralized its official Arc and Brave archives, extracted bundles, scripts, and reports under `~/.tokenless/experimental/browser-importability/` without installing any downloaded app into an Applications directory. Brave 143 and 145 profiles opened, preserved their marker, and closed in both major-145 targets; Brave 146 and 150 and isolated Google Chrome 151 copies exited with `SIGTRAP` before context in both targets. Chrome for Testing produced the same through-145 versus newer-than-145 boundary against managed Chrome for Testing 145 as the prior Cloak 145 matrix.
- Arc's direct Playwright pipe launch timed out, while explicit localhost CDP proved the archived executables' Chromium versions and visible History behavior. Those CDP sessions were not isolated because Arc ignored `--user-data-dir`, so every resulting copy attempt was discarded. A Foundation-home redirect created a separate hidden Arc Application Support tree but exposed mandatory account sign-in instead of an automation-ready profile; no credentials were entered and the ordinary Arc profile was not admitted as test evidence.
- Historical behavior resolved `auto` to an installed system browser when available. The managed-only new-setup decision supersedes that behavior; system runtime discovery remains only for existing or advanced explicit configurations.
- The revised built-CLI browser-runtime gate ran on Apple Silicon macOS with supported system browsers installed and still resolved `auto` to managed Chrome for Testing `145.0.7632.6`. It completed the real download/checksum/extraction/version/sandboxed-launch transaction, profile binding, doctor inspection, cache reuse, repair, daemon reconciliation, and child-process cleanup in 105 seconds.
- An invalid local Anti-Detect setup check launched the production Cloak target instead of a keychain-neutral E2E target and triggered a macOS Keychain prompt. The user selected Deny, the browser and test daemon were stopped, and that run was discarded. At that time, `e2eInspection` launches retained Playwright's `--password-store=basic` and `--use-mock-keychain` defaults, and subsequent focused runtime and surface gates completed without a prompt. The 2026-08-05 native credential-storage decision supersedes that mitigation for production and real-provider managed profiles; only explicitly disposable, unauthenticated test profiles remain keychain-neutral.
- The built-CLI browser-runtime gate mutated only its temporary verified Cloak cache and proved that mismatched checksum and browser-version manifest fields return `browser_runtime_cache_invalid` while config and the profile registry remain byte-for-byte unchanged.
- The same gate created real temporary registry profiles with mismatched and downgrade bindings, called `profiles open` through the built CLI and packaged daemon, received the exact domain errors, and proved that config, registry, and profile-directory contents remained unchanged. This gate exposed and fixed both generic `daemon_store_error` wrapping and a redundant same-value daemon URL write before it passed.
- The cross-platform Node launcher then reran the complete built-CLI browser-runtime gate successfully in 69 seconds. The checked-in npm release-gate commands no longer depend on POSIX-only `VAR=value command` syntax; live Windows execution remains required before declaring Windows support.
- The same launcher attempted a fresh Cloak-only surface gate. The suite failed without retry at Qwen navigation because the machine's active DNS resolver returned Qwen's CNAME but no final address (`ERR_NAME_NOT_RESOLVED`). Qwen's official page and public DNS still identified `https://chat.qwen.ai/` and resolved its current addresses, so the endpoint was not changed and no test-only DNS override was introduced. This run is recorded as failed external-prerequisite evidence, not as provider or CAPTCHA acceptance.
- A gate audit found that provider challenge outcomes were recorded but not asserted. The surface gate now fails when any enabled provider renders a detected reCAPTCHA, Cloudflare, hCaptcha, or verification-title challenge; navigation success alone can no longer produce a false pass.
- Historical evidence before the Intel macOS catalog entry landed: a checksum-verified official Node.js `v22.13.1` `darwin-x64` binary ran under Rosetta and the built CLI rejected `install --browser cloak` before mutation. That unsupported-platform result is superseded and does not count as positive Intel macOS acceptance.
- After the system resolver recovered, the stricter Cloak-only surface gate passed with Cloak browser `145.0.7632.109`: ChatGPT, Claude, Gemini, Grok Cloud, Qwen, and DeepSeek all completed real navigation with no detected challenge, and Google rendered search results with no reCAPTCHA signal.
- A fresh full matrix then visited every enabled provider and Google before evaluating each runtime. System Chrome `150.0.7871.187` failed on the Claude Cloudflare interstitial and Google `/sorry`; managed Chrome for Testing `145.0.7632.6` recorded a Gemini navigation abort and Google `/sorry`; Cloak passed every surface again. The gate was corrected so an early provider failure can no longer prevent later providers or Google from being exercised, and a failed navigation that remains on the prior origin no longer misattributes the prior page's challenge to the next provider.
- The managed-artifact security integration called the same production verifier used immediately after a real download and before cache commit. With real tar.gz bytes, the real filesystem, the system `tar` executable, and a real version subprocess, it received exact `browser_runtime_checksum_mismatch`, `browser_runtime_archive_unsafe`, and `browser_runtime_version_mismatch` errors. The checksum case created no payload, the unsafe entry escaped nowhere, and config/profile sentinel files remained byte-for-byte unchanged in all three cases. The complete built-CLI browser-runtime gate passed again in 75 seconds after this refactor, proving the official managed Chrome and Cloak positive install paths still work. A later targeted managed-browser surface rerun also visited every provider successfully and isolated its current blockers to the Claude Cloudflare interstitial and Google `/sorry`.
- The current selected user profile is bound to system Chrome rather than Cloak, and `doctor` reports no usable provider readiness observations for ChatGPT, Claude, Gemini, or Grok. Tokenless must not silently switch that profile or automate provider login. Authenticated cross-runtime closure therefore requires the user to explicitly select a clean runtime-bound profile, sign in visibly, and then invoke the manual provider gates.
- The official release list now also exposes Cloak Pro Chromium 150 builds for macOS and Windows, but obtaining the current Pro binary requires a Cloak key. The current Tokenless scope remains the no-license-key catalog pins above; Pro 150 is not silently added to the supported set. See the [official CloakBrowser releases](https://github.com/CloakHQ/CloakBrowser/releases).
- Historical diagnostic evidence: the built CLI's real filesystem inventory found the current macOS Chromium-family profile roots without parsing `Local State`. Chrome `150.0.7871.127` and Chrome for Testing `147.0.7727.15` were non-aligned; Chromium `145.0.7632.109` matched the macOS Cloak version, and Edge had no standard persistent profile directory to list. The current evidence-bound policy supersedes that former exact-version classification: only the explicit macOS Chrome 145 and Brave 143/145 rows can be eligible, while every other browser identity or combination remains fail-closed.
- Historical evidence: a real interactive built-CLI setup used an isolated Tokenless home, selected Anti-Detect, displayed the official project link, exact Cloak/Chromium pin, all discovered candidate classifications, and the former second clean-profile confirmation. Declining returned `setup_cloak_profile_declined` before mutation. That redundant second confirmation has since been superseded by the installation disclosure in the initial Anti-Detect question and the single profile-source choice.
- The focused built-CLI filesystem integration passed with real `Default` and `Profile 1` directories, an exact aligned `Last Version`, a mismatched Chromium 150 version, and deliberately invalid `Local State` contents. It classified both versions correctly and succeeded without parsing the invalid browser-state file.
- Historical evidence: the former positive interactive path accepted both Anti-Detect confirmations in an isolated home, reused the checksum-verified Cloak cache with downloads disabled, reported exact Cloak browser `145.0.7632.109`, and reached provider/profile selection. The current flow removes the redundant second confirmation. A separate built-CLI clean-profile boundary against that exact cache created a ready default profile bound to runtime `cloak:darwin-arm64:145.0.7632.109.2`, family/browser `cloak`, and created-with version `145.0.7632.109`.
- The non-interactive built-CLI contract now proves that a saved Cloak preference alone fails with `setup_cloak_confirmation_required` before runtime/profile mutation, while explicit `--anti-detect` passes consent handling and reaches the expected runtime ensure boundary. The same contract proves that incomplete two- or three-component `Last Version` metadata is `unknown` rather than a false non-aligned result.

## Release Gate

This roadmap remains in progress until every supported-platform path is implemented and the real-boundary acceptance evidence is complete. A macOS-only proof may advance the implementation but cannot establish Windows support. Prototype scripts, fixture checks, source-string assertions, or a browser opening a page are development evidence only and cannot replace built-CLI setup, daemon, profile, and real-provider verification.

No Cloak binary may be included in npm packages, installers, GitHub release artifacts, or repository history. No release may claim general profile portability across runtime families, guaranteed authentication-state migration, or CAPTCHA bypass. No-license-key support must remain distinct from upstream Pro/keyed builds. The release must instead state the exact supported platforms, locked managed-runtime versions, profile-copy admission rules, clean-profile isolation behavior, and observed provider evidence.
