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

| Canonical capability | ChatGPT | Claude | Gemini | Grok | Qwen | DeepSeek | Perplexity | Z.ai | Doubao | Kimi | Dola |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `conversation.chat` | Supported | Supported | Supported | Supported | Experimental | Experimental | Experimental | Experimental | Experimental | Experimental | — |
| `file.upload` | Supported | Supported | — | Supported | — | Experimental | — | Experimental | Experimental | Experimental | — |
| `search.web` | — | — | — | — | — | — | — | — | — | Experimental | — |
| `response.citations` | — | — | — | — | — | — | — | — | — | Experimental | — |

`—` means no route is advertised. It does not necessarily mean the provider product lacks the feature; the implementation or real-provider evidence may still be incomplete.

Routes are evaluated as a complete requirement set. For example, an image attachment requires both `file.upload` and `image.input`; the `file.upload` row alone does not make image upload routeable.

Gemini `file.upload` remains unadvertised. On 2026-08-09, the authenticated selected profile exposed **Upload & tools** and its local file input, and selecting Markdown created a visible `gem-attachment` chip. The chip displayed only `README`, without the `.md` suffix or another visible Markdown type, so count-and-extension acceptance and the full real `file.upload` E2E lifecycle remain unclosed.

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

A menu item, selector, fixture, or successful manual prompt is not sufficient to claim `e2e_closed`. Fixtures support focused selector, parser, and sanitizer maintenance; real-provider E2E is the acceptance boundary.

## Adding a New Capability

Add a canonical capability when the product needs a new provider-neutral outcome, not merely because one provider added a control or marketing label.

1. **Define the semantics.** State the user outcome, parameters, outputs, lifecycle, side effects, implications, conflicts, and terminal conditions.
2. **Check for composition first.** Prefer an existing capability or a combination of existing capabilities when it expresses the result without losing meaning.
3. **Add the catalog definition.** Update `packages/cli/src/providers/task-capabilities.ts` and keep the identifier independent of provider names.
4. **Implement provider strategies.** Keep selectors and provider-specific controls inside provider adapters and typed capability classes.
5. **Capture real fixtures.** Save redacted, provenance-bound reductions for every materially distinct selector or parser state. Never invent or splice DOM.
6. **Declare live acceptance.** Add the real case to `test/live-provider-capability-matrix.json` and implement its journey in `test/live-managed-playwright.e2e.mjs`.
7. **Close the real boundary.** Run the built CLI, packaged daemon, managed browser, and provider network without fixtures, interception, or simulated responses.
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
| Fixture rules and inventory | `test/fixtures/provider-dom/README.md` and `manifest.json` |
| Product reconnaissance | `docs/provider-capability-census.md` |
| CLI behavior | `COMMANDS.md` |

When documentation and runtime output disagree, treat `tokenless capabilities list --json` and the checked-in source as authoritative, then correct the documentation in the same change.
