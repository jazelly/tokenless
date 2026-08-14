# Capability Matrix

[简体中文](capability-matrix.zh-CN.md)

The Tokenless Capability Matrix is the public contract between caller outcomes and provider implementations. It lets users request work without depending on a provider's button names, and it gives contributors one evidence standard for adding or changing provider support.

This document is normative for capability naming, mapping, support states, and extension. For current product reconnaissance that has not necessarily become Tokenless support, see the [Provider Capability Census](provider-capability-census.md).

## The Four Separate Concerns

Tokenless keeps four related concerns separate:

1. **Canonical capability catalog** — provider-neutral outcomes a caller may require, such as `conversation.chat`, `file.upload`, or `search.web`.
2. **Provider bindings** — evidence-backed mappings from canonical outcomes to namespaced provider workflows and controls.
3. **User-owned Skills** — caller-selected `SKILL.md` context delivered by the Web Agent Harness; this is job input, not a provider capability.
4. **Live acceptance matrix** — real-provider cases that must pass through the built CLI, packaged daemon, managed browser, and provider network before a route can be advertised.

A provider-specific control is not automatically a canonical capability. For example, DeepSeek `Search` is an adapter control that may implement `search.web`; Dola `translate` is a namespaced workflow that currently implements a specialized chat path. The public contract describes the outcome, while the adapter owns provider UI details.

A user-selected Skill is also not a capability. The Harness resolves and content-addresses its `SKILL.md`, then delivers it through ordinary `file.upload` alongside the Harness System Prompt. The eligible provider therefore needs `conversation.chat` and `file.upload`; it never needs `skill.invoke`.

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
- any attachment requires `file.upload`;
- image, audio, and video attachments additionally require their matching input capability; and
- `--workspace-mode auto` or `native` requires `workspace.native`.

Implications are expanded before provider selection. One provider must satisfy the complete requirement set; Tokenless never silently drops a required outcome.

## Current Routeable Matrix

This table summarizes checked-in routes. The CLI output is the authoritative current list.

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi | Dola | Arena | Meta AI |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | — | Supported | Experimental |
| `conversation.continue` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `model.compare` | — | — | — | — | — | — | — | — | — | — | — | Supported | — |
| `agent.execute` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `file.upload` | Supported | Supported | Experimental | Supported | — | Experimental | — | Experimental | Experimental | Experimental | — | Experimental | Experimental |
| `image.input` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `image.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `image.edit` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `website.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `video.generation` | — | — | — | — | — | — | — | — | — | — | — | Experimental | — |
| `search.web` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |
| `response.citations` | — | — | — | — | — | — | — | — | — | Experimental | — | Experimental | — |

`—` means no route is advertised. It does not necessarily mean the provider product lacks the feature; the implementation or real-provider evidence may still be incomplete.

Routes are evaluated as a complete requirement set. For example, an image attachment requires both `file.upload` and `image.input`; the `file.upload` row alone does not make image upload routeable.

Arena `conversation.chat`, `conversation.continue`, and `model.compare` are supported for a selected signed-in profile. Before a new text conversation, the adapter selects exact **Direct** mode; `model.inspect` and `model.select` can choose one exact visible Direct model before submission and restore the original **Max** router. The built CLI and packaged daemon proved a substantive selected-model response, durable `/c/:conversationId` mapping, and a second CLI process returning only the latest answer from the same URL. Battle returns both anonymous answers with `model: null`; Side-by-Side returns both answers with the two visible selected model labels. Generic clients receive complete A/B text, while structured clients also receive `alternatives`. Arena `search.web` and `response.citations` are experimental: requested search outcomes automatically select Direct Search, and the real reader returned one substantive grounded answer plus normalized HTTPS links from the source cards associated with that answer. Arena `file.upload`, `image.input`, `image.generation`, and `image.edit` are experimental. Image outcomes automatically select Direct Image and return current-answer `artifacts` with a visible HTTPS URL, media type, dimensions, and proof; real runs produced one 1024×1024 generated JPEG and one 1372×1146 edited PNG after visibly accepting the source image. Image tasks reject comparison/search surfaces, continuation, and generic model controls before daemon submission. Arena `website.generation` is experimental and automatically selects Direct Code. The real reader returned the current assistant's complete single `index.html` artifact, its correlated HTTPS `arena.site` preview, and visible download availability; code execution and artifact download remain unadvertised. Arena `agent.execute` is experimental and navigates the independent `/agent` surface rather than Direct Search. Its current-run reader returned one terminal answer, answer-scoped official citations, and structured visible tool steps after the provider displayed its task-success review panel; it never answers that review prompt. Agent attachments, continuation, comparison, Image/Code combinations, and model controls fail before daemon submission. Arena `video.generation` is experimental and automatically enters the independent Battle-only `/video` surface. Its current-turn reader returns both anonymous A/B HTTPS MP4 artifacts with dimensions and duration; the real run returned 1280×720/8-second and 848×480/8.041667-second videos, while model selection, attachments, continuation, download, and mixed-surface outcomes remain unavailable. The adapter also handles the exact provider-owned **Terms of Use & Privacy Policy** → **Agree** onboarding dialog; fresh-account repetition remains pending because the selected account has already accepted it.

The opt-in local [API proxy](api-proxy-integration.md) covers `conversation.chat` for any provider enabled on the resolved profile, named as `tokenless/<provider>`. Its OpenAI Chat Completions route implements the request boundary and prompt protocol for one modern function call in non-streaming or terminal SSE form: Tokenless validates the catalog and paired history, while the caller remains the only tool executor. Two repeated real DeepSeek invalid-final JSON escaping outputs admitted one bounded same-strategy correction only for a nonce-correlated `kind: final` envelope; no framing, tool-call, transport, or tool-execution failure is retried. The packaged daemon completed the non-streaming single-tool path through the real DeepSeek browser route: job `8a709343-5fd4-46b4-801c-434c5b4a8da0` returned standard `tool_calls` for `read_file` with `package.json`, the caller returned the actual local result in paired `role: tool` history, and job `8a3d2c42-e05c-478f-8518-22acb5a39467` returned a final `finish_reason: stop` answer grounded in the package metadata. A later [real unmodified DSH streaming run](evidence/dsh-streaming-tool-loop-2026-08-15.md) reconstructed two sequential single calls from stable terminal SSE deltas, executed both tools in DSH, and received a grounded final answer through the real DeepSeek browser route. Multiple calls in one assistant turn, forced tool choice, structured final output, Responses, and Anthropic tool use remain unadvertised. Specialized comparison, Search, Image, Code, Agent, and Video outcomes stay on the task API so their structured output is preserved.

Meta AI `conversation.chat` and `file.upload` are experimental for the selected signed-in profile. The built CLI and packaged daemon closed readiness, prompt drafting, exact Instant/Thinking selection with restoration, visible Markdown attachment acceptance, a substantive defensive browser-fingerprinting response, conversation fallback, and durable mapping through headed Cloak `web-ai` and the real `meta.ai` network boundary. A separate real run produced a visible 1920×1280 HTTPS WebP image tile, but `image.generation` remains unadvertised because the public CLI action protocol does not yet expose image cursor/start/observe/read. Thinking research steps and source lists are intermediate state; only the terminal assistant message is returned, and final visible citation links are not yet closed.

Gemini Markdown `file.upload` is experimental and routeable from an authenticated selected profile. Gemini removes filename suffixes from card text and accessibility metadata, so its provider-specific acceptance proof requires three newly visible physical `gem-attachment` cards while retaining the validated caller-selected extensions; the generic detector and other providers still require visible extension evidence. The upload path selects **Upload & tools** then **Upload files**, and dismisses the optional MMGen disclaimer with **Cancel** rather than accepting it for the user.

On 2026-08-09, the built CLI and packaged daemon used headed Cloak `web-ai` to upload three Markdown documents and read an attachment-grounded visible response (job `tlp_0b9dde88-e2c2-46e5-8231-81b4f74403e1`; 27.3 seconds provider end-to-end). The Tokenless-rendered request submitted to Gemini contained the frozen 521-character Matrix V2 user prompt verbatim; the complete rendered request was 853 characters and was not identical to that user prompt. The local output-savings event recorded 295 estimated output tokens for 1,607 visible response characters with `o200k_base`; it is a local visible-output estimate, not provider billing or input-token telemetry.

Qwen's visible **Select Mode** → **Upload attachment** chooser and physical Markdown card detection are implemented, but `file.upload` remains unadvertised. On 2026-08-09, a detached build of the task-scoped provider changes reached three visible `.fileitem-btn` cards whose extensions were all `.md`, and the 853-character rendered request contained the frozen 521-character Matrix V2 user prompt verbatim (job `tlp_14ec13d8-aba7-42c6-b328-f9095360d03a`; 14.6 seconds). The send click returned without a visible transition: the draft and all three cards remained, no answer or busy state appeared, and durable state kept `provider_submitted_at` unset. Because submission was ambiguous, the journey was not retried, no response or savings event exists, and the route remains unadvertised.

DeepSeek `conversation.chat` and Markdown `file.upload` are experimental and routeable from a signed-in selected profile. On 2026-08-09, the built CLI and packaged daemon used headed Cloak `web-ai` to add three Markdown cards, draft and submit the attachment-grounded prompt, and read its visible response (job `tlp_4cc2da64-7fe7-4582-a0d2-d648531fd930`; 28.3 seconds end-to-end). The local output-savings event recorded 305 estimated output tokens for 1,593 visible response characters with `o200k_base`; it is a local visible-output estimate, not provider billing or input-token telemetry.

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

Perplexity `conversation.chat` is experimental and routeable. Its guest session, prompt draft, submission, completed answer, normalized citations, visible citation links, conversation mapping, and durable state passed through the built CLI, packaged daemon, runtime-bound Cloak profile, and real provider network. Its visible **Add files or tools** menu and file chooser are implemented but `file.upload` remains unadvertised: on 2026-08-09, the selected Free plan displayed **Upgrade for additional document analysis** while selecting a third document, leaving only two visible attachment cards and preventing a complete real E2E closure. Continuation, model selection, Deep Research, Spaces, and generated assets also remain unadvertised.

Z.ai `conversation.chat` and Markdown `file.upload` are experimental and routeable. On 2026-08-09, the built CLI and packaged daemon used headed Cloak `web-ai` to add three physical visible Markdown chips, submit the exact attachment-detector prompt, and read the attachment-grounded response (job `tlp_0bc5f6de-b04d-4b35-85a0-2bd59e2ed227`; 34.1 seconds provider end-to-end). The job recorded 531 estimated output tokens and 2,770 visible characters with no provider blocker. The configured entry point is `https://z.ai/chat`; the official entry hands the prepared draft to the approved `https://chat.z.ai` runtime. Continuation, model or effort selection, and advanced GLM workflows remain unadvertised.

Doubao `file.upload` is experimental and routeable for file selection. Its visible plus control, provider file input, and accepted filename card passed through the built CLI, packaged daemon, runtime-bound Cloak profile, and real provider network. `conversation.chat` remains registered as an experimental signed-in route: readiness and prompt drafting passed in the same product path, and two direct submissions completed with correlated visible marker responses. The required built-product mutation gate is not release-closed because Doubao presented its visible provider-owned verification iframe when the E2E observer was attached. Challenge detection fails closed as `visible_provider_blocker`.

Doubao also exposes provider-specific `doubao.mode` and `doubao.skill` actions. The real non-submission gate inspected, selected, visibly verified, and restored Fast, Expert, Work Task Turbo, and every available coding-relevant Web skill. Work Task Pro is reported unavailable when the visible UI requires an upgrade; Audio Transcription is reported unavailable because the Web entry presents a desktop-app download flow. These controls map to canonical candidates, but selecting a control does not prove the complete outcome lifecycle, so no generation, research, reasoning, background-task, transcription, or spreadsheet route is advertised yet.

Doubao `auth.status` also reads the visible account control and opens only its account menu. A visible `升级到专业版` item is derived as `免费版` / `signed_in_free`; unobserved paid-account states remain `signed_in_unknown` rather than being inferred from the purchase page's default selected offer.

Kimi `conversation.chat`, text-file `file.upload`, `search.web`, and search-backed `response.citations` are experimental and routeable only from a signed-in selected profile. The built CLI, packaged daemon, runtime-bound Cloak profile, and real provider network closed readiness, prompt drafting, exact model and thinking-effort selection with restoration, file acceptance, an attachment-grounded response, exact Web search Auto/Off selection, normalized and visible citations, a second-process continuation on the same conversation URL, and durable task mapping. Plugin and Skill inspection and exact visible selection also passed the non-submission gate, but their complete submitted outcomes are currently blocked by Kimi's visible capacity queue and remain unadvertised. Projects, Deep Research, agent workflows, and artifact lifecycles have implementations and release gates but remain unadvertised because their real provider gates have not closed.

Dola is registered as an experimental signed-in provider. The user-selected managed profile visibly confirmed the chat composer, Fast/Pro model menu, file picker, conversation URLs, and Create Image, Writing, Create Video, Translate, and Homework entry points. On 2026-08-09, built CLI job `tlp_abc1d6ad-8b47-4ef9-80bc-ef8f50886fcd` failed after file selection in 18.1 seconds because the requested three-card acceptance proof was absent. Direct visible follow-up showed that selecting two or three Markdown documents together produced only one physical document card, and selecting another document afterward did not add a second card. No prompt was submitted. Dola `conversation.chat` and `file.upload` therefore remain unadvertised; the generation and specialist entry points also remain candidates until their terminal outcomes are independently proven.

| Dola control or surface | Canonical outcome candidates | Current evidence and route state |
| --- | --- | --- |
| Chat and same-conversation follow-up | `conversation.chat`, `conversation.continue` | Two correlated turns completed in the selected profile; built-product gates pending |
| Fast / Pro | `conversation.chat`; provider control `model.choice` | Both choices are live-observed; exact selection and restoration gate pending |
| Add file | `file.upload` | Relative upload control and Markdown card detection are implemented; the selected profile exposed only one physical card for multi-document and sequential selection, so the route remains unadvertised |
| Create Image / AI Creation | `image.generation` | Entry and Seedream image surface with model, ratio, style, and template controls are live-observed; completed image and bounded artifact reference pending |
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
| Input | `file.upload`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
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
3. **Add the catalog definition.** Update `packages/cli/src/providers/task-capabilities.ts` and keep the identifier independent of provider names.
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

The current catalog schema is `tokenless.task-capability-catalog.v2`. V2 removes `skill.invoke`; provider-native workflows remain namespaced provider controls, while user-owned Skills are Harness inputs delivered through `file.upload`.

- Adding an independent capability is normally additive.
- Adding an optional parameter may be additive when existing requests keep identical semantics.
- Changing the meaning, required parameters, output contract, implications, or safety boundary is breaking; introduce a new capability identifier or catalog schema version.
- Adding or removing a provider route changes support availability, not the meaning of the canonical capability.
- Provider UI labels and selectors may change without changing the public capability when the outcome contract remains intact.

Persisted jobs record their normalized capability route and evidence identifiers, so implementations must not reinterpret an existing job under incompatible semantics.

## Sources of Truth

| Concern | Source |
| --- | --- |
| Catalog definitions and provider routes | `packages/cli/src/providers/task-capabilities.ts` |
| Provider-specific actions and payload contracts | `packages/cli/src/providers/contracts.ts` and `action-catalog.ts` |
| Provider implementations | `packages/cli/src/providers/` |
| Real-provider required cases | `test/live-provider-capability-matrix.json` |
| Real-provider journeys | `test/live-managed-playwright.e2e.mjs` |
| Provider website test boundary | `AGENTS.md` and `test/live-provider-capability-matrix.json` |
| Product reconnaissance | `docs/provider-capability-census.md` |
| CLI behavior | `COMMANDS.md` |

When documentation and runtime output disagree, treat `tokenless capabilities list --json` and the checked-in source as authoritative, then correct the documentation in the same change.
