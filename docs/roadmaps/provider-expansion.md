# Provider Expansion and Parity

Status: proposed | Priority: P0

Depends on: completed [Provider Architecture and Registry](archived/provider-architecture-and-registry.md), existing managed Playwright, provider action protocol, fixture provenance, and profile lifecycle

## Outcome

Tokenless supports a broader set of high-value AI web providers while preserving one honest capability catalog and provider-neutral contract. Adding a provider must improve user choice without weakening session isolation, visible verification, failure behavior, or maintainability.

## Current Implementation State

As of 2026-08-01:

- the shared registry extraction and OOP provider seam are complete and recorded in the archived [Provider Architecture and Registry](archived/provider-architecture-and-registry.md) roadmap;
- Qwen / 千问 is registered as an `experimental` provider through one provider module and one registry entry;
- a fresh real managed guest profile completed prompt input, visible submission, and correlated response reading through the built CLI and TypeScript daemon;
- the canonical Qwen Studio entry is `https://chat.qwen.ai/`; a real built-CLI run navigated the same visible page to the shared `/c/guest` route and returned an exact correlated marker;
- navigation or reopen of the shared guest route does not restore the prior visible response, so cross-process continuation remains unavailable;
- Qwen provenance-bound DOM captures cover the earlier regional surface and the current Qwen Studio completed-response state; and
- Qwen's provider-specific mode menu is exposed as `qwen.mode`, including runtime enabled/disabled discovery and exact Deep Research Normal/Advanced selection;
- the visible Auto/Thinking/Fast selector is exposed through the provider-neutral `effort.choice` capability; and
- the versioned canonical task-capability catalog and evidence-backed provider routing matrix are implemented in the CLI, with `conversation.chat`, `file.upload`, and `workspace.native` as the first routeable outcomes; and
- unproven Qwen model, file-upload, native workspace, and generated-media lifecycles remain `unknown` or `unavailable` rather than being inferred from visible controls.
- DeepSeek is registered as an `experimental`, sign-in-required provider with canonical navigation, signed-out session detection, initial visible chat contracts, capture tooling, and an explicit live acceptance classification;
- a real signed-out browser observation confirmed that `https://chat.deepseek.com/` redirects to `/sign_in` and exposes email/password, Google, and Apple login choices; and
- DeepSeek remains non-routeable until a selected signed-in managed profile closes prompt drafting, correlated submission and response reading, exact conversation continuation, and the required live matrix cases.

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

The maintained [Provider Capability Census](../provider-capability-census.md) records official product surfaces, current Tokenless evidence, candidate providers, and the proposed canonical capability schema.

The next evaluation wave is:

1. Kimi web, prioritizing the complete asynchronous Deep Research lifecycle;
2. Z.ai with GLM-5.2, prioritizing baseline chat, effort control, long-context inputs, and coding workflows;
3. Perplexity, prioritizing research, citations, source scope, Spaces, and generated artifacts;
4. Mistral Le Chat, prioritizing a second independent research/Project/artifact implementation; and
5. DeepSeek Chat signed-in closure, prioritizing the compact baseline first, then mode selection, search, and files as independent capabilities.

Doubao, Meta AI, Microsoft Copilot, Tencent Yuanbao, and MiniMax Agent remain scored candidates. Doubao requires product-policy review and live web reconnaissance before implementation. Meta AI is currently strongest as an image-generation/editing candidate rather than a Deep Research provider. MiniMax Agent requires a distinct long-horizon agent lifecycle and must not distort the baseline chat contract. This is a discovery order, not a claim that every candidate is already suitable for automation or will ship.

Official product entry points:

- [Qwen / 千问](https://chat.qwen.ai/)
- [Kimi](https://www.kimi.com/)
- [Z.ai / GLM](https://chat.z.ai/)
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
| Session viability | Authentication can remain opaque inside an isolated managed profile |
| Core workflow | A visible composer, submission action, stable result, and safe continuation path |
| Context capability | Visible file upload, long-context handling, native project or memory surfaces, or an honest fallback |
| Coding utility | Useful visible workflows for repository analysis, implementation, or web development |
| Testability | Sanitized real-session evidence can prove selectors and postconditions without exposing user data |
| Policy fit | The intended visible automation can be operated responsibly under applicable product constraints |
| Operational quality | Rate-limit, sign-in, CAPTCHA, interruption, and long-running states can be detected and surfaced |

Development cost is not a deciding advantage. Prefer robust, high-value integrations even when they require deeper adapter work.

## Provider-Neutral Baseline

A provider does not become generally supported until it closes the baseline:

- approved origins and canonical target validation;
- managed-profile launch and visible session status;
- `prompt.input`, `prompt.submit`, and stable visible answer reading;
- conversation URL capture and same-scope continuation;
- cancellation, timeout, waiting-for-user, and long-running behavior;
- normalized result and visible citations when the provider exposes them;
- explicit capability inspection;
- safe model or mode preservation, with verified selection only where proven; and
- real integration or browser E2E coverage through the built product.

File upload, native Project creation, generated-media lifecycles, deep research final-report orchestration, agent mode, and other advanced controls remain capability-gated. Qwen Deep Research mode selection is provider-specific and proves the first correlated visible response, which may be a clarification phase; it does not make the full multi-turn research lifecycle provider-neutral. A provider may ship the baseline while an advanced capability remains `unknown` or `unavailable`.

## Delivery Phases

### Phase 0: Candidate Reconnaissance

- Record canonical origins, route classes, account states, model or mode surfaces, composer behavior, result structure, attachment controls, and workspace-like concepts.
- Review product and automation constraints before implementation.
- Capture only sanitized, provenance-bound DOM evidence from a dedicated visible session.
- Publish a scorecard and select one provider for the first implementation slice.

Exit: the candidate has an approved origin model, an evidence plan, and no unresolved boundary that would require credentials, private APIs, or invented fixtures.

### Phase 1: Shared Registry Extraction — completed 2026-07-27

- Follow the object model, capability composition, registry seam, TypeScript daemon negotiation, and phased migration defined in the archived [Provider Architecture and Registry](archived/provider-architecture-and-registry.md).
- Replace duplicated provider allowlists with one typed provider registry consumed by config, runtime validation, profile handling, navigation, capture tooling, and tests.
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
- Add file acceptance, model or mode selection, and workspace behavior independently when visible proof exists.

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
- Each advertised action has a captured visible success postcondition from a real provider session.
- Unsupported or ambiguous controls fail closed with actionable machine-readable reasons.
- No test introduces fake provider pages, synthetic network responses, or invented DOM fixtures.
- Documentation distinguishes provider support from model availability and from advanced capability support.
- Existing providers continue to pass the same baseline contract after each expansion.

## Risks and Responses

| Risk | Response |
| --- | --- |
| Fast UI and product drift | Provenance-bound fixtures, live smoke coverage, isolated adapters, and rapid capability disablement |
| Region, account, or plan variation | Account-state capability matrix and `unknown` when evidence is incomplete |
| Model names change faster than adapters | Discover visible labels at runtime and avoid hard-coding marketing names as capability guarantees |
| Candidate lacks a safe automation surface | Park the candidate and preserve the scorecard; do not bypass the visible boundary |
| Shared abstraction becomes ChatGPT-shaped | Require multiple-provider evidence before promoting behavior into the shared contract |

## Non-Goals

- Calling model APIs instead of the provider's visible web product
- Guaranteeing a specific model name, entitlement, quota, or release schedule
- Reaching parity by using hidden endpoints or exporting browser credentials
- Treating a visible control as proof that the resulting mutation succeeded
- Shipping all listed candidates simultaneously
