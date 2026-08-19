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

## Production configuration boundary

- Production behavior controls must be read from the persisted Tokenless `config.json`, not from `.env` or process-environment overrides.
- `.env` is reserved for test/bootstrap selectors such as `TOKENLESS_TEST_HOME`; it may locate the complete test home but must not override production behavior defined inside that home.
- When a production setting needs to change, update the selected Tokenless config through the supported configuration path. Do not add an environment-variable escape hatch.

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

- Test externally observable behavior through real boundaries: built CLI, packaged TypeScript daemon, filesystem, local Google Chrome controlled through Playwright, provider website, or the real provider web endpoint selected by an explicit direct-protocol mode.
- Use focused integration or browser E2E for cross-runner/runtime/provider behavior. Prefer browser proof when feasible.
- Keep default browser E2E to representative core flows. Cover rare crash/restart or failure injection only when required, reproduced, or visibly material; otherwise use focused real-boundary integration.
- No unit tests, mocks, fakes, stubs, spies, synthetic fetches, fake runtime/browser objects, injected test doubles, or source/doc regex tests.

### Test Browser Policy

- Every repository browser test must load `TOKENLESS_TEST_HOME` from the repository-local `.env`. It points to one complete Tokenless home; tests derive its root `config.json` and adjacent production profile registry, with the registry as the only source of the test profile name, directory, and runtime binding.
- Different developers may use different profile slugs. The adjacent registry's default profile is the only browser-test profile; tests must never select, hard-code, derive, or separately configure another name.
- Never launch Playwright's bundled Chromium (`chromium.executablePath()`) or resolve a browser outside `TOKENLESS_TEST_HOME`. Browser selection and executable resolution come from that default profile's production runtime binding.
- The selected test home is canonical external state: tests must not replace, delete, or rewrite its root `config.json`, profile registry, profile directories, or runtime binding. Normal runtime state and provider-side artifacts may be written by the real run.
- Playwright browser tests must use `test/helpers/configured-browser-profile.mjs` and Tokenless's production CDP path.
- Browser tests must not create disposable user-data directories or delete a browser profile or config home during teardown. Reuse the configured profile across runs; profile deletion requires an explicit user request naming that profile.
- Direct `chromium.launch()`, `chromium.launchPersistentContext()`, and ad hoc browser process launches are forbidden in test files. Tests must not resize browser windows or emulate a viewport.
- Browser tests must never directly invoke browser/context/page close or test profile deletion, browser crash/kill, forced relaunch, runtime replacement/repair, visibility-switch relaunch, or corruption of `DevToolsActivePort`, PID, CDP endpoint, or runtime-session metadata.
- Browser tests may create provider-side conversations or other ordinary functional artifacts. Teardown detaches only CDP clients and leaves the profile, resident browser, runtime, pages, and browser metadata intact.

### Provider Session and macOS Keychain Safety

- Visible-browser mode keeps provider authentication in the user's selected browser and must not copy or import a complete browser profile.
- An explicitly selected direct provider-protocol mode may locally acquire the required provider session values from the selected live browser or CDP session, a user-supplied HAR, the selected browser's Cookie database, user-supplied cookies or tokens, and required browser storage. This access must be limited to the selected provider and explicitly selected auth source and must never be enabled implicitly.
- When an import or save auth source is implemented, a user may explicitly persist a HAR, cookies, or tokens locally. Without that explicit choice, Tokenless must not import or persist session values; every auth source must declare whether its lifetime is ephemeral or user-persisted.
- On macOS, that explicit direct mode may read only the browser encryption material required to decrypt the selected provider's cookies, including through the necessary OS or Keychain API. It must not read passwords, unrelated Keychain items, or credentials for another provider, account, or profile.
- Provider session values may be passed in local process memory to the explicitly selected direct adapter or sidecar and sent to the selected provider as required by that mode. The adapter or sidecar must not log, independently persist, or return them. Never print them to stdout or stderr; include them in logs, errors, telemetry, jobs, checkpoints, evidence, or UI responses; expose them to callers or web models; or send them to a Tokenless-operated remote service or any unrelated service.
- On macOS, production native mode uses the running Chrome's normal Keychain access. Never add `--password-store=basic` or `--use-mock-keychain` to production browser control.
- Keychain approval remains a user-controlled security decision. Tokenless may explain why the expected browser is asking and the user may approve it, but tests and automation must never click the prompt, enter a password, or weaken the prompt on the user's behalf.
- Installer smoke checks may stay keychain-neutral because they do not become reusable test profiles. Browser-surface and real-provider E2E use the configured persistent profile and the production credential-storage policy; they may pause for manual user approval.
- Keychain safety never permits mocked browser boundaries.
- For browser-launch changes, verify native credential storage on the configured persistent profile, keychain neutrality only for installer smoke checks, enabled Chromium sandboxing, CDP detach, profile preservation, resident-browser preservation, and focused real-boundary completion.
- Regression guard: production native Chrome control must remain free of `--password-store=basic` and `--use-mock-keychain`.

### Provider Boundary Verification

- Do not create, capture, store, generate, promote, or test against provider DOM fixtures, reduced DOM snapshots, provider replicas, locally hosted provider pages, intercepted response fixtures, or simulated provider responses.
- Develop and verify visible-browser selectors, parsers, blockers, controls, transitions, and outcomes only against the real provider website in the configured persistent browser profile.
- Develop and verify an explicit direct-protocol adapter against the real selected provider web endpoint and account session. Bounded inspection of provider traffic and the required session values is allowed for that mode; credentials must not appear in test evidence or diagnostics.
- A provider behavior change requires a focused real-provider integration or E2E case through the built CLI and packaged daemon using the affected execution mode. If the real provider cannot currently prove the behavior, fail or leave the capability unadvertised; do not substitute fixture evidence.
- Local daemon, API, filesystem, installer, and control-plane tests may use their real local boundaries, but they must not impersonate a provider website or endpoint or claim provider behavior.

### Real Provider Browser E2E

- Run all browser E2E and provider capability acceptance against the real website, built CLI, packaged daemon, managed browser, and provider network—without fixtures, interception, or simulation.
- Explicitly gated real E2E must prove provider-side transitions: model/effort changes, uploads, prompt submission, responses, citations, continuation, and native Project create/reuse/instructions/chat.
- Real provider E2E is a manual local release prerequisite, not CI. PRs include a non-enforced reminder; all applicable cases must pass before release.
- Invoked suites never skip required cases or retry internally. Sole exception: Claude may skip only for durable provider `claude` jobs blocked by `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`, as declared in `test/live-provider-capability-matrix.json`. All other unmet prerequisites fail clearly; retry manually.
- Use the explicitly selected setup-managed profile. Never create test accounts, automate login, or switch profiles silently.
- Real messages, conversations, Projects, attachments, retained artifacts, and provider cost are allowed; mark them uniquely per run. Cost never justifies fixtures.
- Assert semantic commands, durable state, visible outcomes, and real protocol results. Test evidence and reports must never persist screenshots, full DOM, provider session values, credentials, or unrelated account content.
- Gate unsafe external integrations behind explicit real integration/E2E tests; never simulate them.
