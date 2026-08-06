# Windows AMD64 Browser Runtime, Surface, and Fallback Acceptance Test Plan

Status: ready for execution | Priority: P0 | Last reviewed: 2026-08-06

Type: active real-boundary test plan

Tracks: [Browser Runtime Selection and Cloak Integration](P0-browser-runtime-selection-and-cloak.md)

## Objective

Prove the complete Windows AMD x86-64 browser path using the built Tokenless CLI, packaged daemon, real browser executables, real filesystems, real browser processes, and the real provider network.

Acceptance covers four distinct claims:

1. managed Chrome for Testing and Cloak install, verify, bind, launch, inspect, and clean up correctly;
2. Cloak reaches the public provider surface matrix in both headed and headless modes;
3. system Chrome and managed Chrome for Testing expose real challenge or HTTP-failure behavior without hiding, skipping, or retrying it; and
4. when a real provider failure occurs in Chrome, an isolated Cloak attempt clears every failed provider surface.

This plan does not automate browser login, claim guaranteed CAPTCHA bypass, or treat a public landing-page check as authenticated provider capability proof. Authenticated prompt, response, upload, citation, continuation, and Project gates remain separate manual release prerequisites.

## Required Host and Locked Runtimes

The full behavioral matrix must run on a named AMD x86-64 host. Node reports the platform as `win32-x64`; the evidence record must therefore confirm the processor manufacturer from Windows rather than inferring AMD hardware from `process.arch`.

| Item | Locked expectation |
| --- | --- |
| Operating system | A currently supported Windows 10 or Windows 11 x64 build |
| CPU coverage | Physical or dedicated-VM host backed by AMD x86-64 hardware (`AMD64`, Node `x64`) |
| Node runtime | Project-supported Node version; record exact version |
| Managed Chrome for Testing artifact | `146.0.7680.165` |
| Cloak artifact | `146.0.7680.177.5` |
| Cloak Chromium version | `146.0.7680.177` |
| System Chrome | Installed stable Chrome; record the exact product and Chromium version at execution time |
| Browser visibility | Both `headed` and `headless` |

This plan is deliberately AMD-only. Windows ARM64, 32-bit Windows x86, and independent Intel-hardware certification are outside its scope. A generic hosted CI label is not AMD evidence unless the actual host manufacturer is recorded and the browser/provider run is stable enough to satisfy every gate.

Record the host identity before execution:

```powershell
node -p "JSON.stringify({ platform: process.platform, arch: process.arch, node: process.version })"
Get-CimInstance Win32_Processor | Select-Object Manufacturer, Name, Architecture
Get-ComputerInfo | Select-Object WindowsProductName, WindowsVersion, OsBuildNumber
```

## Safety and Isolation Rules

- Use a blank, non-authenticated source browser profile for setup/importability checks. Never downgrade a real signed-in profile.
- Use a unique, initially absent Tokenless home for every setup case and a fresh disposable browser profile for every surface attempt.
- A primary Chrome attempt and its Cloak fallback must never share a user-data directory.
- Never inspect, export, copy, log, or compare cookies, tokens, passwords, browser storage, account details, or source profile contents.
- Record only safe browser identity/version metadata, result codes, managed-runtime metadata, requested surface URLs, final URLs, HTTP outcomes, detected challenge categories, and process outcomes.
- Never use fixtures, route interception, simulated responses, synthetic fetches, test accounts, automated login, or automated challenge interaction.
- An invoked suite runs every required case exactly once. It must not skip a provider, retry internally, or rerun until a desired challenge appears.
- Keep Chromium sandboxing enabled and prove that every Tokenless-owned browser and daemon process is cleaned up.

## Setup and Source-Version Matrix

Each case uses a blank source browser profile and a fresh Tokenless home. The 145 and 150 cases are deliberate negative alignment tests against Windows Cloak Chromium `146.0.7680.177`.

| Case | Source browser | Product version | Expected setup classification |
| --- | --- | --- | --- |
| `WIN-CLOAK-CHROME-150` | Google Chrome | A real `150.0.7871.x` build | `not version-aligned` |
| `WIN-CLOAK-CHROME-145` | Google Chrome | Prefer `145.0.7632.160` | `not version-aligned` |
| `WIN-CLOAK-EXACT-146` | Chrome or Chromium | Exact `146.0.7680.177` build | `version-aligned (reference only)` |
| `WIN-CLOAK-PATCH-MISMATCH` | Chrome or Chromium | Exact `146.0.7680.178` build | `not version-aligned` |

Interactive setup scans `%LOCALAPPDATA%\Google\Chrome\User Data` and `%LOCALAPPDATA%\Chromium\User Data`. Only `Default` and `Profile N` directories are candidates. Setup may read the safe root-level `Last Version`; it must not parse `Local State`, `Preferences`, or browser storage.

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

Change `$CaseHome` for every case and never reuse it. Release acceptance must exercise the applicable standard root; a custom root is diagnostic only.

Every setup case must prove:

- safe profile discovery and the expected exact compatibility classification;
- equivalent English and Simplified Chinese decisions;
- official artifact download, checksum, safe extraction, executable-reported version verification, and atomic cache commit;
- an exact runtime binding to a separate clean managed profile;
- no source-profile mutation or accidental opening with another runtime;
- a cache-miss download, verified-cache reuse with `--no-browser-download`, and missing-cache failure with `browser_runtime_download_required`;
- fail-closed behavior for checksum, archive-path, executable-version, profile-runtime, and downgrade mismatches; and
- enabled sandboxing and complete process cleanup.

## Runtime and Public-Surface Matrix

Run every row on the AMD host. “Strict” means the browser itself must clear all enabled provider surfaces. “Fallback” means the primary failure is preserved as evidence and a separate Cloak profile must clear every provider that failed in the primary attempt.

| Browser selection | Locked/recorded version | Headed | Headless | Acceptance role |
| --- | --- | --- | --- | --- |
| `cloak` | Cloak `146.0.7680.177.5` / Chromium `146.0.7680.177` | Required | Required | Strict public-surface gate |
| `chrome` | Installed system Chrome, exact version recorded | Required | Required | Primary challenge observation plus explicit Cloak fallback |
| `managed-chromium` | Chrome for Testing `146.0.7680.165` | Required | Required | Primary challenge observation plus explicit Cloak fallback |

The surface matrix must visit every provider enabled by `test/live-provider-capability-matrix.json` plus normal Google Search. A provider attempt fails on navigation failure, HTTP status `400` or greater, or a detected provider challenge such as Cloudflare, reCAPTCHA, hCaptcha, or a verification/interstitial page.

Google is a separate anti-bot control. Record Google `/sorry` or another challenge, but do not use it alone to prove or fail provider fallback because an IP-associated Google challenge can persist across browser changes.

### Strict Cloak gates

Both Cloak modes must:

- resolve and launch the exact catalog-pinned Windows executable;
- visit every enabled provider and Google without skip or internal retry;
- finish with zero provider failures and zero Google control failures;
- write evidence before assertions are evaluated; and
- close the browser and remove the disposable profile.

### Chrome fallback gates

For both system Chrome and managed Chrome for Testing, in both visibility modes:

1. visit the complete matrix and retain every primary outcome;
2. require at least one real provider failure to exercise fallback acceptance;
3. start Cloak only after the primary attempt completes;
4. use a new disposable Cloak profile rather than the primary user-data directory;
5. revisit every provider that failed in the primary attempt; and
6. fail unless Cloak clears every one of those provider failures.

If a Chrome row happens to have no provider failure, record it as a successful Chrome observation but leave that row's fallback criterion unproven. Do not manufacture a challenge or rerun until one appears. A release needs at least one naturally observed, passing system-Chrome-to-Cloak fallback row and one managed-Chrome-to-Cloak fallback row on the AMD host.

## Commands

Run the core runtime gate first, then each surface row. These commands use the built cross-platform Node launchers and set their gate variables inside Node rather than relying on POSIX shell syntax.

```powershell
npm run test:e2e:browser-runtime

npm run test:e2e:cloak-surfaces
npm run test:e2e:cloak-surfaces:headless

npm run test:e2e:system-surfaces
node test/run-live-browser-surface-matrix.mjs --selection chrome --visibility headed --fallback cloak
npm run test:e2e:chrome-surfaces:headless

node test/run-live-browser-surface-matrix.mjs --selection managed-chromium --visibility headed --fallback cloak
node test/run-live-browser-surface-matrix.mjs --selection managed-chromium --visibility headless --fallback cloak
```

`test:e2e:system-surfaces` is the strict observational system-Chrome row. It may fail when Chrome encounters a real challenge; that failure is evidence, not a reason to weaken the assertion. The following explicit fallback command is the acceptance path for that condition.

## Authenticated Provider Matrix

After explicit user login in a setup-managed profile, run the existing manual real-provider capability gates against system Chrome, managed Chrome for Testing, and Cloak in both headed and headless modes where the provider supports the mode. The selected profile must be explicit; Tokenless must never create an account, automate login, silently switch profiles, or weaken Windows credential protection.

For every enabled provider, prove the applicable semantic operations through the built CLI and packaged daemon: authentication status, model/effort selection, prompt submission, durable response, upload, citation, continuation, and native Project create/reuse/instructions/chat. An unmet prerequisite fails clearly. No fixture or public-surface result can close this section.

## Evidence Record

Keep the machine-local JSON emitted under `test-results/live-browser-surfaces/` for diagnosis and append a dated, non-secret summary here or in the parent roadmap. For every run record:

- Windows edition/build, processor manufacturer/model, `process.platform`, and `process.arch`;
- Tokenless commit SHA and exact Node/npm versions;
- browser selection, requested visibility, resolved executable source, artifact/product version, and reported browser version;
- unique primary and fallback run IDs and confirmation that their disposable profiles differed;
- every provider's requested URL, final origin, HTTP outcome, and challenge category;
- Google control outcome separately from provider fallback;
- fallback trigger, failed-provider set, fallback result for each member, and final assertion result;
- sandbox, browser/daemon cleanup, and temporary-profile cleanup outcomes; and
- pass, fail, or blocked with a concise reason and no credential or browser-storage material.

The current evidence schema is `tokenless.live-browser-surface-fallback-result.v2`. Evidence must be written before the gate throws so a genuine Chrome failure remains inspectable.

## Execution Checklist

### AMD x86-64 host

- [ ] Host identity and AMD processor manufacturer are recorded.
- [ ] Setup/version/cache/recovery matrix passes.
- [ ] Managed Chrome for Testing 146 and Cloak 146 exact-runtime launch gates pass.
- [ ] Cloak headed and headless strict surface gates pass.
- [ ] System Chrome headed and headless observations complete; at least one isolated Cloak fallback row passes.
- [ ] Managed Chrome headed and headless observations complete; at least one isolated Cloak fallback row passes.
- [ ] Authenticated provider gates pass for every applicable runtime and visibility.

## Exit Criteria

This plan is complete only when:

1. the named Windows AMD x86-64 host passes the setup, exact-runtime, sandbox, cleanup, and recovery gates;
2. the complete source-version classification matrix passes or a historical-version row is explicitly blocked only by unavailable official installation media;
3. managed Chrome for Testing `146.0.7680.165` and Cloak `146.0.7680.177.5` are downloaded or reused, verified, bound, launched, inspected, and cleaned up on the AMD host;
4. Cloak passes the complete strict public-surface matrix in headed and headless modes on the AMD host;
5. system Chrome and managed Chrome for Testing complete headed and headless observation rows on the AMD host;
6. at least one natural provider failure exercises and passes each required Chrome-to-Cloak fallback category on the AMD host, using isolated profiles and clearing every failed provider;
7. Google anti-bot control results remain separately recorded and are never substituted for provider fallback evidence;
8. no invoked run uses fixtures, interception, simulation, skip, internal retry, automated login, or automated challenge interaction;
9. applicable authenticated provider capability gates pass through the built CLI, packaged daemon, selected managed profile, and real provider network; and
10. the corresponding Windows gates and dated evidence in the parent roadmap are updated.

When all exit criteria pass, move this document to `docs/roadmaps/archived/`, update `docs/roadmaps/README.md`, and retain it as the permanent Windows acceptance record.
