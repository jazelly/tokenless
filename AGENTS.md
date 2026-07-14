# Tokenless

Tokenless is a standalone project. Keep it independent from Noop: Noop may consume Tokenless packages, but Tokenless must not import Noop internals or depend on Noop workspace scripts.

Project content, package names, docs, and code are written in English.

Use focused integration or browser-extension E2E tests for behavior that crosses the extension, runner, local runtime, or provider web sessions. Do not mock visible-session behavior when a browser proof is feasible.

Do not store or extract provider cookies, localStorage/sessionStorage tokens, hidden auth headers, or private provider backend API calls. Tokenless visible-session adapters operate only through user-visible browser UI after the user grants extension host permission.

Do not publish packages, extensions, releases, or other artifacts unless the user explicitly asks for publication. Otherwise, prepare and merge changes into `main`, then wait for explicit publication approval. Treat `main` as the user-facing mainline.
