# Windows Cloak Setup Acceptance Test Plan

Status: ready for execution | Priority: P0 | Last reviewed: 2026-08-01

Type: active real-boundary test plan

Tracks: [Browser Runtime Selection and Cloak Integration](P0-browser-runtime-selection-and-cloak.md)

## Objective

Prove the complete Anti-Detect setup path on clean Windows x64 systems using the built Tokenless CLI, the official locked CloakBrowser artifact, real browser profile roots, the real filesystem, and real browser processes.

This plan verifies setup behavior and records release evidence. It does not add browser support, import a source browser profile, automate browser login, or claim CAPTCHA bypass. The implementation is complete enough to begin this plan, but Windows support remains unaccepted until the exit criteria below pass.

## Supported Test Baseline

| Item | Locked expectation |
| --- | --- |
| Operating system | Current supported Windows 10 or Windows 11 x64 |
| CPU coverage | One Intel 64-bit machine and one AMD64 machine |
| Tokenless Cloak artifact | `146.0.7680.177.5` |
| Cloak Chromium version | `146.0.7680.177` |
| Cloak source | [Official CloakBrowser release](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5) |
| Tokenless delivery | User-approved setup download into the private Tokenless cache; never bundled in Tokenless artifacts |
| Playwright role | Existing browser-control layer using the exact resolved Cloak executable |

Windows ARM64 and 32-bit Windows x86 are outside this plan. Intel 64-bit and AMD64 both use the `win32-x64` catalog entry.

## Source Browser Matrix

Each version case uses a blank source browser profile and a fresh Tokenless home. The 145 and 150 cases are deliberate negative alignment tests against Windows Cloak Chromium `146.0.7680.177`.

| Case | Source browser | Product version | Underlying Chromium | Expected setup classification |
| --- | --- | --- | --- | --- |
| `WIN-CLOAK-CHROME-150` | Google Chrome | A real `150.0.7871.x` build | `150.0.7871.x` | `not version-aligned` |
| `WIN-CLOAK-CHROME-145` | Google Chrome | Prefer `145.0.7632.160` | `145.0.7632.160` | `not version-aligned` |
| `WIN-CLOAK-BRAVE-150` | Brave | [`1.92.144`](https://github.com/brave/brave-browser/releases/tag/v1.92.144) | `150.0.7871.186` | `not version-aligned` |
| `WIN-CLOAK-BRAVE-145` | Brave | [`1.87.192`](https://github.com/brave/brave-browser/releases/tag/v1.87.192) | `145.0.7632.160` | `not version-aligned` |
| `WIN-CLOAK-ARC-150` | Arc | `1.116.0` | `150.0.7871.182` | `not version-aligned` |
| `WIN-CLOAK-ARC-145` | Arc | `1.96.0` | `145.0.7632.160` | `not version-aligned` |
| `WIN-CLOAK-EXACT-146` | Chrome or Chromium | Exact build | `146.0.7680.177` | `version-aligned (reference only)` |
| `WIN-CLOAK-PATCH-MISMATCH` | Arc | `1.100.0` | `146.0.7680.178` | `not version-aligned` |

Arc mappings come from the [official Arc for Windows release notes](https://resources.arc.net/hc/en-us/articles/22513842649623-Arc-for-Windows-2023-2026-Release-Notes). Arc `1.94.1`, `1.95.0`, and `1.96.0` cover Chromium 145 patch levels `.76`, `.117`, and `.160`; Arc `1.114.0`, `1.115.0`, and `1.116.0` cover Chromium 150 patch levels `.115`, `.125`, and `.182`.

## Safety and Isolation Rules

- Use a blank, non-authenticated source browser profile. Do not test browser downgrades against a real signed-in profile.
- Close the source browser before inventory and setup so its root metadata is stable.
- Use a unique, initially absent `--home` directory for every case.
- Never inspect, export, copy, log, or compare cookies, tokens, passwords, browser storage, Keychain-equivalent state, account details, or source profile contents.
- Record only the browser identity, user-data root, `Default` or `Profile N` directory key, safe root-level `Last Version`, Tokenless result codes, managed-runtime metadata, and process outcome.
- Never download archived browsers from an untrusted third-party source. If an official old Windows build is unavailable, mark the version case blocked and use an existing official installation or a clean VM snapshot.
- Setup must leave every source browser profile untouched and must create a separate clean Cloak-bound managed profile.

## Standard Windows Roots

Interactive setup scans these standard roots:

| Browser | Root |
| --- | --- |
| Chrome | `%LOCALAPPDATA%\Google\Chrome\User Data` |
| Brave | `%LOCALAPPDATA%\BraveSoftware\Brave-Browser\User Data` |
| Arc package | `%LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_ttt1ap7aakyb4\LocalCache\Local\Arc\User Data` |
| Arc standalone | `%LOCALAPPDATA%\TheBrowserCompany\Arc\User Data` |

Only `Default` and `Profile N` directories are candidates. Setup reads the root-level `Last Version` file and does not parse `Local State`, `Preferences`, or any profile storage.

## Clean Execution Procedure

Run from a clean checkout in PowerShell:

```powershell
npm install
npm run build

$TokenlessCli = (Resolve-Path ".\packages\cli\dist\src\tokenless.mjs").Path
$CaseHome = "$env:LOCALAPPDATA\Tokenless-Test\WIN-CLOAK-CHROME-150"

node $TokenlessCli profiles discover --browser all --json
node $TokenlessCli setup --home $CaseHome --fresh
node $TokenlessCli doctor --home $CaseHome --json
```

Change `$CaseHome` to the case ID for every run. Never reuse a Tokenless home across cases.

For a diagnostic custom browser root, use one explicit browser:

```powershell
node $TokenlessCli profiles discover --browser chrome --browser-user-data-dir "C:\Browser-Test\Chrome150" --json
```

Custom-root discovery does not make that root part of interactive setup. Release acceptance must exercise the applicable standard root.

## Interactive Expectations

For each case:

1. Setup asks whether to use Anti-Detect mode. Select `Yes`.
2. Setup identifies and links to CloakBrowser and reports artifact `146.0.7680.177.5` with Chromium `146.0.7680.177`.
3. Setup lists every safely discovered profile candidate with `aligned`, `not_aligned`, or `unknown` compatibility.
4. Setup asks whether to continue with a clean CloakBrowser profile and explicitly states that listed profiles will not be imported.
5. Declining returns `setup_cloak_profile_declined` before Cloak download, cache creation, or managed-profile creation.
6. Accepting downloads the official artifact when absent, verifies SHA-256, safely extracts it, verifies the executable-reported version, commits the private cache atomically, and creates a clean managed profile bound to the exact Cloak runtime.
7. Setup continues to provider selection and visible sign-in review without reading source browser authentication state.
8. `doctor --json` reports the exact verified runtime, expected and actual versions, cache/checksum state, and profile runtime binding.

Equivalent English and Simplified Chinese prompt text is acceptable; the meaning and decisions must be identical.

## Per-Case Assertions

Every matrix case must prove:

- the expected standard root is found;
- only safe directory/version metadata is returned;
- every source profile under one root receives that root's safe version result;
- the expected exact compatibility classification is returned;
- no candidate is offered as an importable authentication profile;
- declining the second confirmation causes no managed-runtime or profile mutation;
- accepting it creates a separate clean Cloak-bound profile;
- the source browser root is not opened with Cloak and is not copied;
- the setup-selected executable is the verified cached `146.0.7680.177.5` artifact rather than a system Chromium;
- the managed Chromium sandbox remains enabled and all Tokenless-owned processes clean up normally.

The first cache-miss run must prove the download path. At least one later case must reuse the verified cache with `--no-browser-download`, and one deliberate missing-cache run with that flag must fail with `browser_runtime_download_required`.

## Hardware Runs

### Intel x64

- [ ] Build and package boundaries complete on a clean Intel Windows x64 host.
- [ ] Official Cloak download, checksum, extraction, version verification, cache commit, clean profile binding, launch, doctor, and cleanup pass.
- [ ] At least Chrome 150, one Brave case, one Arc case, exact 146, and patch-mismatch classifications pass.

### AMD64

- [ ] Build and package boundaries complete on a clean AMD Windows x64 host.
- [ ] Official Cloak download, checksum, extraction, version verification, cache commit, clean profile binding, launch, doctor, and cleanup pass.
- [ ] At least Chrome 150, one Brave case, one Arc case, exact 146, and patch-mismatch classifications pass.

### Complete Version Matrix

- [ ] Chrome 150 is non-aligned.
- [ ] Chrome 145 is non-aligned.
- [ ] Brave 150 is non-aligned.
- [ ] Brave 145 is non-aligned.
- [ ] Arc 150 is non-aligned.
- [ ] Arc 145 is non-aligned.
- [ ] Exact Chromium `146.0.7680.177` is aligned for reference only.
- [ ] Arc Chromium `146.0.7680.178` is non-aligned.
- [ ] Decline, cache-miss download, verified-cache reuse, and downloads-disabled failure paths pass.
- [ ] Source profile roots remain unimported and unmodified by Tokenless.

## Known Limitations to Observe

### One version per user-data root

Chrome-family profiles do not carry independent browser versions for this flow. One user-data root has one root-level `Last Version`, so `Default` and `Profile 1` cannot be classified as Chrome 145 and Chrome 150 independently when they share the same root. Use a clean VM snapshot or a separate blank root for version switching, and do not downgrade a real profile.

### Brave version semantics

Brave may store a product-shaped `Last Version`, such as `150.1.92.144`, instead of its underlying Chromium build. The 145 and 150 negative cases remain unambiguous against Cloak 146, but a Brave build whose underlying Chromium is exactly `146.0.7680.177` may be classified as a false negative. Record the observed safe value and result. Do not treat a Brave positive-alignment claim as closed until Tokenless can prove the owning Chromium build through a safe real boundary.

### Arc archived installers

The official release notes establish the product-to-Chromium mappings, but the current official installer may update to the latest Arc build. Exact historical cases require an existing official installation or clean VM snapshot; an unavailable trusted artifact blocks that individual case rather than authorizing a third-party download.

## Evidence Record

Append one dated subsection per machine and case. Record:

- Windows edition/build, `process.arch`, and CPU vendor class (`Intel` or `AMD`);
- Tokenless commit SHA and Node/npm versions;
- source browser product and safely reported version;
- standard root and candidate directory keys;
- setup compatibility result and confirmation path;
- Cloak source URL, expected artifact/browser versions, checksum outcome, and cache source;
- managed profile runtime binding and `doctor --json` result;
- launch, sandbox, cleanup, and exact failure-code outcomes; and
- pass, fail, or blocked with a concise reason.

Do not attach source profile contents, browser storage, credentials, full DOM, unrelated account information, or provider screenshots to this roadmap.

## Exit Criteria

This active test plan is complete only when:

1. the core Cloak setup/runtime path passes on both Intel x64 and AMD64 Windows hardware;
2. every source-browser matrix classification is either passed or explicitly blocked only by unavailable official historical installation media;
3. exact 146 alignment and one-patch mismatch behavior are proven;
4. decline, fresh download, verified-cache reuse, and downloads-disabled failure paths are proven;
5. clean profile isolation, exact runtime binding, sandboxing, and process cleanup pass without source-profile access or mutation; and
6. the corresponding Windows gates in the parent browser-runtime roadmap are updated from the evidence here.

When all exit criteria pass, move this document to `docs/roadmaps/archived/`, update `docs/roadmaps/README.md`, and retain it as the permanent Windows acceptance record.
