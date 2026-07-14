# Tokenless Chrome Web Store Reviewer Setup

Use this document to prepare and verify the exact reviewer instructions for the
primary Tokenless extension. It is not for the parked Debugger Control
companion.

## Release inputs

Fill these values only after the primary Chrome Web Store draft creates its
package key and permanent extension ID:

| Value | Final value |
| --- | --- |
| Chrome Web Store extension ID | `{{CHROME_WEB_STORE_EXTENSION_ID}}` |
| Released npm CLI version | `{{TOKENLESS_NPM_VERSION}}` |
| Privacy policy URL | `https://vertile.ai/products/tokenless/privacy` |
| Support email | `info@vertile.ai` |

## Reviewer prerequisites

- Chrome or another supported Chromium browser.
- Node.js 22 or later.
- Internet access to npm and a provider website.
- A normal account the reviewer is already signed in to on ChatGPT, Claude, or
  Gemini. Vertile does not supply, request, or retain reviewer credentials.

## Clean-machine verification

Run this before every Store submission from a clean Chromium profile and a
fresh local Tokenless home:

```bash
export TOKENLESS_HOME="$(mktemp -d)"
npx tokenless@{{TOKENLESS_NPM_VERSION}} setup --provider chatgpt --json
npx tokenless@{{TOKENLESS_NPM_VERSION}} doctor --json
```

Expected setup result:

- setup starts or confirms the local Rust daemon;
- setup registers the Native Messaging host for the Store extension ID;
- setup opens only the selected provider's HTTPS page when no bridge is live;
- setup reports a live extension bridge;
- no provider sign-in, CAPTCHA, or rate limit is bypassed.

After normal provider sign-in, run:

```bash
npx tokenless@{{TOKENLESS_NPM_VERSION}} run \
  --provider chatgpt \
  --project-name "Chrome Web Store review" \
  --chat-name "Visible UI check" \
  --prompt "Reply with exactly: TOKENLESS_REVIEW_OK" \
  --json
```

Expected run result:

- the selected ChatGPT page visibly receives the prompt;
- the CLI returns `TOKENLESS_REVIEW_OK` in the visible result;
- no task page, extension runner page, private provider API, cookie, browser
  storage value, or hidden authorisation header is used;
- failure to sign in or a visible provider block is reported as a normal error.

## Reviewer walkthrough

1. Click the extension action. Confirm the Tokenless side panel opens.
2. In **Activity**, confirm the panel only presents scalar local job metadata;
   it must not show prompts, answer bodies, claim tokens, cookies, or browser
   storage values.
3. In **Settings**, confirm routing order, browser preference, daemon URL, and
   language preference are local controls.
4. Select the provider normally through its visible web UI. Tokenless must use
   the visible Chat surface and must not submit on ChatGPT Work.
5. Run the sample command above and observe the visible provider UI action.
6. Disable the extension or remove the Native Messaging manifest and repeat.
   Setup must fail with an actionable bridge error rather than claim success.

## Security assertions for review

The reviewer may inspect the primary extension manifest and package. Confirm:

- Manifest V3 only.
- Host permissions limited to `chatgpt.com`, `chat.openai.com`,
  `gemini.google.com`, and `claude.ai`.
- No `debugger`, `cookies`, `history`, `webRequest`, or `webRequestBlocking`
  permission.
- No remote executable code.
- No extension page is opened automatically to act as a task runner.
- Native Messaging is local and explicitly set up by the user.

## Evidence package before submission

Prepare these assets in the Store dashboard, without user data:

1. 1280×800 screenshot: Tokenless Activity panel with deterministic sample
   local history.
2. 1280×800 screenshot: Settings panel showing provider order, language
   controls, and local-only wording.
3. A copy of `submission-copy.md`, with final release values substituted.
4. Verification evidence: `npm test`, clean-profile setup, and the sample
   visible-session run.

Do not include provider accounts, user prompts, real answers, API keys,
cookies, local database files, hidden browser state, or personally identifying
information in screenshots or attachments. Do not use a provider page as a
public Store-listing screenshot: it adds no extension UI evidence and creates
unnecessary account-content and provider-branding risk. Reviewers can validate
the visible provider flow through the supplied test instructions instead.

### Reproducible listing screenshots

After building the primary extension, generate the extension-owned listing
screenshots and promotional images from deterministic sample data:

```bash
npm run build --workspace tokenless-browser-session-bridge
node scripts/capture-cws-screenshots.mjs
```

The output directory contains two 1280×800 screenshots, the required 440×280
small promo tile, an optional 1400×560 marquee image, and a 128×128 Store icon.
The capture script uses only the canonical logo under `packages/extension/assets`,
a local static server, and a mock Native Messaging response; it never opens a
provider page or includes a real account, prompt, or answer. Inspect the PNGs
before uploading and regenerate them after any Settings UI or brand change.

## Final release gate

Do not click **Submit for review** until all are true:

- primary ZIP was rebuilt after the Store ID/public key was bound;
- `npm run verify:extension-release` passes with the permanent Store ID;
- the published npm CLI uses that same default extension ID;
- all six matching native runtime packages and the universal `tokenless` CLI
  are publicly available on npm before entering review instructions that use
  `npx tokenless@{{TOKENLESS_NPM_VERSION}}`;
- primary extension version, npm version, Store listing, permissions, privacy
  declarations, and public privacy policy describe the same released behavior;
- `npm test` and the clean-profile reviewer walkthrough pass;
- Chrome Web Store listing uses deferred publishing unless an automatic public
  release has been explicitly approved.
