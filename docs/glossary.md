# Tokenless Glossary

Canonical terms for how Tokenless interacts with AI provider web surfaces. This glossary describes execution boundaries; it is not a provider support declaration.

## Product layers

| Term | Definition | Do not use as a synonym |
|---|---|---|
| **Tokenless API** | The provider-facing HTTP/API layer of Tokenless, including the Universal API. It accepts API requests and owns provider-turn routing and lifecycle; it is separate from the Tokenless Harness. | Tokenless Harness, provider's official API |
| **Tokenless Harness** | Tokenless's independent first-party agent runtime in `packages/harness/`. It owns AgentRun state, Skills, tool discovery and execution, MCP, approvals, continuation, and final output, and uses the Tokenless API over HTTP. | Tokenless API, external Harness |
| **Tokenless Harness API** | The caller-facing local API exposed by the Tokenless Harness. It starts, observes, resumes, and cancels AgentRuns and, for explicitly authorized local clients, exchanges Harness-owned tool actions and results. It sits above and uses the Tokenless API; it is not a provider-facing API. | Tokenless API, Dashboard UI API, external Harness API |

## Harness model roles

| Term | Definition | Do not use as a synonym |
|---|---|---|
| **Harness AI Engine** | A model used internally by Tokenless Harness sidecars for bounded auxiliary inference, such as title generation, task classification, provider routing, result summaries, and labels; it does not execute the Harness task or replace the Tokenless API route. | Harness Task Model, provider route, Tokenless API |
| **Harness Task Model** | The provider model that executes the Harness user's task through the Tokenless API and its selected provider route. | Harness AI Engine, sidecar model |
| **AI Sidecar** | A Harness-owned auxiliary component that uses the Harness AI Engine outside the current in-process provider-execution loop. | Provider adapter, Harness task executor |
| **Front Door** | The pre-run AI Sidecar that prepares conversation metadata and selects a concrete Tokenless API provider route before a Harness run starts. | Tokenless API router, Harness AI Engine |
| **Exit Door** | The post-run AI Sidecar that summarizes and labels a terminal Harness result without changing that result. | Harness finalizer, Harness Task Model |

## Execution modes

| Term | Definition | Do not use as a synonym |
|---|---|---|
| **Browser Mode** | The public V1 API route selected by `tokenless.execution_mode: browser`. Tokenless completes the provider turn through visible browser automation. | Headless browser, direct provider protocol |
| **Direct Mode** | The public V1 API route selected by `tokenless.execution_mode: direct`. Tokenless completes the provider turn through a direct provider protocol and the selected backend. | Official provider API, visible browser automation |
| **Visible Browser Automation** | Tokenless controls a real, user-visible browser and interacts with the provider website through its UI. | Direct protocol, HTTP impersonation |
| **Headless Browser Execution** | A real browser process runs without a visible window while retaining its JavaScript engine, DOM, storage, and network stack. | HTTP impersonation, fake browser |
| **HTTP Impersonation** | A non-browser HTTP client calls provider web endpoints while reproducing browser-like network and request characteristics, such as TLS/HTTP2 fingerprints and headers, without launching a browser process. | Headless browser, browser automation |
| **Browser-Assisted HTTP Impersonation** | HTTP impersonation remains the main provider data plane while an isolated headless browser supplies a browser-only prerequisite such as a JavaScript challenge result, CAPTCHA proof, PoW token, or short-lived request token. | Visible browser automation, full browser execution |
| **Direct Provider Protocol** | Tokenless communicates with a provider's web protocol without operating the provider's visible UI, using HTTP impersonation alone or browser-assisted HTTP impersonation. | Official provider API, visible browser automation |

## Authentication and routing

| Term | Definition | Do not use as a synonym |
|---|---|---|
| **Guest Mode** | A provider request runs without Tokenless supplying an authenticated provider session. | Unauthenticated daemon request |
| **Auth Context** | A provider-scoped set of explicitly selected session inputs and a declared lifetime used by one direct backend. | Browser profile, account |
| **Session Bootstrap** | Tokenless derives only the selected provider's required session inputs from an explicitly selected source before a direct request. | Login automation, implicit cookie scanning |
| **Native Backend** | A direct provider implementation maintained inside the Tokenless codebase. | Visible browser automation |
| **G4F Backend** | A direct provider implementation executed by Tokenless's private, pinned GPT4Free service. | Public G4F API, visible browser automation |

## Relationships

```text
Visible Browser Automation
  -> real visible browser -> provider UI

Direct Provider Protocol
  -> HTTP Impersonation -> provider web endpoint
  -> Browser-Assisted HTTP Impersonation
       -> isolated headless browser -> challenge artifact
       -> impersonating HTTP client -> provider web endpoint
```

- **HTTP Impersonation** never implies that Chrome or another browser process is running.
- **Headless Browser Execution** always means that a real browser process is running, even though no window is shown.
- **Browser-Assisted HTTP Impersonation** uses the headless browser only where the protocol requires browser execution; the main request still travels through the impersonating HTTP client.
- Daemon authentication and provider **Guest Mode** are separate: a caller may authenticate to Tokenless while the provider request remains guest.
- **Browser Mode** and **Direct Mode** are values of one V1 API routing contract, not separate public APIs. The JSON request field is `tokenless.execution_mode`; internal TypeScript contracts use `executionMode`.
- The **Harness AI Engine** serves **AI Sidecars** only; it never becomes the model route that executes the user's Harness task.
- The **Harness Task Model** is always reached through the **Tokenless API**, whether the **Harness AI Engine** is local, browser-provided, or remote.
- **Front Door** may select the provider route for a **Harness Task Model**, but its own inference still runs on the separate **Harness AI Engine**.
- The **Tokenless Harness API** is the caller-facing control and tool-exchange interface for the **Tokenless Harness**. The Harness continues to reach the **Harness Task Model** only through the **Tokenless API**.

## Example dialogue

> **Developer:** "Does the GLM direct path use a browser?"
>
> **Domain expert:** "It uses **Browser-Assisted HTTP Impersonation**: an isolated **Headless Browser Execution** produces the challenge artifact, then **HTTP Impersonation** sends the chat request."
>
> **Developer:** "So it is not **Visible Browser Automation**?"
>
> **Domain expert:** "Correct. No provider UI is exposed or controlled in that path."

> **Developer:** "If Front Door uses a local Qwen model, does the Harness task also run on Qwen?"
>
> **Domain expert:** "No. Qwen is the **Harness AI Engine** for the **AI Sidecar**. The **Harness Task Model** still runs through the **Tokenless API** on the provider route selected by **Front Door**."

## Ambiguous terms to avoid

- **Browser impersonation** is ambiguous. Say **HTTP Impersonation** when no browser process runs, or **Browser-Assisted HTTP Impersonation** when a headless browser supplies a prerequisite.
- **Browser Mode** is the API selector. When discussing implementation, say **Visible Browser Automation** rather than using it as a synonym for every kind of browser execution.
- **Direct Mode** is the API selector. When discussing implementation, also name the **Native Backend** or **G4F Backend** when that distinction matters.
- **Harness model** is ambiguous. Say **Harness AI Engine** for sidecar inference and **Harness Task Model** for the provider model executing the user's task through the Tokenless API.
- **Harness AI Engine** must not describe every model connected to the Harness; it names only the internal sidecar inference dependency.
