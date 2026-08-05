# Windows AMD64 Cloak Setup Acceptance Test Plan

Status: ready for execution | Priority: P0 | Last reviewed: 2026-08-01

Type: active real-boundary test plan

Tracks: [Browser Runtime Selection and Cloak Integration](P0-browser-runtime-selection-and-cloak.md)

## Objective

Prove the complete Anti-Detect setup path on a clean Windows AMD x86-64 system using the built Tokenless CLI, the official locked CloakBrowser artifact, real browser profile roots, the real filesystem, and real browser processes.

This plan verifies setup behavior and records release evidence. It does not add browser support, import a source browser profile, automate browser login, or claim CAPTCHA bypass. The implementation is complete enough to begin this plan, but Windows support remains unaccepted until the exit criteria below pass.

## Supported Test Baseline

| Item | Locked expectation |
| --- | --- |
| Operating system | Current supported Windows 10 or Windows 11 x64 |
| CPU coverage | AMD x86-64 (`AMD64` hardware, Node `x64`) |
| Tokenless Cloak artifact | `146.0.7680.177.5` |
| Cloak Chromium version | `146.0.7680.177` |
| Cloak source | [Official CloakBrowser release](https://github.com/CloakHQ/CloakBrowser/releases/tag/chromium-v146.0.7680.177.5) |
| Tokenless delivery | User-approved setup download into the private Tokenless cache; never bundled in Tokenless artifacts |
| Playwright role | Existing browser-control layer using the exact resolved Cloak executable |

This plan is deliberately AMD-only. AMD64 is the 64-bit x86 architecture and resolves to the Tokenless `win32-x64` catalog entry. Windows ARM64, 32-bit Windows x86, and independent Intel-hardware certification are outside this test plan.

## Source Browser Matrix

Each version case uses a blank source browser profile and a fresh Tokenless home. The 145 and 150 cases are deliberate negative alignment tests against Windows Cloak Chromium `146.0.7680.177`.

| Case | Source browser | Product version | Underlying Chromium | Expected setup classification |
| --- | --- | --- | --- | --- |
| `WIN-CLOAK-CHROME-150` | Google Chrome | A real `150.0.7871.x` build | `150.0.7871.x` | `not version-aligned` |
| `WIN-CLOAK-CHROME-145` | Google Chrome | Prefer `145.0.7632.160` | `145.0.7632.160` | `not version-aligned` |
| `WIN-CLOAK-EXACT-146` | Chrome or Chromium | Exact build | `146.0.7680.177` | `version-aligned (reference only)` |
| `WIN-CLOAK-PATCH-MISMATCH` | Chrome or Chromium | Exact patch-mismatch build | `146.0.7680.178` | `not version-aligned` |

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
| Chromium | `%LOCALAPPDATA%\Chromium\User Data` |

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
2. The Anti-Detect question states that accepting will download and install the verified platform-pinned CloakBrowser when needed; no later installation confirmation appears.
3. Setup identifies and links to CloakBrowser and reports artifact `146.0.7680.177.5` with Chromium `146.0.7680.177`.
4. Setup lists every safely discovered profile candidate with `aligned`, `not_aligned`, or `unknown` compatibility.
5. If aligned candidates exist, one choice offers `Start clean` and only the aligned profile sources. Selecting a profile explicitly authorizes its opaque copy; there are no separate import or copy-consent questions. If none align, setup uses a clean profile without asking.
6. Setup downloads the official artifact when absent, verifies SHA-256, safely extracts it, verifies the executable-reported version, commits the private cache atomically, and creates a managed profile bound to the exact Cloak runtime.
7. A selected source profile is version-checked again at the copy boundary and copied only as an opaque filesystem tree without inspecting authentication values.
8. Setup continues to provider selection and visible sign-in review.
9. `doctor --json` reports the exact verified runtime, expected and actual versions, cache/checksum state, and profile runtime binding.

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

## AMD64 Hardware Run

- [ ] Build and package boundaries complete on a clean Windows AMD x86-64 host.
- [ ] Official Cloak download, checksum, extraction, version verification, cache commit, clean profile binding, launch, doctor, and cleanup pass.
- [ ] Chrome 150, exact 146, and patch-mismatch classifications pass.

### Complete Version Matrix

- [ ] Chrome 150 is non-aligned.
- [ ] Chrome 145 is non-aligned.
- [ ] Exact Chromium `146.0.7680.177` is aligned for reference only.
- [ ] Chromium `146.0.7680.178` is non-aligned.
- [ ] Decline, cache-miss download, verified-cache reuse, and downloads-disabled failure paths pass.
- [ ] Source profile roots remain unimported and unmodified by Tokenless.

## Known Limitations to Observe

### One version per user-data root

Chrome-family profiles do not carry independent browser versions for this flow. One user-data root has one root-level `Last Version`, so `Default` and `Profile 1` cannot be classified as Chrome 145 and Chrome 150 independently when they share the same root. Use a clean VM snapshot or a separate blank root for version switching, and do not downgrade a real profile.

## Evidence Record

Append one dated subsection per machine and case. Record:

- Windows edition/build, `process.arch`, and confirmation that the CPU vendor is AMD;
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

1. the core Cloak setup/runtime path passes on Windows AMD x86-64 hardware;
2. every source-browser matrix classification is either passed or explicitly blocked only by unavailable official historical installation media;
3. exact 146 alignment and one-patch mismatch behavior are proven;
4. decline, fresh download, verified-cache reuse, and downloads-disabled failure paths are proven;
5. clean profile isolation, exact runtime binding, sandboxing, and process cleanup pass without source-profile access or mutation; and
6. the corresponding Windows gates in the parent browser-runtime roadmap are updated from the evidence here.

When all exit criteria pass, move this document to `docs/roadmaps/archived/`, update `docs/roadmaps/README.md`, and retain it as the permanent Windows acceptance record.
