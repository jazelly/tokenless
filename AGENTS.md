# Tokenless

Tokenless is a standalone project. Keep it independent from Noop: Noop may consume Tokenless packages, but Tokenless must not import Noop internals or depend on Noop workspace scripts.

Project content, package names, docs, and code are written in English.

Never assume that Tokenless owns or controls an npm scope, package namespace, domain name, organization, registry namespace, or similarly reserved identifier. Before introducing or depending on a scoped package such as `@tokenless/*`, verify that the user controls that namespace or obtain the user's explicit confirmation. Treat an existing scoped package reference as a local workspace implementation detail, not proof that the namespace is available for publication.

Use focused integration or browser E2E tests for behavior that crosses the Playwright runner, local runtime, or provider web sessions. Do not mock visible-session behavior when a browser proof is feasible.

The former browser extension and Native Messaging host live under `legacy/` and are not part of the active product. Do not mention them in user-facing docs, skills, or setup guidance.

Do not publish packages, releases, or other artifacts unless the user explicitly asks for publication. Otherwise, prepare and merge changes into `main`, then wait for explicit publication approval. Treat `main` as the user-facing mainline.
