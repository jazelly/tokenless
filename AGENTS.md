# Repository Development Rules

## Language

- Write source code, identifiers, package names, configuration keys, and inline code comments in English.
- Support both Chinese-speaking and English-speaking users in user-facing documentation whenever practical.
- Keep paired documentation, such as `README.md` and `README.zh-CN.md`, aligned in structure and meaning. When updating one language, update its counterpart as part of the same change whenever possible.
- Internal technical documentation may remain in English when a bilingual version would not benefit users.

## Tokenless skill

- The `tokenless` skill is an external integration surface for users and their agents. Do not read or invoke it while developing or maintaining this repository; use this `AGENTS.md`, the source code, and the repository tests directly.

## Branches and releases

- Treat `dev` as the prerelease integration branch. All prerelease work must land on `dev` before it reaches `main`.
- Direct commits to `dev` are allowed.
- Ticket branches are optional. When one is used, target its pull request to `dev` first.
- Update `main` only through a pull request. Do not commit or push directly to `main`.
- Promote work from `dev` to `main` through a pull request.
- Include a changeset for every user-visible change that should publish a new version of the `tokenless` CLI.
- A pull request into `main` may omit a changeset when it should not trigger a release. Merging such a pull request updates `main` without publishing a new version.
- Do not publish packages, releases, or other artifacts manually unless the user explicitly asks for publication. Let the repository's release automation handle changeset-driven publishing.

## External namespaces

Never assume that the repository owns or controls an npm scope, package namespace, domain name, organization, registry namespace, or similarly reserved identifier. Before introducing or depending on a scoped package such as `@tokenless/*`, verify that the user controls that namespace or obtain the user's explicit confirmation. Treat an existing scoped package reference as a local workspace implementation detail, not proof that the namespace is available for publication.

## Roadmap lifecycle

The directory containing a roadmap is the source of truth for its lifecycle state:

- `docs/roadmaps/*.md`, excluding `README.md`, contains active roadmaps. An active roadmap is a current product or engineering direction, even when its internal delivery status is still `proposed`.
- `docs/roadmaps/backlog/*.md`, excluding `README.md`, contains accepted roadmap ideas that are intentionally not active yet.
- `docs/roadmaps/archived/*.md`, excluding `README.md`, contains roadmaps that are completed, superseded, cancelled, or no longer planned.

Keep `docs/roadmaps/README.md` synchronized with every roadmap addition, rename, move, or lifecycle change. Moving a roadmap between lifecycle directories must also:

- update all repository links to the roadmap;
- update its lifecycle or disposition note so it does not contradict its directory;
- record a replacement roadmap when it was superseded; and
- preserve historical content unless correcting an objective factual error.

Do not use an additional `active/` directory. Root-level roadmap files are the active set. Do not leave roadmap documents outside these three lifecycle locations.

## Testing

Use focused integration or browser E2E tests for behavior that crosses the Playwright runner, local runtime, or provider web sessions. Do not mock visible-session behavior when a browser proof is feasible.

- Keep browser E2E coverage focused on representative core user workflows. Do not make rare failure-injection scenarios, such as abrupt process death or crash/restart recovery, part of the default browser E2E acceptance bar. Add browser coverage for such edge cases only when they are an explicit product requirement, a reproduced regression, or they materially change visible browser behavior; otherwise prefer focused real-boundary integration coverage.
- Test only externally observable behavior through real system boundaries: the built CLI process, the packaged TypeScript daemon, the real filesystem, a real local Chromium/Playwright session, or a real provider website.
- Do not add unit tests.
- Do not introduce mocks, fakes, stubs, spies, synthetic fetch implementations, fake daemons, fake pages, fake locators, fake browser contexts, fake runners, fake process supervisors, or dependency-injected test doubles.
- Do not test implementation shape by reading source files, test files, Markdown, or documentation and matching strings or regular expressions.

### Credential and macOS Keychain Safety

Tokenless does not need, own, or directly access a user's Keychain password, encryption keys, browser credentials, cookies, or browser-storage secrets. Browser authentication state must remain opaque inside the user-controlled managed browser profile.

- Never ask the user for a macOS login password, Keychain password, browser password, cookie, token, encryption key, hidden authentication header, or browser-storage value.
- Never inspect, read, export, log, transmit, copy, or attempt to decrypt Keychain items or browser authentication secrets. Do not use `security`, Keychain APIs, credential-dumping tools, browser storage extraction, or equivalent mechanisms to obtain them.
- Never automate, approve, dismiss as harmless, or instruct the user to approve a macOS Keychain prompt on behalf of Tokenless. In particular, never select `Allow` or `Always Allow` for an automated test or development browser.
- Automated tests, development helpers, and test-only browsers must not trigger a system Keychain prompt. A test that opens such a prompt is interactive, unsafe by default, and failed even if its command later exits successfully.
- The existing test-only browser target `profile` must retain Playwright's keychain-neutral defaults, including `--password-store=basic` and `--use-mock-keychain`. Production browser targets may preserve their normal browser-managed credential behavior, but that behavior must not be inherited by test-only targets.
- Real-boundary browser testing remains mandatory where required. Preventing Keychain access does not justify replacing the real CLI, daemon, filesystem, persistent Chromium context, provider network, or visible website with a mock or simulation.
- If any Tokenless-triggered Keychain prompt appears, stop the responsible test or spawned browser, tell the user to choose `Deny` or `Cancel` without entering a password, record the run as failed, and fix the launch configuration before rerunning it.
- Before completing a browser-launch change, verify that test-only launch options remain keychain-neutral, production launch options were not unintentionally changed, Chromium sandboxing remains enabled, spawned processes are cleaned up, and the focused real-boundary test finishes without a Keychain prompt.

Regression record: a provider-less `profiles open` conformance test once launched Playwright's Google Chrome for Testing executable through the test-only `profile` target while removing Playwright's `--password-store=basic` and `--use-mock-keychain` defaults. macOS then displayed a `Chromium Safe Storage` prompt. The approved fix scopes the removal of those defaults to non-`profile` targets. Do not broaden or reverse that condition.

### Provider DOM Fixture Policy

- Provider DOM fixtures are development aids only. They are allowed only when they are redacted, provenance-bound reductions of DOM genuinely captured from a real visible provider session.
- Use fixtures only for focused development checks of selectors, parsers, sanitization, and already-observed DOM variants.
- Never install a fixture route in a built CLI or daemon browser E2E, intercept provider network traffic for E2E, label a fixture-based check as E2E or live, or count fixture evidence toward a capability matrix, support declaration, release gate, or provider acceptance criterion.
- Do not invent synthetic provider DOM, simulate a provider transition or response, or infer live behavior from separate before-and-after fixtures.
- Continuously capture materially distinct, capability-relevant DOM states discovered during real provider testing: redact the real state, record its provenance, add it to the checked-in fixture manifest, and use it for focused development checks of selectors, parsers, and already-observed DOM variants. Preserve distinct account tiers, blockers, menus, composer states, attachment states, project states, and provider DOM variants when they change observable capability behavior.

### Real Provider Browser E2E

- Run every browser E2E and every visible-provider capability acceptance test against the real provider website with the built CLI, packaged daemon, real managed browser, real provider network, and no fixture route, network interception, or simulated provider response.
- Require explicitly gated real provider E2E closure for state transitions and provider-side effects, including model or effort changes, accepted uploads, prompt submission, response generation, citations, conversation continuation, and native Project creation, reuse, instruction application, or chat.
- Provider browser E2E is a manual local release prerequisite, not a CI job. Pull requests should include a non-enforced reminder to run it, and every applicable E2E must pass before release.
- An invoked E2E suite must never skip a required case and must not retry internally, except for the checked-in Claude Cloudflare known issue declared in `test/live-provider-capability-matrix.json`. That exception may skip only when the durable job payload has provider `claude` and a structured blocker code of `visible_cloudflare_turnstile` or `visible_cloudflare_interstitial`. Missing activation, unavailable authentication, provider failure, any other blocker state, or another unmet prerequisite must fail with a clear reason. Retry only by manually running the suite again.
- Use the explicitly selected local managed profile already provisioned through Tokenless setup. Do not create a separate test account, automate login, or silently switch profiles. Real messages, conversations, Projects, attachments, retained test artifacts, and provider usage cost are acceptable; identify them with unique run-scoped markers and never use cost as a reason to substitute fixture evidence.
- Keep assertions semantic and focused on the core user flow. Do not collect E2E screenshots, full DOM dumps, cookies, local storage, session storage, credentials, or unrelated account content.
- If an external integration cannot run safely by default, add an explicitly gated real integration or browser E2E test. Do not replace the unavailable integration with a simulation.
- Assert commands, durable state, visible browser outcomes, and real protocol results rather than internal method calls or collaborator interactions.
