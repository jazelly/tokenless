# Repository Development Rules

## Language

- Use English for code, identifiers, package/config keys, and inline comments.
- Localize every reasonable user-facing surface in both English and Simplified Chinese. Never ship one language alone or assume users know the other.
- Keep commands, flags, identifiers, protocol fields, provider/model names, and clearer technical terms unchanged.
- Keep language selection and fallback consistent; cover externally visible localization through real boundaries.
- Keep paired docs, such as `README.md` and `README.zh-CN.md`, structurally and semantically aligned.
- Internal technical docs may remain English when translation adds no user value.

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

- Test externally observable behavior through real boundaries: built CLI, packaged TypeScript daemon, filesystem, local Chromium/Playwright, or provider website.
- Use focused integration or browser E2E for cross-runner/runtime/provider behavior. Prefer browser proof when feasible.
- Keep default browser E2E to representative core flows. Cover rare crash/restart or failure injection only when required, reproduced, or visibly material; otherwise use focused real-boundary integration.
- No unit tests, mocks, fakes, stubs, spies, synthetic fetches, fake runtime/browser objects, injected test doubles, or source/doc regex tests.

### Credential and macOS Keychain Safety

- Browser auth stays opaque in the user-controlled managed profile. After explicit user consent, Tokenless may copy a user-selected browser profile only as an opaque local filesystem tree between user-controlled profiles; it must not parse or expose individual authentication values.
- Never request, inspect, export, log, transmit, decrypt, or dump passwords, cookies, tokens, keys, hidden auth headers, Keychain items, or browser-storage secrets; never use `security`, Keychain APIs, or equivalent tools. An explicitly authorized opaque local profile copy is not secret extraction.
- Never automate or encourage Keychain approval, including `Allow` or `Always Allow`.
- Tests, helpers, and test browsers must not trigger Keychain prompts. Any prompt fails the run: stop the browser/test, tell the user to choose `Deny` or `Cancel` without a password, then fix launch settings before retrying.
- Test target `profile` must retain `--password-store=basic` and `--use-mock-keychain`. Only non-`profile` production targets may remove them.
- Keychain safety never permits mocked browser boundaries.
- For browser-launch changes, verify keychain-neutral test options, unchanged production options, enabled Chromium sandboxing, process cleanup, and focused real-boundary completion without prompts.
- Regression guard: never reverse or broaden removal of the two keychain-neutral flags beyond non-`profile` targets; doing so caused the prior `Chromium Safe Storage` prompt in provider-less `profiles open` conformance.

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
