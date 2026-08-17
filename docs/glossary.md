# Tokenless Glossary

Canonical terms for how Tokenless interacts with AI provider web surfaces. This glossary describes execution boundaries; it is not a provider support declaration.

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

## Example dialogue

> **Developer:** "Does the GLM direct path use a browser?"
>
> **Domain expert:** "It uses **Browser-Assisted HTTP Impersonation**: an isolated **Headless Browser Execution** produces the challenge artifact, then **HTTP Impersonation** sends the chat request."
>
> **Developer:** "So it is not **Visible Browser Automation**?"
>
> **Domain expert:** "Correct. No provider UI is exposed or controlled in that path."

## Ambiguous terms to avoid

- **Browser impersonation** is ambiguous. Say **HTTP Impersonation** when no browser process runs, or **Browser-Assisted HTTP Impersonation** when a headless browser supplies a prerequisite.
- **Browser Mode** is the API selector. When discussing implementation, say **Visible Browser Automation** rather than using it as a synonym for every kind of browser execution.
- **Direct Mode** is the API selector. When discussing implementation, also name the **Native Backend** or **G4F Backend** when that distinction matters.
