# Provider Expansion and Parity

Status: proposed | Priority: P0

Depends on: completed [Provider Architecture and Registry](archived/provider-architecture-and-registry.md), existing managed Playwright, provider action protocol, fixture provenance, and profile lifecycle

## Outcome

Tokenless supports a broader set of high-value Chinese AI web providers while preserving one honest provider-neutral contract. Adding a provider must improve user choice without weakening session isolation, visible verification, failure behavior, or maintainability.

## Current Implementation State

As of 2026-07-27:

- the shared registry extraction and OOP provider seam are complete and recorded in the archived [Provider Architecture and Registry](archived/provider-architecture-and-registry.md) roadmap;
- Qwen / 千问 is registered as an `experimental` provider through one provider module and one registry entry;
- a fresh real managed guest profile completed prompt input, visible submission, correlated response reading, and same-task conversation continuation through the built CLI and TypeScript daemon;
- Qwen provenance-bound DOM captures cover the signed-out idle composer and a completed response; and
- unproven Qwen model, effort, file-upload, native workspace, and image-generation capabilities remain `unknown` or `unavailable` rather than being inferred from visible controls.

| Qwen capability | Current state | Evidence boundary |
| --- | --- | --- |
| Guest access | Experimental, available | Fresh managed signed-out profile |
| Prompt input and submit | Experimental, available | Built CLI and real visible Qwen session |
| Response reading | Experimental, available | Exact correlated marker returned |
| Same-task continuation | Experimental, available | Second built-CLI job reused the trusted conversation scope |
| Conversation workspace fallback | Experimental, available when the composer is visible | Provider-neutral conversation capability |
| Model and effort selection | Unknown | No proven selector or exact-selection postcondition |
| File and input-image upload | Unknown | No proven visible acceptance postcondition |
| Native workspace | Unavailable | No proven native creation or exact identity closure |
| Image generation | Unavailable | No proven generation lifecycle |

The first evaluation wave is:

1. Qwen / 千问
2. Kimi
3. Zhipu Qingyan / 智谱清言

The next evaluation wave includes DeepSeek Chat, Doubao, and Tencent Yuanbao. This is a discovery order, not a claim that every candidate is already suitable for automation or will ship.

Official product entry points:

- [Qwen / 千问](https://www.qianwen.com/)
- [Kimi](https://www.kimi.com/)
- [Zhipu Qingyan / 智谱清言](https://chatglm.cn/)
- [DeepSeek Chat](https://chat.deepseek.com/)
- [Doubao](https://www.doubao.com/)
- [Tencent Yuanbao](https://yuanbao.tencent.com/)

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

File upload, native Project creation, image generation, deep research, agent mode, and other advanced controls remain capability-gated. A provider may ship the baseline while an advanced capability remains `unknown` or `unavailable`.

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
- Keep provider-specific selectors and behavior inside provider-owned capability implementations.
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

Exit: Qwen, Kimi, and Zhipu Qingyan each have an explicit support state and evidence-backed capability matrix.

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
