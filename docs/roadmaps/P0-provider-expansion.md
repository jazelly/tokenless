# Provider Expansion and Parity

Status: proposed | Priority: P0

Depends on: completed [Provider Architecture and Registry](archived/P0-provider-architecture-and-registry.md), existing managed Playwright, provider action protocol, real-provider E2E, and profile lifecycle

## Outcome

Tokenless supports a broader set of high-value AI web providers while preserving one honest capability catalog and provider-neutral contract. Adding a provider must improve user choice without weakening session isolation, execution-mode-specific verification, failure behavior, or maintainability.

## Current Implementation State

As of 2026-08-09:

- the shared registry extraction and OOP provider seam are complete and recorded in the archived [Provider Architecture and Registry](archived/P0-provider-architecture-and-registry.md) roadmap;
- Qwen / 千问 is registered as an `experimental` provider through one provider module and one registry entry;
- a fresh real managed guest profile completed prompt input, visible submission, and correlated response reading through the built CLI and TypeScript daemon;
- the canonical Qwen Studio entry is `https://chat.qwen.ai/`; a real built-CLI run navigated the same visible page to the shared `/c/guest` route and returned an exact correlated marker;
- navigation or reopen of the shared guest route does not restore the prior visible response, so cross-process continuation remains unavailable;
- Qwen's real-site live journeys cover the current Qwen Studio composer, mode, and completed-response states; and
- Qwen's provider-specific mode menu is exposed as `qwen.mode`, including runtime enabled/disabled discovery and exact Deep Research Normal/Advanced selection;
- the visible Auto/Thinking/Fast selector is exposed through the provider-neutral `effort.choice` capability; and
- the versioned canonical task-capability catalog and evidence-backed provider routing matrix are implemented in the CLI, with `conversation.chat`, `file.upload`, and `workspace.native` as the first routeable outcomes; and
- unproven Qwen model, file-upload, native workspace, and generated-media lifecycles remain `unknown` or `unavailable` rather than being inferred from visible controls.
- DeepSeek is registered as an `experimental`, sign-in-required provider with canonical navigation, signed-out session detection, visible chat contracts, and an explicit live acceptance classification;
- a real signed-out browser observation confirmed that `https://chat.deepseek.com/` redirects to `/sign_in` and exposes email/password, Google, and Apple login choices; and
- a real signed-in Chrome session proved that DeepThink is present in all three modes, Search only in Instant, file input in Instant and Vision, and no file input in Expert;
- exact `deepseek.mode`, `deepseek.deepthink`, and `deepseek.search` inspect/select actions are implemented, including restoration-oriented live acceptance coverage and mode-aware capability results;
- the authenticated Chrome session completed exact-marker baseline and continuation turns, a DeepThink response with a distinct reasoning container and correlated final answer, and a Search response with visible public source links;
- the observed file input explicitly accepts representative text, document, and image formats in Instant and Vision, while the declared real-provider gate keeps visible file/image acceptance separate from control presence;
- the shared blocker observer and DeepSeek provider selectors detect a visible hCaptcha, surface `visible_hcaptcha`, and require user support without attempting challenge interaction; the authenticated Chrome profile must not be logged out to recreate a signed-out state;
- generic model selection is no longer advertised for DeepSeek, and the submit selector excludes DeepSeek's visible disabled class; and
- DeepSeek remains non-routeable until a selected signed-in managed profile independently closes the declared built-CLI and packaged-daemon baseline, continuation, Search/DeepThink, and file/image gates.
- Perplexity is registered as an experimental guest provider, with readiness, prompt drafting, real submission, completed response, visible normalized citations, conversation mapping, and durable state closed through the built CLI, packaged daemon, runtime-bound Cloak profile, and real provider network;
- Z.ai is registered as an experimental guest provider. Its canonical entry is `https://z.ai/chat`, while `https://chat.z.ai` remains an approved runtime origin because the official entry currently hands prepared drafts to that runtime. Guest continuation, readiness, prompt drafting, real submission, completed response, conversation mapping, and durable state were previously closed through the managed-Cloak runtime boundary; the updated entry-to-runtime journey remains a manual release rerun; and
- Doubao is registered as an experimental sign-in-required provider. Its built-CLI managed-Cloak non-submission gate closes readiness, prompt drafting, visible file acceptance, exact Fast/Expert/Work Task mode selection, nine coding-relevant Web skill selections, unavailable-state reporting, and restoration. Text-file `file.upload` is experimental and routeable. The same anti-detect configuration completed two direct correlated marker responses, while the built-product chat mutation release gate remains blocked by a visible provider verification iframe and fails closed as `visible_provider_blocker`; and
- Kimi is registered as an experimental sign-in-required provider. Its built-CLI managed-Cloak gates close readiness, prompt drafting, Instant/K3/K3 Swarm model selection, Standard/High effort selection, text-file acceptance, attachment-grounded output, exact Web search selection with visible citations, exact Plugin/Skill control selection, second-process same-conversation continuation, restoration, and durable mapping. `conversation.chat`, text-file `file.upload`, `search.web`, and search-backed `response.citations` are experimental and routeable; Plugin/Skill submitted outcomes are capacity-blocked, while Projects, research, agent, and artifact lifecycles remain gate-pending and unadvertised; and
- Microsoft Copilot remains unregistered because both Cloak checks exposed a sign-in surface and no guest composer, and no login was attempted under the authentication-skip policy.
- Dola is registered as an experimental signed-in provider from the user-selected `web-ai` managed profile. The visible session confirmed the chat composer, file picker, Fast/Pro menu, numeric conversation URLs, and image, writing, video, translation, and homework entry points. The adapter and readiness/draft/model/file/two-turn real-provider release gates are implemented; no route is advertised until the built-product gates close.
- Arena is registered as a supported signed-in provider on its current `https://arena.ai/` surface. The built CLI, packaged daemon, headed `web-ai` Cloak profile, and real provider network closed readiness, prompt drafting, a correlated completed response, durable `/c/:conversationId` mapping, and same-conversation continuation. The adapter handles the exact provider-owned Terms/Privacy onboarding dialog before prompt input; model selection, files, Battle variants, Search, Code, Agent, Image, and Video remain unadvertised until independently closed.

| Qwen capability | Current state | Evidence boundary |
| --- | --- | --- |
| Guest access | Experimental, available | Fresh managed signed-out profile |
| Prompt input and submit | Experimental, available | Built CLI and real visible Qwen session |
| Response reading | Experimental, available | Exact correlated marker returned |
| Same-task continuation | Unavailable in the selected guest profile | The shared `/c/guest` route does not restore the prior visible response after navigation or reopen |
| Conversation workspace fallback | Experimental, available when the composer is visible | Provider-neutral conversation capability |
| Provider-specific mode selection | Implemented, release-gate completion pending | Built CLI and read-only CDP observer proved Deep Research Advanced selection; the product returned a correlated clarification response with durable success, while the strengthened observer prompt assertion awaits rerun after the visible guest plan limit clears |
| Effort selection | Experimental, available | Built CLI and read-only CDP observer proved Auto/Thinking/Fast inspection, exact Thinking selection, and Auto restore |
| Model selection | Unknown | No proven exact-selection postcondition |
| File and input-image upload | Unknown | No proven visible acceptance postcondition |
| Native workspace | Unavailable | No proven native creation or exact identity closure |
| Image generation | Unavailable | No proven generation lifecycle |

| DeepSeek capability | Current state | Evidence boundary |
| --- | --- | --- |
| Signed-in composer | Live observed, implementation available | User-controlled authenticated Chrome session; managed-profile E2E still required |
| Mode selection | Implemented for Instant, Expert, and Vision | Real visible radio controls on the provider website; managed E2E closure remains required |
| DeepThink | Implemented as a provider-specific toggle | Real visible toggle in all three modes and correlated reasoning/final response observed; canonical `reasoning.extended` remains unrouteable pending managed E2E closure |
| Search | Implemented as a provider-specific toggle in Instant | Grounded response with visible public links observed; canonical `search.web` and citations remain unrouteable pending managed E2E closure |
| File and image input | Visible in Instant and Vision; absent in Expert | Real input accept list includes text, document, and image formats; visible selection and semantic response gates remain pending |
| Conversation and continuation | Implemented, release gate pending | Same-conversation two-turn behavior was observed in authenticated Chrome; built-CLI packaged-daemon continuation remains the acceptance boundary |
| Native workspace | Unavailable | No native workspace observed; conversation fallback only |

| Doubao capability | Current state | Evidence boundary |
| --- | --- | --- |
| Signed-in composer | Experimental, available | Runtime-bound Cloak profile through built CLI and packaged daemon |
| File upload | Experimental, routeable for text files | Visible plus control, provider input, and accepted filename card passed the real non-submission gate |
| Mode selection | Experimental provider control | Fast, Expert, and Work Task Turbo selected and restored; Work Task Pro reports visible upgrade requirement |
| Skill selection | Experimental provider control | Writing, presentation, image, video, deep research, podcast, music, problem solving, and spreadsheet skills selected and restored |
| Audio transcription | Unavailable on Web | The visible Web entry presents a Doubao desktop-app download flow |
| Generated and long-running outcomes | Candidate only | Control selection is closed; terminal artifacts, citations, progress, clarification, and background durability are not |
| Chat mutation | Release gate blocked | Provider verification iframe is classified as `visible_provider_blocker`; no bypass or simulation |

| Kimi capability | Current state | Evidence boundary |
| --- | --- | --- |
| Signed-in composer | Experimental, available | User-selected runtime-bound Cloak profile through built CLI and packaged daemon |
| Conversation and continuation | Experimental, routeable chat | Correlated response, visible citation, two CLI processes, one exact conversation URL, and durable mapping passed against Kimi.com |
| File upload | Experimental, routeable for text files | Visible provider attachment card plus attachment-grounded response passed the real workflow |
| Model selection | Experimental provider control | Instant, K3, and K3 Swarm inspected, selected, visibly verified, and restored |
| Thinking effort | Experimental provider control | Standard and High inspected, selected, visibly verified, and restored |
| Web search | Experimental, routeable | Auto selection, correlated response, normalized citations, visible citation links, and restoration passed the real workflow |
| Plugins and Skills | Controls closed; outcomes gate-pending | Exact inspect/select passed; a submitted Plugin workflow previously completed, but the formal combined outcome gate is currently blocked by Kimi's visible capacity queue |
| Projects | Implementation and gate pending | A uniquely named Project was created in manual probing, but the formal gate could not persist and visibly re-identify the exact Project name |
| Research, agent, and artifact outcomes | Candidate only | Terminal reports, progress, clarification, generated artifacts, and background durability remain unclosed |

| Dola capability | Current state | Evidence boundary |
| --- | --- | --- |
| Signed-in composer | Live observed; implementation available | User-selected runtime-bound Cloak profile; built-product gate pending |
| Fast / Pro model menu | Live observed; exact-selection gate declared | Visible menu in the signed-in chat surface; selection and restoration pending |
| File input | Visible picker; acceptance gate declared | Native file dialog opened from the signed-in composer; accepted-file postcondition pending |
| Conversation and continuation | Adapter and gate declared | Numeric `/chat/:conversationId` routes were observed; correlated two-turn CLI closure pending |
| Image generation | `image.generation` candidate | Create Image and the Seedream model/ratio/style/template surface are visible; completed image artifact pending |
| Writing | `document.generation` or chat candidate | `write_assistant` is visible, but no completed document or downloadable file is proven |
| Video generation | `video.generation` candidate | `video_generation` is visible; progress and terminal artifact pending |
| Translation | Chat candidate through provider workflow `dola.translate` | `translate` is visible; correlated translated output pending |
| Homework | Chat candidate through provider workflow `dola.exercise_assistant` | `exercise_assistant` is visible; terminal outcome pending; no reasoning tier is inferred from the control |
| Projects and file management | Unavailable | No Project, file library, persistent knowledge, or independent Create File surface was observed |

The maintained [Provider Capability Census](../provider-capability-census.md) records official product surfaces, current Tokenless evidence, candidate providers, and the proposed canonical capability schema.

The next evaluation wave is:

1. Kimi Deep Research, building on the shipped baseline while requiring its complete asynchronous lifecycle;
2. Mistral Le Chat, prioritizing a second independent research/Project/artifact implementation; and
3. DeepSeek Chat signed-in closure, prioritizing the compact baseline first, then mode selection, search, and files as independent capabilities.

Meta AI, Microsoft Copilot, Tencent Yuanbao, and MiniMax Agent remain scored candidates. Meta AI is currently strongest as an image-generation/editing candidate rather than a Deep Research provider. MiniMax Agent requires a distinct long-horizon agent lifecycle and must not distort the baseline chat contract. This is a discovery order, not a claim that every candidate is already suitable for automation or will ship.

Official product entry points:

- [Qwen / 千问](https://chat.qwen.ai/)
- [Kimi](https://www.kimi.com/)
- [Z.ai / GLM](https://z.ai/chat)
- [Zhipu Qingyan / 智谱清言](https://chatglm.cn/)
- [DeepSeek Chat](https://chat.deepseek.com/)
- [Perplexity](https://www.perplexity.ai/)
- [Mistral Le Chat](https://chat.mistral.ai/)
- [Doubao](https://www.doubao.com/)
- [Meta AI](https://www.meta.ai/)
- [Microsoft Copilot](https://copilot.microsoft.com/)
- [Tencent Yuanbao](https://yuanbao.tencent.com/)
- [MiniMax Agent](https://agent.minimax.io/)

## Why This Matters

- Chinese-speaking users should be able to reuse the web products and subscriptions they already value.
- Provider diversity improves routing choice across coding, research, long-context, multimodal, and document-heavy tasks.
- A larger provider set reduces dependence on any single provider's UI, availability, or product decisions.
- Parity work forces shared contracts to describe real differences rather than assuming one provider's interface is universal.

## Provider Selection Scorecard

Candidates are ranked from current, real-session evidence. Model popularity alone is insufficient.

| Dimension | Evidence |
| --- | --- |
| User value | Strong current models or agent workflows that complement existing providers |
| Web availability | A stable user-facing web product in the target regions |
| Session viability | Authentication can stay browser-managed in visible mode or be locally accessed within an explicitly selected direct mode |
| Core workflow | A proven prompt submission, stable result, and safe continuation path through the selected execution mode |
| Context capability | Proven file upload, long-context handling, native project or memory surfaces, or an honest fallback |
| Coding utility | Useful visible workflows for repository analysis, implementation, or web development |
| Testability | Sanitized real-session evidence can prove mode-specific requests and postconditions without exposing user data |
| Policy fit | The intended execution mode can be operated responsibly under applicable product constraints |
| Operational quality | Rate-limit, sign-in, CAPTCHA, interruption, and long-running states can be detected and surfaced |

Development cost is not a deciding advantage. Prefer robust, high-value integrations even when they require deeper adapter work.

## Provider-Neutral Baseline

A provider does not become generally supported until it closes the baseline:

- approved origins and canonical target validation;
- selected profile and execution-mode readiness;
- `prompt.input`, `prompt.submit`, and stable normalized answer reading;
- stable conversation identity and same-scope continuation;
- cancellation, timeout, waiting-for-user, and long-running behavior;
- normalized result and citations when the provider exposes them;
- explicit capability inspection;
- safe model or mode preservation, with verified selection only where proven; and
- real integration or E2E coverage through the built product and selected provider boundary.

File upload, native Project creation, generated-media lifecycles, deep research final-report orchestration, agent mode, and other advanced controls remain capability-gated. Qwen Deep Research mode selection is provider-specific and proves the first correlated visible response, which may be a clarification phase; it does not make the full multi-turn research lifecycle provider-neutral. A provider may ship the baseline while an advanced capability remains `unknown` or `unavailable`.

## Delivery Phases

### Phase 0: Candidate Reconnaissance

- Record canonical origins, route classes, account states, model or mode surfaces, composer behavior, result structure, attachment controls, and workspace-like concepts.
- Review product and automation constraints before implementation.
- Inspect candidate states only against the real provider website or, for an explicitly selected direct mode, its real web endpoint through the configured account session; do not store DOM or response fixtures.
- Publish a scorecard and select one provider for the first implementation slice.

Exit: the candidate has an approved origin model, an evidence plan, and no unresolved credential scope, endpoint-validation, or invented-fixture boundary.

### Phase 1: Shared Registry Extraction — completed 2026-07-27

- Follow the object model, capability composition, registry seam, TypeScript daemon negotiation, and phased migration defined in the archived [Provider Architecture and Registry](archived/P0-provider-architecture-and-registry.md).
- Replace duplicated provider allowlists with one typed provider registry consumed by config, runtime validation, profile handling, navigation, and tests.
- Represent every provider as a concrete `BaseProvider` subclass.
- Keep provider-specific selectors and behavior inside provider-owned subclasses and optional capability implementations.
- Make unsupported capabilities explicit data rather than scattered conditionals.
- Remove provider-ID conditionals from shared runner, session, account, and action implementations.
- Keep new provider knowledge in the TypeScript provider registry and out of removed runtime paths.

Exit: adding a provider requires one provider subclass and one registry entry, does not require shared production-logic changes, and no longer requires manually synchronizing independent allowlists across the CLI, daemon-facing contracts, helpers, and test matrices.

### Phase 2: First Chinese Provider Baseline — Qwen experimental baseline completed 2026-07-27

- Implement the highest-ranked first-wave provider.
- Prove sign-in states, composer readiness, prompt submission, stable completion, and conversation continuation.
- Add explicit waiting and failure states for sign-in, CAPTCHA, rate limits, plan gates, and selector drift.
- Keep the provider experimental until the live matrix is complete.

Exit: a real managed browser session can complete and continue a prompt through the built CLI with normalized results and no simulated provider behavior.

### Phase 3: First-Wave Coverage

- Repeat the baseline for the remaining first-wave providers.
- Compare differences and evolve shared contracts only where the concept is genuinely provider-neutral.
- Add file acceptance, model or mode selection, and workspace behavior independently when proof exists through the affected execution mode.

Exit: Kimi, Z.ai, Perplexity, Mistral Le Chat, and DeepSeek each have an explicit support state and evidence-backed capability matrix, even when the correct state is unavailable or parked.

### Phase 4: Continuous Parity

- Run a scheduled live compatibility matrix across supported account states where safe.
- Detect route or selector drift and mark affected capabilities unavailable until re-proven.
- Re-score candidates as provider products evolve.
- Add second-wave providers one at a time without weakening the baseline.

Exit: support is an ongoing evidence process rather than a one-time adapter merge.

## Acceptance Criteria

- Provider identity is normalized through a single registry.
- Every supported origin, navigation target, and returned conversation URL is validated.
- Each advertised action has a mode-appropriate success postcondition proven by a real-provider built-product journey.
- Unsupported or ambiguous controls fail closed with actionable machine-readable reasons.
- No test introduces provider DOM fixtures, local provider replicas, intercepted response fixtures, or simulated provider responses.
- Documentation distinguishes provider support from model availability and from advanced capability support.
- Existing providers continue to pass the same baseline contract after each expansion.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Fast UI and product drift | Required live cases, bounded diagnostics, isolated adapters, and rapid capability disablement |
| Region, account, or plan variation | Account-state capability matrix and `unknown` when evidence is incomplete |
| Model names change faster than adapters | Discover visible labels at runtime and avoid hard-coding marketing names as capability guarantees |
| Candidate lacks a viable real provider boundary | Park the candidate and preserve the scorecard; do not substitute a simulated boundary |
| Shared abstraction becomes ChatGPT-shaped | Require multiple-provider evidence before promoting behavior into the shared contract |

## Non-Goals

- Treating official model APIs as equivalent to the provider's consumer web product
- Guaranteeing a specific model name, entitlement, quota, or release schedule
- Enabling direct protocol access implicitly or exposing provider session credentials outside its selected local provider/profile scope
- Treating a visible control as proof that the resulting mutation succeeded
- Shipping all listed candidates simultaneously
