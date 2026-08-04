# Local Web Control Plane

Status: implemented; real-provider release evidence pending | Priority: P0

Depends on: authenticated loopback daemon, managed profile lifecycle, provider registry and capability catalog, embedded browser-runtime supervision, durable jobs, and browser page ownership

Implementation note (2026-08-04): phases 0–4 and the currently stable phase-5 surfaces are implemented in the bundled CLI package. This includes profile-scoped preferences and migration, shared application services, one-time UI bootstrap and browser sessions, the `/ui-api/v1` contract, reserved control-plane page ownership, first-run Web setup/dashboard handoff, all six administration areas, clean and explicit-consent imported profile flows, provider/browser/job mutations, capability-first routing views, freshly observed model/effort controls, revision/ETag polling that preserves unsaved edits, English and Simplified Chinese localization, URL-persisted profile and job filters, and redacted diagnostics. The browser application is a modular Svelte 5 application under `packages/cli/src/daemon/ui`, built by its own Vite boundary into deterministic self-hosted assets while remaining part of the CLI release artifact. Its separate Playwright Web E2E covers setup, installed-runtime discovery, executable-path validation, explicit opaque local profile copy and re-import, responsive display at desktop/mobile viewports, accessible navigation and dialogs, configuration and profile persistence, durable work display, polling-safe drafts, and reserved control-plane page ownership. One explicitly gated signed-in provider suite reuses one real completed ChatGPT job across fixture-composed desktop-fresh, desktop-reload, and mobile-fresh startup cases without rerunning the full provider matrix. Browser profile source handles are random, short-lived, and resolved only inside the daemon; the browser never receives source filesystem paths or authentication values. Scheduler projections and project/context-mirror views remain conditional on the separate roadmaps that own those contracts. The roadmap stays active until the required authenticated real-provider release matrix is run.

## Outcome

Tokenless provides a browser-based control plane served by the local daemon. After an interactive setup completes, Tokenless opens one reserved control-plane tab in the selected managed browser profile. The same interface remains available later for configuration, provider and account readiness, browser profiles, capabilities, jobs, user handoffs, diagnostics, and recovery.

The control plane is the human-facing authority over Tokenless configuration. The CLI remains a complete scripting and recovery interface, but users should not need to inspect JSON files or remember administrative commands for ordinary management.

The first release must let a user answer these questions without opening a terminal:

- Is Tokenless healthy and which daemon and browser are active?
- Which managed browser identity is selected, and what purpose or role does it serve?
- Which providers has the user enabled for that profile?
- What account, access class, and subscription evidence was last observed for each provider?
- Which capabilities are supported, unavailable, or still unverified for the selected provider/profile?
- Which jobs are queued, running, waiting for the user, or complete?
- What action is required when a provider needs sign-in, CAPTCHA, MFA, consent, or confirmation?
- Which configuration changed, when was it saved, and whether a browser restart is required?

## Product Principles

- **User intent, not geolocation:** never infer provider membership from IP address, locale, language, timezone, or proxy presence. Only providers explicitly enabled by the user belong to the routing scope.
- **Configured, observed, and usable are different states:** enabling Gemini records intent; a successful live observation records current access; capability and scheduler policy determine runtime eligibility.
- **One local source of truth:** the UI and CLI call shared application services. The daemon must not spawn the CLI or maintain a second configuration model.
- **Visible and honest state:** show exact durable states and observation timestamps. Do not invent percentages, token streaming, provider health, or account capabilities.
- **Local-first:** serve only from a verified loopback origin. Do not introduce a hosted account, telemetry dependency, or remote administration surface.
- **Credentials remain opaque:** never expose provider cookies, browser storage, Keychain contents, daemon bearer tokens, or hidden provider data to browser JavaScript.
- **Safe browser ownership:** the control-plane tab is a reserved browser resource and can never be claimed, replaced, or navigated by a provider job.
- **Simple first release:** use ordinary HTTP and bounded polling before adding SSE or WebSockets.

## Non-Goals

The first control-plane release does not:

- automate provider sign-in, CAPTCHA, MFA, payment, consent, or account creation;
- detect whether a user is in mainland China or any other region;
- install, start, configure, or inspect Clash, V2Ray, Xray, sing-box, VPN software, or proxy subscriptions;
- read browser credentials, cookies, local storage, session storage, or Keychain data;
- parse, display, or extract authentication values from a copied browser profile;
- expose the daemon on the LAN or public Internet;
- replace provider websites with embedded iframes;
- make experimental capabilities supported without real-provider E2E closure; or
- turn the internal daemon bearer contract into a browser API.

## Current Behavior Audit

The current implementation has useful foundations but no browser-facing product surface:

- the daemon binds only to loopback and exposes authenticated job and browser-runtime routes;
- the daemon owns durable SQLite job state and an embedded Playwright runtime;
- configuration is stored in `config.json` and currently includes provider scope, browser, visibility, daemon URL, and language;
- managed profiles have stable IDs, labels, lifecycle state, default selection, legacy provenance where applicable, and cached provider observations;
- provider descriptors and canonical capability routes are typed and centrally registered;
- jobs expose durable queued, claimed, running, waiting-for-user, and terminal states;
- `profiles open` can start a headed managed profile without navigating to a provider; and
- setup currently selects every non-disabled provider and performs a live observation for each one.

Important gaps are:

- provider selection is not an actual setup choice;
- most configuration and profile mutations exist only in CLI code;
- the daemon API has no least-privilege browser session, configuration, profile, provider-readiness, or capability-management resources;
- the internal daemon bearer token cannot safely be placed in browser JavaScript;
- setup does not open a durable local status and management page;
- there is no reserved control-plane page identity in the managed browser page registry;
- provider and browser errors are not presented as one actionable health model;
- language bootstrap detects the system locale before first-time `setup`, but a different first command can still read the empty config default and present English before the user has had any chance to choose; and
- global `preferredProviders` was too coarse for multiple browser identities and its name did not communicate that it was a routing membership filter.

## Product State Model

The UI must preserve separate layers instead of collapsing them into one green or red provider badge.

| Layer | Question | Example states |
| --- | --- | --- |
| Configuration | Did the user enable this provider for this profile? | enabled, disabled |
| Observation | What did the last visible check prove? | guest, signed in, sign-in required, unknown, technical failure |
| Freshness | When was that observation made? | current, stale, never checked |
| Capability | Can this provider/profile satisfy this outcome? | supported, experimental, unavailable, unknown |
| Runtime eligibility | May the router select it now? | eligible, ineligible, deferred |
| Browser state | Is its managed browser identity available? | closed, opening, ready, waiting for user, quiescing, failed |

Disabling a provider removes it from implicit routing and setup sweeps. It does not erase the provider adapter, cached historical observation, or capability catalog entry. Re-enabling it does not claim it is usable; the UI offers an explicit live check.

Provider configuration should move toward a per-profile routing scope:

```ts
type ManagedProfilePreferences = {
  profileId: string
  roleLabel: string
  enabledProviders: ProviderId[]
  browserVisibility: "auto" | "headed" | "headless"
  proxy: { server: string; bypass: string[] } | null
}
```

`roleLabel` is human metadata such as `Personal`, `Work`, or `Research`; it is not authorization or provider identity. The provider account display name and subscription observation remain separate visible evidence.

The initial proxy field accepts only a user-managed local HTTP, HTTPS, or SOCKS5 endpoint. Tokenless does not infer upstream protocols such as VLESS Reality and does not claim that a configured endpoint is reachable until a real browser navigation proves it. Credential-bearing proxies require a later secret-storage design and are not part of the first proxy slice.

## Information Architecture

### Language Bootstrap

Language selection happens before the first user-facing byte is rendered. It is not a step inside setup and it does not depend on geolocation.

Every CLI process uses this precedence before full argument parsing, help, validation, error formatting, or command dispatch:

1. an explicit language supplied through a supported bootstrap override;
2. a valid persisted `config.language`;
3. the first recognized system locale from `LC_ALL`, `LC_MESSAGES`, `LANG`, and the runtime locale; and
4. English when no supported language can be recognized.

Locale detection is an initial guess, not identity or geography. A Chinese locale selects Simplified Chinese because that is the currently supported Chinese surface; an imperfect guess is recoverable through an always-visible language switch. The absence of a completed setup must never force English.

The web control plane follows the same persisted preference. If no language has been persisted yet, the daemon selects the first response language from the browser request language and system locale before serving the initial HTML. The page must not render English first and switch after JavaScript loads. The first screen always exposes `English` and `简体中文` as language choices, and a user selection becomes the persisted preference shared by the CLI, control plane, and default provider response language.

### Overview

The landing page is an operational summary, not a setup wizard and not a marketing dashboard.

It shows:

- daemon version, origin, uptime, and update compatibility;
- browser runtime state and active managed profiles;
- the current default profile and its role label;
- enabled provider readiness with last-checked timestamps;
- active and waiting jobs;
- the most important actionable problem; and
- shortcuts to open the managed browser, inspect a provider, or resume a waiting job.

### Browser Profiles

The profiles area manages isolated browser identities:

- create a clean profile;
- label its purpose or role;
- set the default profile;
- choose its enabled providers;
- choose browser visibility;
- configure an optional user-managed proxy endpoint;
- open the profile without provider navigation;
- remove a profile through an explicit destructive confirmation.

The UI starts clean by default. After the user explicitly selects a discovered local Chromium profile and consents, it can copy that one profile as an opaque filesystem tree into a new managed profile, or re-import the same recorded source. Discovery returns only bounded display metadata and a short-lived opaque source handle; source paths and individual authentication values never enter browser JavaScript. Users may instead sign in through the visible clean managed profile, whose runtime binding and browser-owned session persist across jobs.

### Providers

The provider area is a profile-scoped matrix. Each provider card shows:

- enabled or disabled membership;
- supported or experimental product stage;
- cached access and account observation;
- observation time and freshness;
- exact visible account display and subscription evidence when available;
- canonical capability coverage;
- current technical or user-resolvable blocker; and
- actions to open the provider, perform a live readiness check, inspect visible controls, or disable routing.

Opening a provider is a user-visible navigation action. A live check must never submit a prompt, upload a file, change a model, or accept consent.

### Capabilities

The capabilities area starts with caller outcomes such as conversation chat, file upload, native workspace, image generation, and deep research. It must not lead with provider DOM controls.

For each capability, show:

- lifecycle and stability;
- required visible evidence;
- providers with an evidence-backed route;
- providers that are experimental, unavailable, or unknown;
- account or profile constraints; and
- the difference between declared product support and current runtime eligibility.

Advanced provider controls such as exact model and effort labels remain a secondary provider-profile screen and must use labels freshly observed from the visible site.

### Jobs

The jobs area reads the durable daemon state and supports:

- filtering by status, profile, provider, task, and agent session;
- a compact timeline of durable transitions;
- route and capability decisions;
- user-action blockers;
- cancellation of one exact job;
- headed resume of the same waiting job;
- final normalized output and citations; and
- structured, redacted error details and repair actions.

The UI does not display claim tokens, runner checkpoints, staged private file paths, raw DOM, provider cookies, or browser storage.

### System and Diagnostics

System settings cover language, browser target, daemon origin, update compatibility, and browser-runtime controls. Diagnostics combine the existing doctor report with actionable categories:

- configuration;
- daemon and package compatibility;
- browser discovery and launch;
- profile lifecycle and filesystem permissions;
- provider navigation, DNS, proxy, TLS, authentication, and visible blockers; and
- job scheduler and recovery state.

Raw diagnostic JSON may be offered as an explicit copy action after redaction. The default presentation should explain what failed, what Tokenless observed, and what the user can safely do next.

## Core User Flows

### Interactive Setup Handoff

1. Setup installs and reconciles the runtime, chooses a browser, creates or reuses a clean managed profile, and starts the daemon.
2. Setup records the user's provider choices instead of selecting every registered provider.
3. Setup performs live checks only for the selected providers.
4. Regardless of whether some provider checks succeed, require sign-in, or fail technically, setup opens the selected managed profile in headed mode.
5. The browser receives a reserved Tokenless control-plane page and navigates it through a one-time UI bootstrap URL.
6. The landing page displays the completed setup state and unresolved actions.

Machine-oriented `setup --json`, non-interactive environments, and explicit no-open modes must not launch a visible browser. Their result includes a command that an authorized user can run later to open the control plane.

### Provider Enablement

1. The user enables a provider for one managed profile.
2. The setting is saved immediately as user intent.
3. The UI offers a live readiness check and explains that it will visibly open the provider without submitting content.
4. If the page is ready, Tokenless records the access and account observation.
5. If user action is required, the same profile and page remain open and the UI shows the exact handoff.
6. After the user finishes, they explicitly recheck; Tokenless does not poll credentials or scrape hidden browser state.
7. Technical failure remains distinct from sign-in-required and does not silently disable the provider.

### Waiting Job Handoff

1. A running job reaches `waiting_for_user` with a structured blocker.
2. The overview and jobs page surface the blocker.
3. The user opens the exact managed profile and provider page.
4. After completing the visible action, the user resumes the same job in headed mode.
5. The job keeps its identity, task, route, and durable history.

## Reserved Browser Page

The control-plane page needs explicit ownership in `ManagedBrowserContext`:

```text
tokenless:control-plane:<daemon-home-id>
```

Requirements:

- one reserved control-plane page per active managed browser profile;
- provider jobs cannot acquire, replace, close, or navigate it;
- `pagePolicy: replace` selects only replaceable provider pages;
- the control-plane page may be recreated if the user closes it;
- reopening focuses the existing page instead of producing duplicates;
- closing the page does not stop the daemon or browser runtime;
- quiescing or closing a profile closes the page with that context; and
- the page origin is the daemon's current recorded loopback origin, including a dynamically selected port.

The daemon UI must not depend on the provider page scheduler to stay alive. Reserved pages and provider page leases are separate registries even though they share one persistent browser context.

## Browser-Facing API and Authentication

Keep the existing bearer-protected daemon API as the trusted machine control contract. Add a separate browser-facing surface under `/ui-api/v1` backed by the same application services.

The browser must never receive the daemon control bearer token. Bootstrap uses a one-time, random, short-lived ticket minted by an authenticated CLI or internal daemon call:

1. the CLI requests a UI bootstrap ticket over the existing authenticated control channel;
2. Tokenless opens `/ui/bootstrap?ticket=<one-time-ticket>` in the managed browser;
3. the daemon consumes the ticket once, creates a short-lived UI session, and immediately redirects to `/ui/` so the ticket is removed from browser history;
4. the session is held in an `HttpOnly`, `SameSite=Strict`, path-scoped cookie; and
5. mutating UI requests additionally require an exact same-origin check and a per-session CSRF header.

Browser security requirements include:

- verified loopback bind and `Host` validation to resist DNS rebinding;
- no wildcard CORS and no credentialed cross-origin access;
- exact `Origin` validation for every mutation;
- a restrictive Content Security Policy with no remote scripts;
- `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`;
- bounded session expiry and invalidation on daemon restart;
- no secrets in query strings after the one-time redirect;
- no daemon token, provider credentials, profile storage, or private filesystem paths in UI responses; and
- explicit reauthentication through a fresh CLI-minted ticket after expiry.

Static UI assets may be served without authentication, but every personalized read and mutation requires the UI session. The first implementation should use bounded polling with `ETag` or revision cursors for overview, runtime, provider observations, and jobs. Do not add SSE or WebSockets until polling creates a measured product problem.

## Application Service Boundary

Before adding UI routes, extract shared application services from CLI command handlers:

```text
ConfigService
ProfileAdminService
ProviderReadinessService
CapabilityCatalogService
BrowserRuntimeService
JobQueryService
JobCommandService
DiagnosticsService
```

Both CLI and `/ui-api/v1` call these services. Services own validation, authorization-independent domain rules, filesystem locking, daemon coordination, and public redaction. Transport handlers own HTTP parsing, UI-session authorization, CSRF, status codes, and response schemas.

The browser-facing API should initially expose:

- one aggregate overview snapshot;
- config read and update;
- profile list, clean or explicit-consent opaque-copy create, re-import, label, default, and remove;
- per-profile provider membership and cached observations;
- explicit provider open, readiness check, and controls inspection;
- capability catalog and route availability;
- browser-runtime status and profile open;
- job list, detail, cancel, and resume; and
- redacted diagnostics.

Every mutation must be represented in the checked-in OpenAPI contract or a separate checked-in UI API contract before the UI consumes it. UI response schemas should be purpose-built rather than exposing internal persistence records directly.

## Frontend Delivery

Build a bundled TypeScript single-page application under the CLI package and copy its static output into the published package. The browser loads no remote JavaScript, fonts, analytics, or runtime CDN assets.

The implementation should:

- support English and Simplified Chinese from the same message catalog as the CLI where practical;
- select the response language before rendering the initial HTML so the first screen never flashes the wrong default language;
- follow keyboard and screen-reader accessible navigation and forms;
- use native browser controls for basic settings rather than custom widgets;
- provide deterministic empty, loading, stale, waiting, error, and offline states;
- preserve user edits only after the daemon confirms the write;
- identify settings that require browser quiescence or restart before applying them; and
- remain usable at laptop widths without treating mobile administration as a release requirement.

Visual design requires a separate design target and review before frontend implementation. This roadmap defines product structure and behavior, not a final visual system.

## Delivery Phases

### Phase 0: Shared Services and Contracts

- Extract config, profile, provider-readiness, job, and diagnostic operations from CLI handlers into typed services.
- Define per-profile provider preferences and a migration from global `preferredProviders` without changing routing silently.
- Define browser-facing schemas and redaction policy.
- Add UI bootstrap ticket and session contracts.
- Add reserved control-plane page ownership to the managed browser context.

### Phase 1: Read-Only Operational Console

- Package and serve the local SPA.
- Implement authenticated UI bootstrap.
- Show overview, daemon/browser status, profiles, provider observations, capability catalog, job list, job details, and diagnostics.
- Add `tokenless dashboard` to start or discover the daemon, open the default managed profile, and focus the reserved console tab.
- Keep all mutations in the CLI during this phase.

### Phase 2: Setup Handoff and Provider Configuration

- Make interactive setup collect provider membership instead of selecting every provider.
- Check only selected providers.
- Open the control plane after setup and display its exact result.
- Add profile-scoped provider enable/disable, open, readiness check, and visible controls inspection.
- Preserve sign-in and challenge handling as visible user actions.

### Phase 3: Profile and Browser Administration

- Add clean profile creation, explicit-consent opaque local Chromium profile copy and re-import, label/role editing, default selection, and removal without parsing authentication state.
- Add browser selection, visibility, runtime open, quiesce, and restart-required flows.
- Add optional user-managed proxy server and bypass configuration with validation and safe redaction.
- Prevent mutations while unsafe profile ownership or active jobs make them ambiguous.

### Phase 4: Jobs and User Handoffs

- Add job filtering, detail timelines, cancellation, and same-job headed resume.
- Surface queue, blocker, capability route, and provider/profile identity without exposing internal claim data.
- Link waiting jobs to the exact browser profile and provider page.
- Add bounded revision-based polling and stale/offline recovery.

### Phase 5: Advanced Capability and Routing Management

- Add capability-first routing explanations and provider/profile eligibility.
- Add freshly observed model and effort selection where supported.
- Add scheduler capacity and rate-limit projections when the scheduling roadmap implements them.
- Add agent-session, Project, conversation, and context-mirror views only after their underlying contracts are stable.

## Testing and Evidence

Follow the repository's real-boundary testing policy:

- test the packaged SPA through the real built daemon and a real local Chromium/Playwright page;
- exercise configuration and profile mutations against real temporary Tokenless homes and real filesystems;
- keep test-only profile launches keychain-neutral with `--password-store=basic` and `--use-mock-keychain`;
- verify the control-plane page cannot be selected by provider page acquisition or replacement;
- compose real-provider Web UI startup cases from an ignored local fixture that names the dedicated home, profile, provider, context mode, reload mode, and viewport;
- verify bootstrap ticket expiry, single use, session invalidation, same-origin enforcement, CSRF rejection, Host validation, CSP, and redaction through real HTTP requests and browser behavior;
- do not use mocks, fake daemons, fake pages, synthetic fetch implementations, or source-string assertions;
- run provider readiness, sign-in handoff, capability inspection, and provider-side mutations against the real provider website under the explicit local E2E gate; and
- treat any Tokenless-triggered Keychain prompt as a failed run and stop the responsible browser.

The first read-only release is accepted when a fresh packaged installation can start the real daemon, open the reserved local console in a keychain-neutral test profile, display real config/profile/job/runtime state, survive provider jobs without losing its tab, and expose no control bearer token or browser secret to page JavaScript.

The provider-configuration release is accepted only after the real selected-profile flow proves that enabling, opening, observing, disabling, and re-enabling a provider changes routing membership and visible state without submitting a prompt or inspecting browser secrets.

## Documentation and Compatibility

- Add `tokenless dashboard` and control-plane behavior to `COMMANDS.md`, `README.md`, and `README.zh-CN.md` when implemented.
- Keep English and Chinese user-facing structure and meaning aligned.
- Document UI schemas before treating them as a public local API.
- Include a changeset for every user-visible release slice.
- Preserve CLI equivalents for recovery and automation.
- Do not advertise localhost administration as remote access.
