# Repository Development Rules

## Language

- Use English for code, identifiers, package/config keys, and inline comments.
- Localize every reasonable user-facing surface in both English and Simplified Chinese. Never ship one language alone or assume users know the other.
- Keep commands, flags, identifiers, protocol fields, provider/model names, and clearer technical terms unchanged.
- Keep language selection and fallback consistent; cover externally visible localization through real boundaries.
- Keep paired docs, such as `README.md` and `README.zh-CN.md`, structurally and semantically aligned.
- Internal technical docs may remain English when translation adds no user value.

## Documentation style

- Do not ship walls of text. Keep paragraphs to one to three short sentences, and use a list, table, diagram, or screenshot when it makes the same point faster.
- Keep product READMEs as scannable landing pages: lead with the value proposition and product visual, then show providers, quick start, and links to deeper documentation.
- Put detailed reference material in the focused document that owns it and link there instead of duplicating long explanations.
- Prefer one clear sentence over a section, and a few concrete bullets over a paragraph that merely enumerates features or steps.
- Label illustrative or staged screenshots and metrics so they cannot be mistaken for benchmarks or production telemetry.

## Tokenless skill

- Do not read or invoke the external `tokenless` skill during repository work. Use this file, source, and tests.

## Branches and releases

- Land prerelease work on `dev` before `main`; direct `dev` commits are allowed.
- Ticket branches are optional; target their first PR to `dev`.
- Update `main` only by PR, normally promoted from `dev`; never commit or push directly.
- Add a changeset for user-visible CLI changes requiring publication. A `main` PR may omit one only when no release should occur.
- Never publish packages, releases, or artifacts manually unless explicitly asked; use release automation.

## External namespaces

- Never assume ownership of scopes, package/registry namespaces, domains, or organizations. Verify user control or get explicit confirmation before use. Existing local references prove nothing about publishability.

## Roadmap lifecycle

- Directory defines state: `docs/roadmaps/P[0-3]-*.md` is active, `docs/roadmaps/backlog/P[0-3]-*.md` accepted but inactive, and `docs/roadmaps/archived/P[0-3]-*.md` completed, superseded, cancelled, or abandoned. Exclude each `README.md`.
- Name every roadmap `P0-<name>.md`, `P1-<name>.md`, `P2-<name>.md`, or `P3-<name>.md`; the filename prefix must match the document's declared priority.
- Keep `docs/roadmaps/README.md` synchronized with every roadmap add, rename, priority change, move, or state change, and update all repository links when a priority change renames a roadmap.
- On moves, update all links and lifecycle notes, name any replacement, and preserve history except factual corrections.
- Use no `active/` directory or roadmap location outside these three states.

## Testing

- Test externally observable behavior through real boundaries: built CLI, packaged TypeScript daemon, filesystem, local Google Chrome controlled through Playwright, or provider website.
- Use focused integration or browser E2E for cross-runner/runtime/provider behavior. Prefer browser proof when feasible.
- Keep default browser E2E to representative core flows. Cover rare crash/restart or failure injection only when required, reproduced, or visibly material; otherwise use focused real-boundary integration.
- No unit tests, mocks, fakes, stubs, spies, synthetic fetches, fake runtime/browser objects, injected test doubles, or source/doc regex tests.

### Test Browser Policy

- Every repository browser test must load `TOKENLESS_TEST_CONFIG` from the repository-local `.env`. It points to one complete Tokenless `config.json`; its adjacent production profile registry is the only source of the test profile name, directory, and runtime binding.
- Different developers may use different profile slugs. The registry's default profile is the one dedicated test profile; tests must never select additional profiles or hard-code, derive, or separately configure its name.
- Never launch Playwright's bundled Chromium (`chromium.executablePath()`) or resolve a test browser outside the dedicated Tokenless config. Browser selection and executable resolution come from each selected profile's production runtime binding.
- Playwright browser tests must use the one persistent dedicated profile resolved by `test/helpers/live-provider-test-profile.mjs`; never use another profile from the same config.
- Browser tests must not create disposable user-data directories or delete a browser profile or its test home during teardown. Reuse the prepared dedicated profile across runs; profile deletion requires an explicit user request naming that profile.
- Browser tests must enter browser automation through the dedicated-profile helper and Tokenless's production CDP path. Direct `chromium.launch()`, `chromium.launchPersistentContext()`, and ad hoc browser process launches are forbidden in test files.
- Browser tests must never test profile deletion, browser crash/kill, explicit browser/context close, forced relaunch, runtime replacement/repair, visibility-switch relaunch, or corruption of `DevToolsActivePort`, PID, CDP endpoint, or runtime-session metadata.
- Browser tests may create and delete provider-side conversations or other ordinary functional artifacts. Teardown must close only test-owned pages when appropriate and detach the CDP client; it must leave the profile, resident browser, runtime, and browser metadata intact.

### Credential and macOS Keychain Safety

- Browser auth stays opaque in the user's running Google Chrome. Tokenless must not copy or import browser profiles.
- Tokenless code, tests, and tooling must never directly inspect, export, log, transmit, decrypt, or dump passwords, cookies, tokens, keys, hidden auth headers, Keychain items, or browser-storage secrets, and must never call `security`, Keychain APIs, or equivalent tools. Chrome's normal local Keychain use is not secret extraction by Tokenless.
- On macOS, production native mode uses the running Chrome's normal Keychain access. Never add `--password-store=basic` or `--use-mock-keychain` to production browser control.
- Keychain approval remains a user-controlled security decision. Tokenless may explain why the expected browser is asking and the user may approve it, but tests and automation must never click the prompt, enter a password, or weaken the prompt on the user's behalf.
- Installer smoke checks may stay keychain-neutral because they do not become reusable test profiles. Browser-surface and real-provider E2E use the persistent dedicated profile and the production credential-storage policy; they may pause for manual user approval.
- Keychain safety never permits mocked browser boundaries.
- For browser-launch changes, verify native credential storage on persistent dedicated profiles, keychain neutrality only for installer smoke checks, enabled Chromium sandboxing, CDP detach, profile preservation, resident-browser preservation, and focused real-boundary completion.
- Regression guard: production native Chrome control must remain free of `--password-store=basic` and `--use-mock-keychain`.

### Provider DOM Fixture Policy

- Fixtures must be redacted, provenance-bound reductions captured from real visible provider sessions.
- Use them only for focused selector, parser, sanitizer, and observed-DOM checks.
- Never use fixture routes, network interception, or simulated responses in built CLI/daemon E2E; never call fixture evidence E2E/live or use it for support, capability, acceptance, or release claims.
- Never invent DOM or infer transitions from separate before/after fixtures.
- Capture each materially distinct capability-relevant real state; redact it, record provenance, add it to the manifest, and preserve variants affecting behavior.

### Real Provider Browser E2E

- Run all browser E2E and provider capability acceptance against the real website, built CLI, packaged daemon, managed browser, and provider network—without fixtures, interception, or simulation.
- Explicitly gated real E2E must prove provider-side transitions: model/effort changes, uploads, prompt submission, responses, citations, continuation, and native Project create/reuse/instructions/chat.
- Real provider E2E is a manual local release prerequisite, not CI. PRs include a non-enforced reminder; all applicable cases must pass before release.
- Invoked suites never skip required cases or retry internally. Sole exception: Claude may skip only for durable provider `claude` jobs blocked by `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`, as declared in `test/live-provider-capability-matrix.json`. All other unmet prerequisites fail clearly; retry manually.
- Use the explicitly selected setup-managed profile. Never create test accounts, automate login, or switch profiles silently.
- Real messages, conversations, Projects, attachments, retained artifacts, and provider cost are allowed; mark them uniquely per run. Cost never justifies fixtures.
- Assert semantic commands, durable state, visible outcomes, and real protocol results. Never collect screenshots, full DOM, storage, credentials, or unrelated account content.
- Gate unsafe external integrations behind explicit real integration/E2E tests; never simulate them.
