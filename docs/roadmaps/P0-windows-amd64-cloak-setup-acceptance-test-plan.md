# Windows AMD64 Browser Runtime and Surface Acceptance Test Plan

Status: ready for execution | Priority: P0 | Last reviewed: 2026-08-06

Type: active real-boundary test plan

Tracks: [Browser Runtime Selection and Cloak Integration](P0-browser-runtime-selection-and-cloak.md)

## Objective

Prove the complete Windows AMD x86-64 browser path using the built Tokenless CLI, packaged daemon, real browser executables, real filesystems, real browser processes, and the real provider network.

Acceptance covers three distinct claims:

1. managed Chrome for Testing and Cloak artifacts install, verify, and bind correctly without launching a second test profile;
2. the config's default persistent profile reconnects through CDP without replacing its browser; and
3. that profile reaches the public provider surface matrix without hiding, skipping, or retrying failures.

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

- Load `TOKENLESS_TEST_CONFIG` and use only its registry default profile for every browser test. The developer prepares and authenticates that persistent profile before the run.
- Setup/importability cases that require a different profile are metadata-only; they must not launch a browser.
- Never inspect, export, copy, log, or compare cookies, tokens, passwords, browser storage, account details, or source profile contents.
- Record only safe browser identity/version metadata, result codes, managed-runtime metadata, requested surface URLs, final URLs, HTTP outcomes, detected challenge categories, and process outcomes.
- Never use fixtures, route interception, simulated responses, synthetic fetches, test accounts, automated login, or automated challenge interaction.
- An invoked suite runs every required case exactly once. It must not skip a provider, retry internally, or rerun until a desired challenge appears.
- Keep Chromium sandboxing enabled. Teardown closes only test-owned pages and detaches CDP; the profile and resident browser remain intact.

## Setup and Source-Version Matrix

These are metadata and artifact-verification cases only. The 145 and 150 cases are deliberate negative alignment checks against Windows Cloak Chromium `146.0.7680.177`; they must not launch, delete, replace, or mutate a browser profile.

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

Keep these setup checks separate from browser automation. Release browser acceptance always uses the profile selected by `TOKENLESS_TEST_CONFIG`.

Every setup case must prove:

- safe profile discovery and the expected exact compatibility classification;
- equivalent English and Simplified Chinese decisions;
- official artifact download, checksum, safe extraction, executable-reported version verification, and atomic cache commit;
- an exact runtime binding to a separate clean managed profile;
- no source-profile mutation or accidental opening with another runtime;
- a cache-miss download, verified-cache reuse with `--no-browser-download`, and missing-cache failure with `browser_runtime_download_required`;
- fail-closed behavior for checksum, archive-path, executable-version, profile-runtime, and downgrade mismatches; and
- enabled sandboxing without launching or altering a profile.

## Runtime and Public-Surface Gate

Run one row on the AMD host: the registry default profile selected by `TOKENLESS_TEST_CONFIG`, using its bound executable and configured visibility. Runtime, profile, and visibility are observations, not test parameters.

| Source | Requirement |
| --- | --- |
| Config | Repository `.env` → `TOKENLESS_TEST_CONFIG` |
| Profile | Adjacent registry's default ready profile only |
| Browser | Existing profile runtime binding |
| Visibility | Existing profile/config value through `auto` |
| Connection | Production `connectOverCDP` path |

The surface matrix must visit every provider enabled by `test/live-provider-capability-matrix.json` plus normal Google Search. A provider attempt fails on navigation failure, HTTP status `400` or greater, or a detected provider challenge such as Cloudflare, reCAPTCHA, hCaptcha, or a verification/interstitial page.

Google is a separate anti-bot control. Record Google `/sorry` or another challenge, but do not use it alone to prove or fail provider fallback because an IP-associated Google challenge can persist across browser changes.

The gate visits every enabled provider and Google without skip or internal retry, writes evidence before assertions, then detaches CDP. It must not launch an alternate browser, switch visibility, close the browser/context, crash a process, create a disposable profile, or delete any profile state.

## Commands

The one surface command reads the developer's configured profile; it has no browser or visibility matrix flags.

```powershell
npm run test:e2e:browser-surfaces
```

## Authenticated Provider Matrix

After explicit user login in the configured default profile, run the existing manual real-provider capability gates against that same resident browser. Tokenless must never create an account, automate login, silently switch profiles or visibility, or weaken Windows credential protection.

For every enabled provider, prove the applicable semantic operations through the built CLI and packaged daemon: authentication status, model/effort selection, prompt submission, durable response, upload, citation, continuation, and native Project create/reuse/instructions/chat. An unmet prerequisite fails clearly. No fixture or public-surface result can close this section.

## Evidence Record

Keep the machine-local JSON emitted under `test-results/live-browser-surfaces/` for diagnosis and append a dated, non-secret summary here or in the parent roadmap. For every run record:

- Windows edition/build, processor manufacturer/model, `process.platform`, and `process.arch`;
- Tokenless commit SHA and exact Node/npm versions;
- selected default profile slug, existing visibility, resolved executable source, artifact/product version, and reported browser version;
- every provider's requested URL, final origin, HTTP outcome, and challenge category;
- Google control outcome separately from provider fallback;
- final assertion result;
- sandbox, CDP detach, resident-browser preservation, and profile-preservation outcomes; and
- pass, fail, or blocked with a concise reason and no credential or browser-storage material.

The current evidence schema is `tokenless.live-browser-surface-result.v3`. Evidence must be written before the gate throws so a genuine provider failure remains inspectable.

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
