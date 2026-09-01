# Capability Matrix

[简体中文](capability-matrix.zh-CN.md)

The Tokenless Capability Matrix is the public contract between caller outcomes and provider implementations. It lets users request work without depending on a provider's button names, and it gives contributors one evidence standard for adding or changing provider support.

This document is normative for capability naming, mapping, support states, and extension. For current product reconnaissance that has not necessarily become Tokenless support, see the [Provider Capability Census](provider-capability-census.md).

## The Four Separate Concerns

Tokenless keeps four related concerns separate:

1. **Canonical capability catalog** — provider-neutral outcomes a caller may require, such as `conversation.chat`, `file.upload`, `document.input`, or `search.web`.
2. **Provider bindings** — evidence-backed mappings from canonical outcomes to namespaced provider workflows and controls.
3. **User-owned Skills** — caller-selected `SKILL.md` context delivered by the Web Agent Harness; this is job input, not a provider capability.
4. **Live acceptance matrix** — real-provider cases that must pass through the built CLI, packaged daemon, managed browser, and provider network before a route can be advertised.

A provider-specific control is not automatically a canonical capability. For example, DeepSeek `Search` is an adapter control that may implement `search.web`; Dola `translate` is a namespaced workflow that currently implements a specialized chat path. The public contract describes the outcome, while the adapter owns provider UI details.

A user-selected Skill is also not a capability. The Harness resolves and content-addresses its `SKILL.md`, then delivers it through ordinary `file.upload` alongside the Harness System Prompt. The eligible provider therefore needs `conversation.chat`, `file.upload`, and `document.input`; it never needs `skill.invoke`.

## User Model

List the machine-readable catalog without opening a browser:

```bash
tokenless capabilities list --json
```

Request one or more outcomes with repeatable flags:

```bash
tokenless run \
  --capability file.upload \
  --attach-file proposal.pdf \
  --prompt "Review this proposal."
```

Tokenless combines explicit requirements with structural inference:

- a normal submit-and-read run requires `conversation.chat`;
- any attachment requires the transport capability `file.upload`;
- image, audio, video, and other document attachments additionally require exactly their matching semantic input capability (`image.input`, `audio.input`, `video.input`, or `document.input`); and
- `--workspace-mode auto` or `native` requires `workspace.native`.

Implications are expanded before provider selection. One provider must satisfy the complete requirement set; Tokenless never silently drops a required outcome.

## Current Routeable Matrix

This table summarizes checked-in routes. The CLI output is the authoritative current list.

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi | Dola | Arena | Meta AI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Supported | Experimental |
| `conversation.continue` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `model.compare` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `agent.execute` | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `file.upload` (transport) | Supported | Supported | Experimental | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental |
| `document.input` | Supported | Supported | Experimental | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | — | Experimental |
| `image.input` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `audio.input` | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `video.input` | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `image.generation` | Experimental | — | Experimental | Experimental | — | — | — | — | Experimental | — | — | Experimental | Experimental |
| `image.edit` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `artifact.download` | Experimental | — | Experimental | Experimental | — | — | — | — | Experimental | — | — | Experimental | Experimental |
| `website.generation` | — | — | — | — | — | — | — | — | — | — | — | — | — |
| `video.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `search.web` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |
| `response.citations` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |

`—` means no route is advertised. It does not necessarily mean the provider product lacks the feature; the implementation or real-provider evidence may still be incomplete.

The current table is the **Browser execution matrix**. The catalog also exposes independent direct bindings: ChatGPT has `conversation.chat`, `image.generation`, and `artifact.download`; Perplexity has its direct `conversation.chat` binding. Direct evidence is never inferred from a Browser route or from a provider descriptor that happens to list `direct`.

Routes are evaluated as a complete requirement set. For example, an image attachment requires both `file.upload` and `image.input`, while a Markdown/PDF attachment requires both `file.upload` and `document.input`; the transport row alone does not make a semantic input routeable.

## Harness Attachment Eligibility

The 2026-08-31 live gate uploads the compiled `tokenless-harness-system--*.md`, accepts one framed tool call, executes `workspace.read`, uploads `tokenless-tool-result--*.md` in the same conversation, and requires the child run to succeed without provider fallback.

| Provider | Harness state | Current real-browser result |
| --- | --- | --- |
| ChatGPT | Verified | Full bootstrap and continuation Markdown round-trip passed |
| Gemini | Verified | Full round-trip passed after waiting for the upload trigger to return after page redraw |
| DeepSeek | Verified | Full bootstrap and continuation Markdown round-trip passed |
| Z.ai | Verified | Button activation produced no transition, so the adapter used ordinary Enter submission; continuation used the conversation-page composer |
| Doubao | Verified | The exact desktop-promotion dialog was dismissed before submission; both Markdown turns completed |
| Kimi | Verified | The selected `web-ai` Cloak profile is signed in on `kimi.ai`; both Markdown turns completed |
| Dola | Verified | Full bootstrap and continuation Markdown round-trip passed |
| Claude | Unavailable | Generic Markdown upload, submit, and response passed, but the response rejected the Harness attachment as prompt injection |
| Grok | Unavailable | The selected profile is under a visible weekly rate limit until 2026-09-02 06:47:22 UTC |
| Qwen | Verified | The built CLI and packaged daemon completed the Harness attachment round-trip in 74,595ms: two submissions, visible attachment/submission/response proof, one conversation with two visible turns, durable state, and no fallback |
| Perplexity | Unavailable | The selected Free profile has 3 uploads per day; current submission history used all 3 while the two-turn Harness request needs 2 more |
| Arena | Unavailable | The real file input accepts PNG, JPEG, and WebP, but not Markdown |
| Meta AI | Unavailable | Generic Markdown upload passed, but the real Harness attachment instruction was silently rejected without creating a conversation |

Generic document input remains separately advertised for Claude, Grok, Perplexity, and Meta AI because their Markdown upload evidence is independent of Harness protocol compliance. Qwen now has Harness-verified `file.upload` plus `document.input` evidence. Private provider-turn V0, Harness Auto, and the semantic router require `harness-attachment-roundtrip` evidence; Arena's experimental `file.upload` route is image-scoped and has no `document.input` route.

ChatGPT, Gemini, Grok, Doubao, Arena, and Meta AI Image artifacts are downloaded through the selected Playwright browser session into task-, conversation-, job-, and time-scoped `assets/` directories. The public response contains only the relative asset reference, media type, dimensions, byte size, and SHA-256 digest; signed provider URLs remain in-memory only. The authenticated daemon `GET /v1/private/assets/{taskId}/{conversationId}/{assetBatch}/{assetFile}` endpoint returns verified bytes with the actual image media type; traversal, corrupt, and missing assets fail closed.

ChatGPT `image.generation` and `artifact.download` are experimental routes. The image reader selects only the latest visible `section[data-turn="assistant"]`, deduplicates repeated `[id^="image-"] img` elements by canonical URL, waits for the stop control to disappear, downloads provider/CDN HTTPS bytes through the selected browser session, verifies browser-decoded dimensions, and omits signed URLs from the response. The real asset run produced one deduplicated 1254×1254 PNG and proved DOM bytes, local digest, browser decoding, and authenticated daemon readback.

Grok `image.generation` and `artifact.download` are experimental routes on the independent Imagine Image surface. Tokenless selects exact ×2 output, records the pre-submit post set, waits for exactly two new terminal post identities, ignores the data-URI grid previews, opens each current `/imagine/post/:assetId`, and downloads only the matching `assets.grok.com/.../generated/:assetId/` HTTPS image. The real asset run produced two 768×1152 JPEGs and proved baseline set-difference, post identity, provider bytes, local digest, browser decoding, and authenticated daemon readback.

Arena `conversation.chat`, `conversation.continue`, and `model.compare` are supported for a selected signed-in profile, with the `conversation.chat` route covered by the stronger `conversation-continuation` evidence. Before a new text conversation, the adapter selects exact **Direct** mode; `model.inspect` and `model.select` can choose one exact visible Direct model before submission and restore the original **Max** router. The built CLI and packaged daemon proved a substantive selected-model response, a persisted `/c/:conversationId` mapping, and a second CLI process using the same daemon returning only the latest answer from the same URL. Battle returns both anonymous answers with `model: null`; Side-by-Side returns both answers with the two visible selected model labels. Generic clients receive complete A/B text, while structured clients also receive `alternatives`. Arena `search.web` and `response.citations` are experimental. Arena `image.generation` and `artifact.download` remain experimental for prompt-only Direct Image; its experimental `file.upload` transport is paired with `image.input` and accepts only PNG, JPEG, and WebP rather than Harness Markdown. Arena has no `document.input` route. Arena `website.generation` and `agent.execute` are currently unavailable: repeated focused real-provider runs on 2026-09-01 hit daemon job timeouts after 300 seconds, so their routes are not advertised until stable completed-response evidence returns. Arena `video.generation` remains experimental on its independent surface. The adapter also handles the exact provider-owned **Terms of Use & Privacy Policy** → **Agree** onboarding dialog; fresh-account repetition remains pending because the selected account has already accepted it.

The authenticated `POST /v1/images/generations` endpoint is the canonical image input for browser and direct execution. Browser auto routing intersects enabled, usable providers with both `image.generation` and `artifact.download`; provider-specific image actions are assembled only after that route is selected. Gemini and Doubao join the previously closed browser image routes. Direct V1 keeps `tokenless/pollinations/sana` and adds explicit `tokenless/chatgpt/gpt-image`; both use the same scoped asset contract and keep private backend names out of public model IDs, responses, and capability evidence. ChatGPT direct image execution bootstraps a short-lived provider-scoped session from the selected managed browser, submits through the private adapter, and returns only verified local assets. Both modes return common authenticated asset URLs and metadata. The real direct Pollinations gate generated and read back one 768×768 JPEG, and focused Gemini and Doubao gates each completed one visible submission, terminal artifact, local digest, and authenticated readback.

Browser image requests may carry one 8 MiB-or-smaller PNG, JPEG, or WebP `reference_image` data URL. Such requests require `image.edit`, `image.input`, `file.upload`, and `artifact.download`; remote URLs and direct-mode reference images fail before provider submission. Arena's experimental image-only route satisfies that complete Browser requirement set for its accepted PNG, JPEG, and WebP formats. The route's `arena-image` evidence does not establish `document.input` or Harness Markdown support.

The opt-in local [API proxy](api-proxy-integration.md) covers `conversation.chat` for any provider enabled on the resolved profile, named as `tokenless/<provider>`. Its OpenAI Chat Completions route implements modern function calls in non-streaming or terminal SSE form: Tokenless validates the catalog and complete one-to-one result history, while the caller remains the only tool executor. The generic prompt-emulation layer is available to every eligible text conversation provider; provider-specific evidence records observed conformance instead of forming an allowlist. Tokenless accepts bare JSON, one complete `json`/`text` fence, or exactly one top-level JSON object surrounded by non-executable prose. The recovered object must still pass protocol, nonce, tool choice, call-count, history, argument/schema, and response-format validation; multiple candidates or extra protocol markers fail closed. See [current Gemini evidence](evidence/openai-structured-control-gemini-2026-08-27.md) and [earlier framing evidence](evidence/openai-tool-prompt-framing-2026-08-15.md). `tool_choice` supports auto, none, required, and one exact named function; omitted/true `parallel_tool_calls` permits multiple model-ordered calls, false permits at most one, and a named choice always produces exactly one. `strict: true` admits only recursively closed object schemas with every property required, and returned arguments are schema-validated. Framing, choice, call-count, or schema violations fail with `provider_output_protocol_error`; only a nonce-correlated strict JSON serialization failure for `final` or `tool_calls` may receive one same-kind bounded correction. The packaged daemon completed real DeepSeek tool loops in [single-call](evidence/openai-tool-choice-strict-deepseek-2026-08-15.md), [sequential streaming](evidence/dsh-streaming-tool-loop-2026-08-15.md), and [multiple-call](evidence/openai-multiple-tool-calls-deepseek-2026-08-15.md) forms. OpenAI structured finals now accept `json_object` and a published recursively closed `json_schema` subset with or without tools; successful non-stream and terminal SSE content is strict JSON that passes the declared schema, otherwise the request fails explicitly. Structured numbers are canonical finite JSON numbers and integral schema/output values are JavaScript safe integers. `$defs`, `$ref`, root `anyOf`, and unlisted schema keywords are rejected before a job. The Responses aliases now expose the same function/structured semantics with typed terminal events, full-input replay, and a bounded provider-affine `previous_response_id` ledger; see the [real current-SDK evidence](evidence/openai-responses-deepseek-2026-08-15.md). Anthropic tool use remains unadvertised. Specialized comparison, Search, Image, Code, Agent, and Video outcomes stay on the task API so their structured output is preserved.

The reserved `tokenless/auto` model is advertised only for OpenAI browser-mode requests in `new-conversation` mode. It intersects selected-profile enablement and current access with the `conversation.chat` matrix; every resulting text route can carry Tokenless-owned prompt-emulated structured control. Complete validation covers tools, strict schemas, history replay, request-permitted multiple calls, and text/`json_object`/`json_schema` final control. Selection prefers the origin encoded in the most recent auto public call id, then the existing capability rank and configured order. The exact canonical call/result pair is replayed into a new provider conversation with the same public id; provider-local URLs and opaque state are not portable. The existing Managed Playwright fallback plan may switch only before `provider_submitted_at`; post-submission failure is terminal, and same-provider bounded correction bypasses auto selection. The response `tokenless` object exposes the settled provider and prompt strategy. [Current redacted evidence](evidence/openai-auto-provider-routing-2026-08-15.md) covers the DeepSeek-to-ChatGPT tool continuation, both JSON strategies, and a natural post-submission terminal failure; [current Gemini evidence](evidence/openai-structured-control-gemini-2026-08-27.md) records a narrower observed tool run without constraining generic eligibility.

A fixed real-provider revalidation on 2026-08-15 observed ChatGPT at 5/5 public-valid named strict calls and 4/5 public-valid nested JSON Schema finals (9/10 combined). DeepSeek produced no public response in two five-minute pilots because both jobs remained pre-submission queued; this is an availability result, not a schema-accuracy result. Gemini's upstream diagnostics did not yield a reliable public-rate ledger and remained excluded at that time; later evidence admits only its narrow single-call tool scope. See the [rate evidence](evidence/openai-structured-control-rate-2026-08-15.md) and [current Gemini evidence](evidence/openai-structured-control-gemini-2026-08-27.md).

Meta AI `conversation.chat`, generic Markdown `file.upload`, `image.generation`, and `artifact.download` remain experimental for the selected signed-in profile. Short, large, exact-byte, and Harness-filename Markdown probes all uploaded successfully. The real Harness attachment plus its execution instruction cleared the composer but silently remained on the home page without creating a conversation, so the generic upload route remains separate from Harness eligibility. The independent image route remains unchanged.

Gemini Markdown `file.upload` is experimental and Harness-verified for the selected profile. Gemini removes filename suffixes from card text and accessibility metadata, so its provider-specific proof requires a newly visible physical `gem-attachment` card while retaining the validated caller-selected extension. The upload path waits for **Upload and tools** after page redraw, selects **Upload files**, and dismisses the optional MMGen disclaimer with **Cancel** rather than accepting it for the user.

Gemini `image.generation` and `artifact.download` are experimental browser routes. The image action enters Gemini Images before prompt input; the reader correlates a newly visible decoded `<img>` against the pre-submit blob baseline, exports the still-decoded image through canvas before the revoked blob URL becomes unreadable, persists the PNG, and proves authenticated daemon readback.

On 2026-08-09, the built CLI and packaged daemon used headed Cloak `web-ai` to upload three Markdown documents and read an attachment-grounded visible response (job `tlp_0b9dde88-e2c2-46e5-8231-81b4f74403e1`; 27.3 seconds provider end-to-end). The Tokenless-rendered request submitted to Gemini contained the frozen 521-character Matrix V2 user prompt verbatim; the complete rendered request was 853 characters and was not identical to that user prompt. The local output-savings event recorded 295 estimated output tokens for 1,607 visible response characters with `o200k_base`; it is a local visible-output estimate, not provider billing or input-token telemetry.

Qwen's visible **Select Mode** → **Upload attachment** path is implemented and Markdown `file.upload` plus `document.input` are experimental and Harness-verified. The adapter waits for the visible spinner/`Parsing...` terminal state, removes only an exact-name matching pending stale draft with its card-local **Remove file** control, then clicks the visible upload path and sets the current `#filesUpload` input once (no chooser or retry). Completed assistant cards retain `.qwen-chat-message-awaiting-response`, so terminal busy state uses only the real `button.stop-button`; the 2026-09-01 built CLI/packaged-daemon gate completed two submissions in one conversation with visible two-turn responses and durable state.

DeepSeek `conversation.chat` and Markdown `file.upload` are experimental and Harness-verified for the selected profile. The current live gate completed bootstrap upload, framed `workspace.read`, same-conversation tool-result upload, exact final proof, and a succeeded child run without fallback.

DeepSeek retains provider-specific controls and candidate mappings outside that route:

| DeepSeek behavior | Canonical outcome | Public route state |
| --- | --- | --- |
| Instant chat and visible final response | `conversation.chat` | Experimental routeable |
| Same-conversation follow-up | `conversation.continue` | Gate pending |
| Markdown file selection in Instant | `file.upload` | Experimental routeable |
| Vision image input | `image.input` | Gate pending |
| Search in Instant | `search.web` | Gate pending |
| DeepThink | `reasoning.extended` | Gate pending |
| Visible source links | `response.citations` | Gate pending |

Perplexity `conversation.chat` and generic Markdown `file.upload` remain experimental. The selected Free profile is cataloged at the official 3 uploads per day; its current provider-submission history has used all 3, while one complete Harness round-trip requests 2 uploads. The Tokenless API capacity guard excludes the profile before browser work and does not bypass the plan gate. Consumer Pro, Education Pro, and Max retain non-numeric published limits; Enterprise Pro and Max record their official 100/week, 1000/week, and 30-per-upload limits.

Z.ai `conversation.chat` and Markdown `file.upload` are experimental and Harness-verified on `https://chat.z.ai/`. The attachment card and prompt were present, but clicking the enabled send button produced no transition; the narrow provider adapter presses Enter only after that failed acceptance window. Continuation also recognizes the conversation-page `Send a Message` composer.

Doubao `conversation.chat` and Markdown `file.upload` are experimental and Harness-verified for the selected signed-in profile. A provider-owned desktop-promotion dialog covered submit; the adapter dismisses only a visible dialog containing exact `下载电脑版` and exact `关闭`, then both bootstrap and continuation complete normally.

Doubao `image.generation` and `artifact.download` are experimental browser routes. The image lifecycle selects the existing `doubao.skill` value `image-generation` before prompt input, correlates the latest assistant image turn against the pre-submit baseline, persists terminal image bytes, and proves authenticated daemon readback. Doubao also exposes provider-specific `doubao.mode` and `doubao.skill` actions. An earlier non-submission gate inspected and restored the mode and skill controls, but a focused 2026-08-17 rerun now fails at `doubao.mode.inspect`; that selector regression remains separate from the independently passing image route. Other controls still require their own complete outcome lifecycle.

Doubao `auth.status` also reads the visible account control and opens only its account menu. A visible `升级到专业版` item is derived as `免费版` / `signed_in_free`; unobserved paid-account states remain `signed_in_unknown` rather than being inferred from the purchase page's default selected offer.

Kimi `conversation.chat`, Markdown `file.upload`, `search.web`, and search-backed `response.citations` remain experimental. The product moved from `kimi.com` to `kimi.ai`; after the user signed in through the selected `web-ai` Cloak profile, the full bootstrap and continuation Harness round-trip passed on the new origin.

Dola is registered as an experimental signed-in provider. Its general `conversation.chat` and Markdown `file.upload` routes are Harness-verified. Its Create Image `image.generation` and `artifact.download` routes are currently unavailable: the focused 2026-09-01 real run reached `daemon_unavailable` after 300 seconds, so the image routes are not advertised until complete image and artifact evidence returns.

| Dola control or surface | Canonical outcome candidates | Current evidence and route state |
| --- | --- | --- |
| Chat and same-conversation follow-up | `conversation.chat`, `conversation.continue` | Harness bootstrap and tool-result turns completed in one conversation; `conversation.chat` is experimental routeable |
| Fast / Pro | `conversation.chat`; provider control `model.choice` | Both choices are live-observed; exact selection and restoration gate pending |
| Add file | `file.upload` | Bootstrap and continuation Markdown cards were individually observed and consumed; experimental routeable |
| Create Image / AI Creation | `image.generation`, `artifact.download` | Currently unavailable: the focused 2026-09-01 real run reached `daemon_unavailable` after 300 seconds, so no complete image or artifact closure is advertised |
| Writing | `document.generation` or `conversation.chat` | `write_assistant` entry is live-observed; output form is not yet proven, so no document or downloadable-file claim |
| Create Video | `video.generation` | `video_generation` entry is live-observed; progress, terminal video, and bounded artifact reference pending |
| Translate | `conversation.chat`; provider workflow `dola.translate` | `translate` entry is live-observed; correlated translated output pending |
| Homework | `conversation.chat`; provider workflow `dola.exercise_assistant` | `exercise_assistant` entry is live-observed; terminal homework outcome pending; no extended-reasoning claim is inferred from the button |
| Projects, file library, or persistent knowledge | `workspace.native`, `workspace.knowledge`, `artifact.download` | Unavailable: no Project, file-library, or persistent knowledge-management surface was observed |

Dola has no independently observed **Create File** control. The visible **Writing** entry must not be treated as file creation unless a real run produces a completed document; a downloadable result would additionally require `artifact.download` evidence.

| Doubao control | Canonical outcome candidates | Public route state |
| --- | --- | --- |
| Fast | `conversation.chat` | Chat mutation gate pending |
| Expert | `reasoning.extended` | Control closed; outcome gate pending |
| Work Task Turbo / Pro | `task.background`, `task.interactive` | Turbo control closed; Pro visibly requires upgrade; outcome gates pending |
| Help Me Write | `document.generation` | Control closed; artifact gate pending |
| PPT Generation | `presentation.generation` | Control closed; artifact gate pending |
| Image Generation | `image.generation` | Control closed; artifact gate pending |
| Video Generation | `video.generation` | Control closed; artifact gate pending |
| Deep Research | `research.deep` | Control closed; research lifecycle gate pending |
| AI Podcast / Music Generation | `audio.generation` | Controls closed; artifact gates pending |
| Problem Solving | `conversation.chat`, `reasoning.extended` | Control closed; reasoning outcome gate pending |
| AI Spreadsheet | `spreadsheet.generation`, `data.analyze` | Control closed; artifact and analysis gates pending |
| Audio Transcription | `audio.transcription` | Unavailable on Web; desktop app required |

## Capability Families

The V2 catalog groups outcomes by durable semantics, not by provider marketing categories:

| Family | Canonical capabilities |
| --- | --- |
| Conversation | `conversation.chat`, `conversation.continue` |
| Input | `file.upload` (transport), `document.input`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
| Retrieval and reasoning | `search.web`, `research.deep`, `reasoning.extended`, `audio.transcription`, `code.execute`, `data.analyze` |
| Media generation | `image.generation`, `image.edit`, `video.generation`, `audio.generation` |
| Artifact generation | `document.generation`, `presentation.generation`, `spreadsheet.generation`, `website.generation` |
| Workspace and knowledge | `workspace.native`, `workspace.instructions`, `workspace.knowledge`, `source.connected` |
| Evidence and lifecycle | `response.citations`, `artifact.download`, `task.background`, `task.interactive` |

Candidate entries remain visible in the catalog even when they have no route. This makes the intended vocabulary discoverable without overstating support.

## What a Capability Defines

Every canonical capability defines:

- a stable identifier and user-facing outcome;
- a JSON parameter schema;
- lifecycle: `immediate`, `interactive`, or `long_running`;
- externally meaningful side effects;
- implied, composable, and conflicting capabilities;
- required visible and durable evidence;
- normalized output kinds; and
- catalog stability: `candidate`, `experimental`, or `supported`.

Provider routes separately declare their strategy, evidence identifiers, and `experimental` or `supported` route status. Runtime eligibility is a third dimension: `eligible`, `unchecked`, or `ineligible` for the selected profile at that moment.

These states must not be collapsed. A stable catalog definition may have no provider route, and a supported route may still be temporarily ineligible because the selected profile is signed out, challenged, rate-limited, or missing the required visible control.

## Evidence Ladder

Each provider/capability cell progresses independently:

1. `product_documented` — official provider material describes the product feature.
2. `live_observed` — a real visible session exposes the relevant state or control.
3. `implemented` — a provider strategy implements the complete intended lifecycle.
4. `e2e_closed` — the built CLI and packaged daemon prove the final outcome against the real provider.
5. `routeable` — the public router may advertise and select the provider route.

A menu item, selector, local replica, or successful manual prompt is not sufficient to claim `e2e_closed`. Provider behavior is developed and verified only on the real provider website; real-provider E2E is the acceptance boundary.

## Adding a New Capability

Add a canonical capability when the product needs a new provider-neutral outcome, not merely because one provider added a control or marketing label.

1. **Define the semantics.** State the user outcome, parameters, outputs, lifecycle, side effects, implications, conflicts, and terminal conditions.
2. **Check for composition first.** Prefer an existing capability or a combination of existing capabilities when it expresses the result without losing meaning.
3. **Add the catalog definition.** Update `packages/server/src/providers/task-capabilities.ts` and keep the identifier independent of provider names.
4. **Implement provider strategies.** Keep selectors and provider-specific controls inside provider adapters and typed capability classes.
5. **Implement against the real site.** Observe and exercise every materially distinct selector, parser state, blocker, and transition in the configured persistent browser profile. Do not capture or substitute provider DOM fixtures.
6. **Declare live acceptance.** Add the real case to `test/live-provider-capability-matrix.json` and implement its journey in `test/live-managed-playwright.e2e.mjs`.
7. **Close the real boundary.** Run the built CLI, packaged daemon, managed browser, and provider network without local replicas, interception, or simulated responses.
8. **Add the route last.** Advertise the mapping only after the required lifecycle and evidence close.
9. **Update public documentation.** Keep this document, both READMEs, command documentation, and the release changeset aligned.

### Admission Questions

Before adding an identifier, answer all of these:

- Is this a user-visible outcome rather than a UI control?
- Would at least two providers plausibly implement the same semantics?
- Are success, failure, cancellation, and continuation boundaries testable?
- Can parameters and outputs be normalized without discarding essential behavior?
- Does it need a new lifecycle or safety contract rather than a new capability?
- Would composition of existing capabilities be clearer?

Provider-only concepts remain namespaced actions or workflows such as `deepseek.mode`, `kimi.skill`, `dola.translate`, or `dola.exercise_assistant`. They can implement a canonical capability without entering the public catalog themselves. User-owned Skills stay in the Harness context interface and never enter this namespace.

## Compatibility and Versioning

The current catalog schema is `tokenless.task-capability-catalog.v3`. V3 adds `executionMode` to each provider binding so Browser and direct evidence cannot be conflated. Runtime capability routes use `tokenless.task-capability-route.v2` and carry the same mode through resolver, validator, and managed jobs. V2 removed `skill.invoke`; provider-native workflows remain namespaced provider controls, while user-owned Skills are Harness inputs delivered through `file.upload`.

- Adding an independent capability is normally additive.
- Adding an optional parameter may be additive when existing requests keep identical semantics.
- Changing the meaning, required parameters, output contract, implications, or safety boundary is breaking; introduce a new capability identifier or catalog schema version.
- Adding or removing a provider route changes support availability, not the meaning of the canonical capability.
- Provider UI labels and selectors may change without changing the public capability when the outcome contract remains intact.

Persisted jobs record their normalized capability route and evidence identifiers, so implementations must not reinterpret an existing job under incompatible semantics.

## Sources of Truth

| Concern | Source |
| --- | --- |
| Catalog definitions and provider routes | `packages/server/src/providers/task-capabilities.ts` |
| Provider-specific actions and payload contracts | `packages/server/src/providers/contracts.ts` and `action-catalog.ts` |
| Provider implementations | `packages/server/src/providers/` |
| Real-provider required cases | `test/live-provider-capability-matrix.json` |
| Real-provider journeys | `test/live-managed-playwright.e2e.mjs` |
| Provider website test boundary | `AGENTS.md` and `test/live-provider-capability-matrix.json` |
| Product reconnaissance | `docs/provider-capability-census.md` |
| CLI behavior | `COMMANDS.md` |

When documentation and runtime output disagree, treat `tokenless capabilities list --json` and the checked-in source as authoritative, then correct the documentation in the same change.
