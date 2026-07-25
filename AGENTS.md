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

## Testing

Use focused integration or browser E2E tests for behavior that crosses the Playwright runner, local runtime, or provider web sessions. Do not mock visible-session behavior when a browser proof is feasible.

- Test only externally observable behavior through real system boundaries: the built CLI process, the packaged Rust daemon, the real filesystem, a real local Chromium/Playwright session, or a real provider website.
- Do not add unit tests.
- Do not introduce mocks, fakes, stubs, spies, synthetic fetch implementations, fake daemons, fake pages, fake locators, fake browser contexts, fake runners, fake process supervisors, or dependency-injected test doubles.
- Do not test implementation shape by reading source files, test files, Markdown, or documentation and matching strings or regular expressions.
- Provider DOM fixtures are allowed only when they are redacted, provenance-bound reductions of DOM genuinely captured from an authenticated visible provider session. Do not invent synthetic provider DOM and present it as provider evidence.
- If an external integration cannot run safely by default, add an explicitly gated real integration or browser E2E test. Do not replace the unavailable integration with a simulation.
- Assert commands, durable state, visible browser outcomes, and real protocol results rather than internal method calls or collaborator interactions.
