# Tokenless Chrome Web Store Submission Source of Truth

This is the canonical source for the Tokenless Chrome Web Store package,
listing, privacy declarations, reviewer instructions, distribution settings,
and release gate. Update this file first, then make the package, public privacy
policy, and Developer Dashboard match it.

The older local files `submission-copy.md` and `privacy-policy.md` are excluded
from Git and are not release records. They must not be used as the source for a
submission.

## Authority and change control

For a release, the following must agree:

1. this document;
2. `packages/extension/extension/manifest.json` and the ZIP built from it;
3. the Chrome Web Store Developer Dashboard;
4. the public policy at
   `https://vertile.ai/products/tokenless/privacy`; and
5. the released `tokenless` CLI and Native Messaging packages used by the
   reviewer.

Do not upload a package, change Dashboard fields, submit for review, cancel a
review, or publish without explicit release-owner approval. Use deferred
publishing unless automatic publication is explicitly approved.

## Current verified state

Last inspected in the Chrome Web Store Developer Dashboard: **16 July 2026**.

| Field | Verified value |
| --- | --- |
| Publisher | Vertile AI |
| Item name | Tokenless |
| Item ID | `cgiocagnojoiblhlkmdjacklcmpbbimf` |
| Item type | Extension |
| Dashboard status | Draft; unpublished |
| Dashboard package version | `0.1.5` |
| Dashboard package revision | `main.crx`, draft revision 3 |
| Verified CRX uploads | Not enabled |
| Local ZIP | `packages/extension/dist/tokenless-browser-session-bridge.zip` |
| Inspected local ZIP SHA-256 | `1d6cd185a3e172f55fb74a40a5e3ec9581b8df7ba06ac8f3b1916dae5d6dd452` |
| Local ZIP manifest version | `0.1.5` |
| Public npm CLI | `tokenless@0.1.2` |
| Public privacy policy | Reachable, but stale; deployed page was last modified 12 July 2026 |

The Dashboard displayed `Error submitting item.` during the inspection. Its
Status page said only that the draft is unpublished. The Distribution and Test
instructions forms did not render reliably during the inspection, so their
current Dashboard values are **not verified**. They must be checked manually
before submission.

## Release blockers found on 16 July 2026

The item is not ready to submit or publish.

1. **The public privacy policy is stale.** The enriched local policy is at
   `../vertile-landing/app/products/tokenless/privacy/privacy.md`, dated
   15 July 2026, but the live page still serves the older 12 July deployment.
   Deploy the current policy and verify the public page without authentication.
2. **The public CLI points to the wrong Store item by default.** The published
   `tokenless@0.1.2` contains default extension ID
   `afpfljlnhlpkbkmgonoanbmcdmmf`, not this item's ID. Publish a new exact-version
   CLI/native package set containing `cgiocagnojoiblhlkmdjacklcmpbbimf` before
   public release. Reviewer commands must pass `--extension-id` explicitly even
   after that fix.
3. **The named `tabs` permission is broader than necessary.** Chrome documents
   that provider host permissions already allow access to the sensitive URL
   properties of matching tabs, while tab creation, activation, and messaging
   do not require the named permission. Remove `tabs` from the next manifest and
   prove the extension contract still passes. This better satisfies the Chrome
   Web Store minimum-permission policy.
4. **A changed package needs a higher manifest version.** Because `0.1.5` is
   already uploaded, the next corrected ZIP must use at least `0.1.6`.
5. **The manifest summary and Store description need replacement.** The current
   summary is implementation jargon, and the current description incorrectly
   calls the local companion optional even though it is required to receive
   local workflow jobs.
6. **Support is incomplete.** The Dashboard has no support URL. Use the public
   issue tracker below and confirm the publisher contact email is monitored.
7. **Distribution and Test instructions are unverified.** Confirm their saved
   values and resolve the generic Dashboard submission error before requesting
   review.

## Package source of truth

### Identity

- Manifest: `packages/extension/extension/manifest.json`
- Permanent Store item ID: `cgiocagnojoiblhlkmdjacklcmpbbimf`
- CLI default ID source: `packages/cli/src/default-extension-id.ts`
- Build command:

  ```bash
  npm run pack:extension --workspace tokenless-browser-session-bridge
  ```

- Release verification:

  ```bash
  npm run verify:extension-release -- --extension-id cgiocagnojoiblhlkmdjacklcmpbbimf
  ```

The manifest public key, computed extension ID, CLI default ID, Native Messaging
allowlist, Dashboard item, and reviewer commands must all identify the same
extension.

### Required next-package manifest values

| Field | Required value |
| --- | --- |
| `manifest_version` | `3` |
| `name` and `short_name` | `Tokenless` |
| `version` | At least `0.1.6` |
| `description` | `Route local AI requests through the visible ChatGPT, Claude, and Gemini pages you already use.` |
| `homepage_url` | `https://github.com/jazelly/tokenless` |
| Required permissions | `debugger`, `nativeMessaging`, `scripting`, `sidePanel` |
| Named permission to remove | `tabs` |
| Host permissions | Only the four origins below |
| Background | Manifest V3 module service worker |
| User interface | Extension action opens `settings/index.html` as a side panel |

Required host permissions and content-script matches:

```text
https://chatgpt.com/*
https://chat.openai.com/*
https://gemini.google.com/*
https://claude.ai/*
```

The package must contain no source maps, TypeScript declarations, remote code,
debugger companion extension, task runner page, obsolete execution surface, or
`externally_connectable` entry.

## Store listing

These are the exact target Dashboard values for the next submission.

### Name

```text
Tokenless
```

### Summary

This value comes from the packaged manifest description:

```text
Route local AI requests through the visible ChatGPT, Claude, and Gemini pages you already use.
```

### Detailed description

```text
Tokenless routes AI requests from local agents and tools through the ChatGPT, Claude, or Gemini web page you choose and are already signed in to. It submits each request through the provider's visible interface and returns the displayed response to the requesting local workflow.

This lets local workflows use supported web-based AI chats without exporting browser sign-in data or calling private provider APIs. The Tokenless CLI and local runtime are required to receive local workflow jobs. They are installed and configured explicitly by the user; the extension never silently downloads, installs, or updates executable software.

How it works:

1. Install the Tokenless extension and the Tokenless CLI/local runtime.
2. Choose a supported provider and sign in through that provider's normal website.
3. A local agent or tool sends a request to Tokenless.
4. The extension opens or reuses only the selected provider's approved page, visibly submits the request, reads the response displayed there, and returns that response to the local workflow.

Tokenless requests access only to chatgpt.com, chat.openai.com, claude.ai, and gemini.google.com. It does not export browser cookies, extract localStorage or sessionStorage authentication tokens, read hidden authentication headers, inspect provider network traffic, or call private provider APIs. It does not bypass provider sign-in, CAPTCHA, rate limits, subscriptions, permissions, or visible confirmations.

On ChatGPT only, Tokenless may briefly attach Chrome's debugger API when a visible model or Intelligence control requires a trusted browser click. It validates the requesting ChatGPT tab and visible click coordinates, sends one mouse press and release, and immediately detaches. It does not use debugger access to inspect network traffic, cookies, browser storage, authentication data, hidden page content, or private provider APIs.

All executable extension code is bundled in the reviewed Manifest V3 package. Tokenless does not load or execute remotely hosted code.

Tokenless is not made by, affiliated with, endorsed by, or officially supported by OpenAI, Anthropic, Google, ChatGPT, Claude, or Gemini.
```

### Classification and URLs

| Field | Target value |
| --- | --- |
| Category | Developer Tools |
| Language | English |
| Official URL | `https://vertile.ai` |
| Homepage URL | `https://github.com/jazelly/tokenless` |
| Support URL | `https://github.com/jazelly/tokenless/issues` |
| Mature content | No |
| Global promo video | Blank |

### Listing assets

| Dashboard asset | Canonical local file | Required dimensions |
| --- | --- | --- |
| Store icon | `packages/extension/assets/chrome-web-store/store-icon-128x128.png` | 128×128 |
| Activity screenshot | `packages/extension/assets/chrome-web-store/activity-1280x800.png` | 1280×800 |
| Settings screenshot | `packages/extension/assets/chrome-web-store/settings-1280x800.png` | 1280×800 |
| Small promo tile | `packages/extension/assets/chrome-web-store/small-promo-440x280.png` | 440×280 |
| Marquee promo tile | `packages/extension/assets/chrome-web-store/marquee-1400x560.png` | 1400×560 |

Regenerate the assets after any side-panel or brand change:

```bash
npm run build --workspace tokenless-browser-session-bridge
node scripts/capture-cws-screenshots.mjs
```

Inspect every image before upload. It must contain only deterministic sample
data and extension-owned UI, with no real provider account, prompt, answer,
credential, or browser state.

## Privacy practices

### Single purpose description

```text
Tokenless lets users route AI requests from local agents and tools through supported web-based AI chats they are already signed in to. It submits each request through the selected provider's visible web interface and returns the response displayed there to the requesting local workflow.
```

This is one narrow workflow. Activity history, routing preferences, Native
Messaging, tab orchestration, and the bounded ChatGPT debugger click are
supporting functions of that purpose, not separate purposes.

### Permission justifications

#### debugger

```text
Tokenless uses the debugger permission only when a visible ChatGPT model or Intelligence control requires a trusted browser input event. Before attaching, Tokenless verifies that the request came from the top frame of an approved ChatGPT tab, confirms that the tab URL matches the requesting page, and validates that the click coordinates are within the visible viewport. It sends only one mouse-pressed and mouse-released Input.dispatchMouseEvent sequence, serializes clicks per tab, and immediately detaches on success or failure. Tokenless does not use debugger access to inspect network traffic, cookies, browser storage, authentication data, hidden page content, or private provider APIs, and it does not enable Network, Storage, Fetch, Runtime, DOM, or Page debugging domains.
```

#### nativeMessaging

```text
Required to communicate with the Tokenless Native Messaging host that the user explicitly installs on the same computer. The host transfers locally created Tokenless jobs and their local completion status through a versioned local protocol. It is not used to export browser cookies, browser storage, authentication tokens, or hidden provider API credentials.
```

#### scripting

```text
Required only to inject Tokenless's bundled provider content script into an approved provider tab when the statically declared content script is not yet available, such as a supported page that was already open when the extension was installed or updated. The script interacts only with the provider's user-visible web UI to perform the user's requested action. All executable code is included in the submitted Manifest V3 package; Tokenless does not load or execute remotely hosted code.
```

#### sidePanel

```text
Required to show Tokenless's local Activity and Settings interface from the extension action. The panel shows local connection state, routing preferences, language preference, and bounded redacted job history. It does not display provider cookies, browser storage values, prompt bodies, answer bodies, or claim tokens.
```

#### Host permissions

```text
Host access is limited to chatgpt.com, chat.openai.com, gemini.google.com, and claude.ai. It is required so Tokenless can locate supported visible controls, submit the user-requested prompt, and read the displayed response only on the provider page the user selected. Tokenless does not request access to arbitrary websites, general browsing history, provider cookies, browser storage authentication data, or private provider APIs.
```

#### tabs

The next package must not request the named `tabs` permission, so the next
Dashboard must not present a `tabs` justification field. The current `0.1.5`
Dashboard justification is preserved in the inspection snapshot below only.

### Remote code

Select **No, I am not using remote code**.

The Dashboard disables the justification field for this answer. The reviewed
package contains all executable JavaScript. It does not load external scripts
or WebAssembly, execute fetched strings, use `eval()` or equivalent execution,
or interpret remote instructions as code. Provider-page DOM data and local job
messages are data, not executable code.

### User data categories

Chrome treats local processing as handling user data. Use these declarations:

| Dashboard category | Select | Reason |
| --- | --- | --- |
| Personally identifiable information | No | Tokenless does not request or extract identity fields; incidental identity text remains part of the user's communication or visible website content. |
| Health information | No | Tokenless has no health-data feature and does not identify or extract health fields. |
| Financial and payment information | No | Tokenless has no payment-data feature and does not identify or extract payment fields. |
| Authentication information | No | Provider authentication remains in the browser; Tokenless does not read passwords, cookies, storage tokens, or hidden headers. |
| Personal communications | Yes | Prompts and displayed AI answers are the user's AI-chat communications. |
| Location | No | Tokenless does not request or derive location. |
| Web history | Yes | Tokenless uses the selected supported provider URL to validate and coordinate the requested provider tab. |
| User activity | No | Tokenless does not collect the user's clicks, keystrokes, scrolling, or browsing behaviour. A temporary programmatic click coordinate is generated for one requested visible control and is not user-activity telemetry. |
| Website content | Yes | Tokenless reads supported visible provider UI, displayed answers, visible source links, and explicitly requested sanitised snapshots. |

Prompts or displayed answers can incidentally contain identity, health, or
financial information chosen by the user. Tokenless does not classify or use
those as separate data products; the public privacy policy must nevertheless
warn users not to submit information they are not authorised to disclose.

### Use and transfer

The declared data is used only to provide the single purpose and associated
local security, reliability, and support functions. It is processed between the
extension, Native Messaging host, CLI, and daemon on the user's device. The
prompt and deliberately supplied context are sent through HTTPS to the provider
selected by the user through that provider's normal web page. The provider's
terms and privacy policy govern its handling. Vertile does not operate a hosted
Tokenless workflow service that receives prompts, page content, answers, or
provider credentials.

### Required certifications

Certify all three statements in the Dashboard:

- data is not sold or transferred outside the approved use cases;
- data is not used or transferred for purposes unrelated to the item's single
  purpose; and
- data is not used or transferred to determine creditworthiness or for lending.

### Public privacy policy

Dashboard URL:

```text
https://vertile.ai/products/tokenless/privacy
```

Canonical website source:

```text
../vertile-landing/app/products/tokenless/privacy/privacy.md
```

Before submission, verify that the public page:

- is reachable without authentication and returns HTTP 200 after redirects;
- displays the current effective or last-updated date;
- states the same single purpose and data categories as this document;
- explains the local runtime, Native Messaging, approved hosts, debugger use,
  local retention/deletion, provider transfer, and lack of Vertile-hosted
  workflow collection;
- contains an affirmative Chrome Web Store Limited Use statement; and
- provides a monitored privacy contact and applicable complaint route.

## Distribution

These are the target values. The current Dashboard values remain unverified.

| Field | Target value |
| --- | --- |
| Visibility | Public |
| Regions | All regions where Chrome Web Store distribution is available |
| Payments | None through Chrome Web Store |
| Publish timing | Deferred publishing |

If business or legal requirements need a narrower region list, update this file
before changing the Dashboard. Do not silently diverge.

## Test instructions for reviewers

### Prerequisites

- Chrome or a supported Chromium browser.
- Node.js 22.13 or later.
- Internet access to npm and one supported provider website.
- A normal ChatGPT, Claude, or Gemini account that the reviewer is already
  authorised to use. Vertile does not supply, request, or retain credentials.

### Exact Dashboard copy

Replace `{{TOKENLESS_NPM_VERSION}}` only with a version already public on npm
whose six native packages are also public at that exact version. Keep the
explicit extension ID even after the CLI default is corrected.

```text
Tokenless routes requests from local tools through the visible ChatGPT, Claude, or Gemini page selected by the user. It requires a user-installed local runtime and a normal provider account. Vertile does not supply, request, or retain provider credentials.

Prerequisites: Chrome/Chromium, Node.js 22.13+, internet access to npm, and a normal account already signed in to one supported provider website.

1. Install this reviewed extension in Chrome.
2. In a terminal, run:
   npx tokenless@{{TOKENLESS_NPM_VERSION}} setup --provider chatgpt --extension-id cgiocagnojoiblhlkmdjacklcmpbbimf --json
3. If ChatGPT asks, sign in normally through the visible website. The setup command installs or confirms the local runtime, registers Native Messaging for this exact extension ID, opens only the selected provider page if needed, and waits for the extension bridge.
4. Click the Tokenless extension action. Confirm the side panel reports "Native host ready". Activity shows only bounded local job metadata; prompt bodies, answer bodies, cookies, browser-storage values, and claim tokens are not shown.
5. Run:
   npx tokenless@{{TOKENLESS_NPM_VERSION}} run --provider chatgpt --project-name "Chrome Web Store review" --chat-name "Visible UI check" --prompt "Reply with exactly: TOKENLESS_REVIEW_OK" --json
6. Expected result: Chrome visibly submits the prompt on chatgpt.com and the command returns TOKENLESS_REVIEW_OK from the answer displayed on that page.

Expected limitations: Tokenless stops rather than bypassing provider sign-in, CAPTCHA, rate limits, subscription limits, permissions, or other visible provider blocks. It does not read cookies, localStorage/sessionStorage authentication tokens, hidden headers, network traffic, or private provider APIs.

Debugger verification: if a visible ChatGPT model or Intelligence control requires a trusted click, Tokenless attaches only to the validated ChatGPT tab, sends one Input.dispatchMouseEvent press/release pair at visible coordinates, and immediately detaches. It does not enable Network, Storage, Fetch, Runtime, DOM, or Page debugging domains.
```

### Reviewer evidence before submission

Run from a clean Chrome profile and fresh Tokenless home:

```bash
export TOKENLESS_HOME="$(mktemp -d)"
npx tokenless@{{TOKENLESS_NPM_VERSION}} setup \
  --provider chatgpt \
  --extension-id cgiocagnojoiblhlkmdjacklcmpbbimf \
  --json
npx tokenless@{{TOKENLESS_NPM_VERSION}} doctor --json
```

Then execute the exact sample request from the Dashboard copy. Record the npm
version, operating system, Chrome version, extension version, and pass/fail
result without recording provider credentials, real prompts, or account data.

## Dashboard inspection snapshot: 16 July 2026

This section preserves what was actually present before the recommended fixes.
It is evidence, not the target copy.

### Store listing snapshot

- Summary from package:
  `Visible bridge for user-authorized ChatGPT, Gemini, and Claude web sessions.`
- Category: Developer Tools.
- Language: English.
- Official URL: `vertile.ai`.
- Homepage URL: `https://github.com/jazelly/tokenless`.
- Support URL: blank.
- Mature content: off.
- Uploaded assets: Store icon, two screenshots, small promo tile, and marquee
  promo tile. Global promo video was blank.
- The detailed description was the older local-companion copy. It described the
  companion as optional, then stated that Tokenless cannot receive jobs without
  it. Replace it with the target description above.

### Privacy snapshot

Single purpose:

```text
Tokenless connects local workflows to supported AI services by submitting prompts and reading visible answers through provider web pages selected by the user.
```

The Dashboard contained justifications for `debugger`, `nativeMessaging`,
`scripting`, `tabs`, `sidePanel`, and host permissions. The debugger,
nativeMessaging, sidePanel, and host explanations substantially matched the
target text above. The scripting text was accurate but did not explain the
specific already-open-tab reinjection path. The `tabs` explanation described
finding, opening, validating, and focusing provider tabs, but did not establish
why the named `tabs` permission was necessary in addition to host access.

Remote code was set to **No** and its justification box was disabled.

Selected data categories:

- Personal communications: yes.
- Web history: yes.
- Website content: yes.
- Personally identifiable information: no.
- Health information: no.
- Financial and payment information: no.
- Authentication information: no.
- Location: no.
- User activity: no.

All three Limited Use certifications were selected. The privacy policy URL was
`https://vertile.ai/products/tokenless/privacy`.

## Reviewer-oriented assessment

### Must fix before the next submission

1. Deploy the current public privacy policy.
2. Remove the unnecessary named `tabs` permission, bump the manifest version,
   rebuild the ZIP, and rerun extension contract tests.
3. Put the target summary in the manifest and the target description in the
   Dashboard.
4. Publish a CLI/native package set with the correct default Store ID, or the
   normal user setup advertised by the listing will fail. Keep the explicit ID
   in reviewer instructions regardless.
5. Add and verify the Test instructions and support URL.
6. Inspect Distribution and resolve the Dashboard's generic submission error.
7. Verify the final Dashboard, ZIP, npm artifacts, and live policy agree before
   submitting.

### Likely reviewer questions and the evidence that answers them

| Reviewer question | Required evidence |
| --- | --- |
| Why does this extension add value instead of merely opening a website? | It receives a local user-requested job, visibly submits it through an approved provider UI, reads the displayed response, and returns it to the requesting local workflow. |
| Why is Native Messaging necessary? | The local CLI/daemon is the source and destination of workflow jobs; the host is explicitly installed and communicates only on-device. |
| Why is debugger necessary? | Some visible ChatGPT controls reject an ordinary DOM click. Source and tests prove one validated `Input.dispatchMouseEvent` press/release pair and immediate detach. |
| Does debugger expose network or credentials? | The service worker sends only the two Input-domain commands and never enables Network, Storage, Fetch, Runtime, DOM, or Page. |
| Is remote code executed? | No. Build output is self-contained, has no remote scripts/WASM/eval, and the ZIP inventory is reviewable. |
| Why are broad hosts needed? | They are not broad: four explicit provider origins only. Each is a supported provider selected by the user. |
| What user data is handled? | Prompts/answers, the approved provider URL, and visible supported page content, processed locally except for the intentional HTTPS submission to the selected provider. |
| Can Vertile read prompts or answers? | No hosted Tokenless workflow service receives them. Human access occurs only if a user deliberately includes specific data in a support request or another policy exception applies. |
| Is the companion hidden or silently installed? | No. The listing says the local runtime is required, and installation/configuration is explicitly initiated by the user. |

### Residual review risk

Even after these fixes, `debugger`, Native Messaging, and persistent provider
host permissions justify a deeper manual review. That delay is expected. The
best mitigation is not weaker wording; it is exact minimum permissions,
self-contained code, a reproducible reviewer flow, and complete agreement among
the package, listing, privacy declarations, public policy, and runtime.

## Final release gate

Do not submit until every box can be checked from fresh evidence:

- [ ] Next manifest version is greater than `0.1.5`.
- [ ] Manifest summary matches this document.
- [ ] Named `tabs` permission has been removed and tests still pass.
- [ ] `npm run pack:extension --workspace tokenless-browser-session-bridge`
      produces the inspected ZIP.
- [ ] ZIP contains only expected production files and no remote code or source
      maps.
- [ ] `npm run verify:extension-release -- --extension-id
      cgiocagnojoiblhlkmdjacklcmpbbimf` passes.
- [ ] Full test suite, extension contract tests, and clean-profile reviewer flow
      pass.
- [ ] A public `tokenless` CLI and all six native packages exist at the exact
      reviewer version and use this Store ID by default.
- [ ] Store listing fields and assets match this document.
- [ ] Privacy fields and certifications match this document.
- [ ] Live privacy policy is the current enriched policy and is reachable
      without authentication.
- [ ] Support URL and monitored contact information are present.
- [ ] Distribution values are confirmed.
- [ ] Test instructions are saved with all placeholders replaced.
- [ ] Dashboard no longer reports a submission error.
- [ ] Deferred publishing is selected.
- [ ] Release owner has explicitly approved submission.

## Policy references

- [Chrome Web Store Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)
- [Manifest V3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)
- [Chrome tabs API permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome Web Store review process](https://developer.chrome.com/docs/webstore/review-process)
- [Update a Chrome Web Store item](https://developer.chrome.com/docs/webstore/update)
