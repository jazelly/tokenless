# Provider Capability Census

Last reviewed: 2026-08-31

This is a product reconnaissance record, not a Tokenless support declaration. Official provider documentation establishes that a product feature exists. Tokenless advertises a route only after the provider adapter implements the complete visible lifecycle and real-provider browser E2E closes the required evidence. The normative naming, mapping, support, and extension rules live in the [Capability Matrix](capability-matrix.md).

The checked-in runtime catalog and provider routing matrix live in `packages/server/src/providers/task-capabilities.ts`. `tokenless capabilities list --json` exposes that versioned catalog without opening a browser. The current V3 routeable outcomes are:

- `conversation.chat`: ChatGPT, Claude, Gemini, Grok, Arena, and experimental Qwen, DeepSeek, Perplexity, Z.ai, Doubao, Kimi, Dola, and Meta AI;
- `image.generation` and `artifact.download`: experimental ChatGPT, Gemini, Grok, Doubao, Dola, Arena, and Meta AI;
- `file.upload`: supported ChatGPT, Claude, and Grok; experimental Gemini, Qwen, DeepSeek, Perplexity, Z.ai, Doubao, Kimi, Dola, and Meta AI;
- `search.web`: experimental Kimi; and
- `response.citations`: experimental Kimi search.

All other entries below remain discoverable candidates. In particular, `research.deep`, citations as a required production postcondition, continuation as an explicit capability, other generated media, and generated work artifacts remain non-routeable until their complete execution contracts are implemented and real-provider E2E-closed.

The Harness attachment gate is stricter than generic file upload: it requires bootstrap Markdown, a framed tool call, real read-only tool execution, same-conversation tool-result Markdown, and a succeeded child run without fallback. ChatGPT, Gemini, DeepSeek, Z.ai, Doubao, Kimi, and Dola passed on 2026-08-31. Claude, Grok, Qwen, Perplexity, and Meta AI retain generic Markdown upload routes but are excluded from Harness V0 and Auto; Arena accepts image files but not Markdown. Exact current reasons are recorded in the [Capability Matrix](capability-matrix.md#harness-attachment-eligibility).

The unified `POST /v1/images/generations` endpoint persists browser and direct results into the same scoped asset store. Browser auto routing selects only enabled, usable providers with both `image.generation` and `artifact.download`; its Gemini, Dola, and Doubao gates each completed one visible submission, terminal artifact, local digest, and authenticated readback. Direct V1 includes the logical `tokenless/pollinations/sana` route and the explicit `tokenless/chatgpt/gpt-image` route; both keep private implementation names out of public model IDs, responses, and capability evidence. The Pollinations direct gate produced and read back one 768×768 JPEG, while ChatGPT direct uses an ephemeral browser-scoped auth bridge before persisting verified image bytes.

## Evidence Ladder

Every provider/capability cell progresses independently:

1. `product_documented`: the provider officially describes the web product capability;
2. `live_observed`: the selected managed profile visibly exposes the relevant controls or state;
3. `implemented`: a provider strategy can execute the lifecycle through the packaged daemon;
4. `e2e_closed`: the built product proves the final visible outcome against the real provider; and
5. `routeable`: the capability router may advertise and select the route for the observed account class.

A visible menu item never advances a capability beyond `live_observed`. Account tier, region, quota, rollout, and workspace policy may keep an officially documented feature unavailable for a specific profile.

## Current Tokenless Providers

The product surface is broader than the current Tokenless evidence. The middle column combines official documentation with prior live product reconnaissance; the final column summarizes the checked-in live acceptance matrix, not the provider's marketing claims.

| Provider | Documented or live-observed web product capabilities relevant to Tokenless | Current Tokenless evidence |
| --- | --- | --- |
| ChatGPT | Chat, web search with citations, Deep Research, file and image input, image generation and editing, data analysis, Canvas, agent mode, and Projects with files and instructions | Supported chat and Harness-verified `file.upload`; the live gate completed bootstrap, tool execution, continuation upload, and exact final proof without fallback. Independent image and Project evidence remains separately scoped |
| Claude | Chat, web search, Research, files and images, Projects and project knowledge, Artifacts, model selection, extended thinking, and connectors | Supported chat, generic Markdown `file.upload`, and native Project routes remain; upload, submit, and response pass, but Harness attachment instructions are rejected as prompt injection |
| Gemini | Chat, web-grounded answers, Deep Research, file and image input, Deep Think, image/video/music generation, Canvas, Gems, notebooks, connected sources, and GitHub repository import | Supported chat plus experimental Harness-verified `file.upload`; upload control redraw is observed within the existing interaction timeout. Image generation remains independently experimental |
| Grok | Chat, X and web search with citations, reasoning modes, image input, and image generation | Supported chat and generic Markdown `file.upload` remain; the selected profile is blocked by a visible weekly limit until 2026-09-02 06:47:22 UTC, so it is not currently Harness-eligible. Imagine image generation remains independently experimental |
| Qwen | Chat, web search, Deep Research Normal/Advanced, file-assisted research, image generation/editing, video generation, Web Dev, Artifacts, Slides, Learn, and travel planning modes | Generic Markdown `file.upload` is experimental after focused byte, size, and filename probes passed; full Harness jobs remain intermittent at card visibility and submission transition |
| DeepSeek | Signed-in web chat, Instant/Expert/Vision modes, DeepThink, web search, broad file and image input, and synchronized chat history | Experimental chat and Harness-verified `file.upload`; bootstrap, framed read-only tool call, same-conversation tool-result upload, and exact final proof passed without fallback |
| Perplexity | Web search with citations, Pro Search, Advanced Deep Research, file-aware research, Spaces, model selection, image generation/editing, and multi-format asset creation | Experimental chat and generic Markdown `file.upload` remain; the selected Free profile's official 3/day allowance is currently exhausted, so the API capacity guard excludes the two-upload Harness request before browser work |
| Z.ai / GLM | GLM-5.2 web chat, 1M context, flexible effort levels, coding, and long-horizon agent strengths | Experimental chat and Harness-verified Markdown `file.upload`; ordinary Enter submission after a failed click transition and the conversation-page composer completed both turns |
| Doubao / 豆包 | Signed-in Chinese web chat; visible free-account discrimination; Fast, Expert, and Work Task modes; writing, presentation, image, video, deep-research, podcast, music, problem-solving, and spreadsheet Web skills; broad file input; desktop-only recording transcription entry | Experimental chat, image, and Harness-verified Markdown `file.upload`; the adapter precisely dismisses the provider desktop-promotion dialog before submission |
| Kimi | Signed-in web chat; Instant, K3, and K3 Swarm models; Standard/High thinking effort; files, Web search, Plugins, Skills, Projects, and broader research/agent/artifact surfaces | Experimental chat, search, and Harness-verified Markdown `file.upload`; the selected `web-ai` Cloak profile is signed in on `kimi.ai` and completed both turns |
| Dola | Signed-in web chat; Fast and Pro choices; file input; Create Image, Writing, Create Video, Translate, and Homework entries; a separate Seedream image-creation surface; no observed Project, file library, or persistent knowledge-management surface | Experimental chat and Harness-verified `file.upload`; both Markdown turns were individually visible and consumed. Image generation remains independently experimental |
| Arena | Signed-in Battle, Direct, and Side-by-Side chat; model selection; file input; Search, Code, Agent, Image, and Video surfaces | Supported Direct chat and independent experimental generated-image routes remain; the real input accepts PNG, JPEG, and WebP but not Markdown, so generic `file.upload` is removed |
| Meta AI | Signed-in web chat; Instant and Thinking modes; broad file input; visible image generation; research-progress and assistant-response surfaces | Experimental chat, image, and generic Markdown `file.upload` remain; exact Harness bytes upload, but the combined attachment instruction is silently rejected without a conversation |

Official references:

- [ChatGPT capabilities](https://help.openai.com/en/articles/9260256-chatgpt-capabilities-overview), [Deep Research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt), and [Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Claude Research](https://support.anthropic.com/en/articles/11088861-using-research-on-claude-ai), [web search](https://support.anthropic.com/en/articles/10684626-enabling-and-using-web-search), [Projects](https://support.anthropic.com/en/articles/9529781-examples-of-projects-you-can-create), and [Artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Gemini Apps capability index](https://support.google.com/gemini) and [Gemini Deep Research](https://support.google.com/gemini/answer/15719111)
- [Grok web search and citations](https://x.ai/news/grok-1212) and [Grok on the web](https://help.x.com/en/using-x/about-grok)
- [Qwen Deep Research](https://qwen.ai/blog?id=qwen-deepresearch) and [Qwen Image](https://qwen.ai/blog?id=qwen-image-2.0)
- [DeepSeek V4 web modes](https://api-docs.deepseek.com/news/news260424), [DeepSeek web search](https://api-docs.deepseek.com/news/news1210/), and [DeepSeek file upload and synchronized history](https://api-docs.deepseek.com/news/news250115/)
- [Perplexity overview](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work), [account tiers](https://www.perplexity.ai/help-center/en/articles/10352998-account-management-and-security), [Enterprise file limits](https://www.perplexity.ai/help-center/en/articles/12009761-enterprise-file-limits), [Spaces](https://hub-prod.perplexity.ai/hub/faq/what-are-spaces), and [generated assets](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview)
- [GLM-5.2 on Z.ai](https://z.ai/blog/glm-5.2)
- [Doubao official feature introduction](https://www.doubao.com/legal/feature_intro)
- [Doubao paid service agreement](https://www.doubao.com/legal/ey01)
- [Kimi web product](https://www.kimi.ai/)
- [Dola web product](https://www.dola.com/chat)
- [Arena model selection](https://help.arena.ai/articles/1858200927-arena-experiments-new-model-selector), [file upload](https://help.arena.ai/articles/5595418316-arena-how-to-file-upload), and [Agent Mode](https://help.arena.ai/articles/5432423882-how-to-use-agent-mode)
- [Meta AI web product](https://about.fb.com/news/2025/04/introducing-meta-ai-app-new-way-access-ai-assistant/) and [Muse Image on meta.ai](https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/)

## Candidate Web Providers

| Candidate | Canonical web entry | Officially documented or currently confirmed surface | Recommended evaluation |
| --- | --- | --- | --- |
| Mistral Le Chat | `https://chat.mistral.ai/` | Web search and citations, Deep Research, Think mode, Projects and Libraries, files, code interpreter, image generation/editing, Canvas, agents, and MCP connectors | P1. Broad capability match with relatively clear official documentation; useful second adapter for research and artifact semantics |
| Microsoft Copilot | `https://copilot.microsoft.com/` | Web chat, Quick/Think Deeper/Smart modes, Deep Research, file upload, image generation/editing, Pages, connectors, voice, and browser-related experiences | Blocked in the 2026-08-01 Cloak precheck: the signed-out surface exposed Microsoft, Apple, and Google sign-in choices but no guest composer. Resume only with an explicitly selected setup-managed signed-in profile |
| Tencent Yuanbao | `https://yuanbao.tencent.com/` | Web product, Tencent-enhanced web search, multi-format file reading, reasoning/model surfaces, and the broader Tencent content ecosystem | P2. Valuable Chinese search and file route; advanced artifact and workspace claims need official and live closure |
| MiniMax Agent | `https://agent.minimax.io/` | Long-horizon planning, web and application generation, code execution, multimedia understanding and generation, and MCP integrations | P3 specialist adapter. Its autonomous-agent lifecycle is materially different from chat and should not be forced into the baseline provider contract |

Official candidate references:

- [Kimi overview](https://www.kimi.com/help/getting-started/overview), [Kimi Deep Research](https://www.kimi.com/help/deep-research/deep-research-overview), and [Kimi Agent](https://www.kimi.com/help/agent/agent-overview)
- [Perplexity overview](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work), [Spaces](https://hub-prod.perplexity.ai/hub/faq/what-are-spaces), [image generation](https://www.perplexity.ai/help-center/en/articles/10354781-generating-images-with-perplexity), and [generated assets](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview)
- [Mistral Le Chat research and Projects](https://mistral.ai/news/le-chat-dives-deep/) and [Le Chat product surface](https://mistral.ai/news/all-new-le-chat/)
- [DeepSeek V4 web modes](https://api-docs.deepseek.com/news/news260424) and [DeepSeek updates](https://api-docs.deepseek.com/updates/)
- [Microsoft Copilot capabilities](https://support.microsoft.com/en-gb/microsoft-copilot), [Deep Research](https://support.microsoft.com/en-us/Microsoft-Copilot/deep-research-in-microsoft-copilot), and [file upload](https://support.microsoft.com/en-US/microsoft-copilot/file-upload-in-microsoft-copilot)
- [Tencent Yuanbao web search](https://cloud.tencent.com/product/wsa) and [desktop file support](https://yuanbao.tencent.com/evt/dl)
- [MiniMax Agent](https://www.minimax.io/news/minimax-agent)

## 2026-08-01 to 2026-08-04 Cloak Expansion Checkpoint

- Perplexity passed the real non-submission and mutation journeys through the built CLI, packaged daemon, runtime-bound Cloak profile, and provider network. Guest readiness, prompt drafting, completed response, normalized and visible citations, and conversation mapping are closed; `conversation.chat` is advertised as experimental. A later regression run declined the visible optional-cookie dialog but then reached `provider_sign_in_required`; no login was attempted, and that account-state-dependent rerun remains parked.
- Z.ai now passes the complete Harness Markdown round-trip on `https://chat.z.ai/`; the adapter uses Enter only after the visible send click produces no accepted transition and recognizes the continuation composer.
- Doubao now passes the complete Harness Markdown round-trip after precisely dismissing its desktop-promotion dialog before submission.
- Microsoft Copilot loaded without a challenge on both checks but exposed a sign-in surface and no guest composer. Per the authentication-skip policy, no login was attempted and no adapter was registered.
- Kimi migrated to `kimi.ai`; after the user signed in through the selected `web-ai` Cloak profile, the complete Harness Markdown round-trip passed on the new origin.

## Canonical Capability Schema

The caller catalog must describe outcomes, not provider controls. `qwen.mode`, `deepseek.mode`, `deepseek.deepthink`, `deepseek.search`, `doubao.mode`, `doubao.skill`, `model.choice`, `effort.choice`, DOM selectors, and marketing model names stay inside provider strategy adapters. Doubao control inspection reports candidate mappings; only the image skill has an independently E2E-closed canonical outcome route. Expert maps to `reasoning.extended`; Work Task maps to background and interactive task semantics; the remaining Web skills map to research, media, document, presentation, spreadsheet, data-analysis, and audio-transcription candidates. The DeepSeek adapter already prepares `reasoning.extended` as Instant plus DeepThink, `search.web` as Instant plus Search, and `image.input` as Vision before mutation. Those unclosed routes remain unadvertised until each complete visible lifecycle passes through the built CLI and packaged daemon.

### Proposed Capability Families

| Family | Candidate canonical capabilities |
| --- | --- |
| Conversation | `conversation.chat`, `conversation.continue` |
| Inputs | `file.upload`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
| Retrieval and reasoning | `search.web`, `research.deep`, `reasoning.extended`, `audio.transcription`, `code.execute`, `data.analyze` |
| Media generation | `image.generation`, `image.edit`, `video.generation`, `audio.generation` |
| Artifact generation | `document.generation`, `presentation.generation`, `spreadsheet.generation`, `website.generation` |
| Workspace and knowledge | `workspace.native`, `workspace.instructions`, `workspace.knowledge`, `source.connected` |
| Evidence and lifecycle | `response.citations`, `artifact.download`, `task.background`, `task.interactive` |

This is a candidate vocabulary. A capability becomes public only when at least one provider has a complete semantics and real-provider closure. Similar provider labels do not establish equivalent behavior.

Provider-native labels such as Kimi Skill or Dola Homework remain namespaced workflows. A user-owned `SKILL.md` is separate Harness context delivered through `conversation.chat` plus `file.upload`; it is not part of the canonical capability vocabulary.

Keep the public catalog small. Real-time voice conversations, persistent personalization or memory, arbitrary autonomous web actions, connector writes, and iterative artifact editing or sharing require separate safety and lifecycle contracts. The schema may add those outcomes later, but provider marketing labels such as “agent,” “canvas,” or “memory” must not enter V2 as underspecified generic capabilities.

### Task Requirement

CLI may use a repeatable capability identifier for the simple case. MCP and the internal contract need structured parameters:

```ts
type TaskCapabilityRequirement = Readonly<{
  capability: TaskCapabilityId
  parameters?: Readonly<Record<string, unknown>>
}>

type CapabilityRunRequest = Readonly<{
  profile?: string
  providerConstraint?: ProviderId
  requirements: readonly TaskCapabilityRequirement[]
  prompt: string
  attachments?: readonly AttachmentInput[]
  workspace?: WorkspaceIntent
  requestedOutputs?: readonly OutputRequirement[]
}>
```

All V2 requirements are mandatory. Attachments infer the corresponding input capabilities. Requested output kinds infer generation capabilities. The router must find one provider strategy set that satisfies every explicit and inferred requirement, including the requested parameter subset.

Each catalog definition includes:

```ts
type TaskCapabilityDefinition = Readonly<{
  id: TaskCapabilityId
  title: string
  description: string
  family: CapabilityFamily
  parametersSchema: JsonSchema
  lifecycle: 'immediate' | 'interactive' | 'long_running'
  sideEffects: readonly CapabilitySideEffect[]
  implies: readonly TaskCapabilityId[]
  composesWith: readonly TaskCapabilityId[]
  conflictsWith: readonly TaskCapabilityId[]
  requiredEvidence: readonly CapabilityEvidenceRequirement[]
  outputKinds: readonly OutputKind[]
  stability: 'candidate' | 'experimental' | 'supported'
}>
```

The provider matrix maps the canonical definition to a provider-owned strategy and declares which parameter subset it can satisfy. Unsupported parameters eliminate that route before mutation.

## Minimum Lifecycle Contracts

### `research.deep`

Mode selection and the first correlated response are insufficient. Closure requires:

1. select the provider research strategy;
2. submit the scoped research request and optional sources;
3. surface clarification as `waiting_for_user` or apply an explicit caller policy;
4. approve or start a visible research plan when required;
5. preserve the same active execution while research runs in the background;
6. detect provider progress, limits, cancellation, and terminal failure;
7. read the completed final report rather than an intermediate message;
8. prove visible citations or source links; and
9. return report text plus any downloadable report artifacts.

### Generated Media and Files

- `image.generation`: prove a completed visible image result and return a bounded artifact reference; text claiming that an image was created is not closure.
- `image.edit`: prove that the edited result belongs to the submitted source image and instruction.
- `video.generation` and `audio.generation`: handle long-running progress and return the completed playable or downloadable artifact.
- `audio.transcription`: prove source-audio correlation and return the completed visible transcript rather than a file-selection or desktop-download prompt.
- `file.upload`: a populated `FileList` proves selection only; a visible provider attachment state proves acceptance.

### Generated Work Artifacts

Document, presentation, spreadsheet, and website capabilities must declare their output format and prove a completed preview or downloadable artifact. A prose answer containing Markdown, code, or slide suggestions does not satisfy an artifact-generation capability.

## Routing Consequences

- Product documentation expands reconnaissance; it never makes a route eligible.
- The router considers only implemented and real-E2E-closed provider strategies.
- Account, region, rollout, and quota are runtime eligibility checks.
- One V2 provider must satisfy the full requirement set.
- Provider ranking happens only after full-set capability compatibility. Fresh runtime eligibility wins over unchecked state, supported evidence wins over experimental evidence, and configured provider preference breaks the remaining tie.
- Stale cached access is `unchecked`, not trusted as live eligibility. Every attempt performs a read-only visible session and capability-UI preflight before mutation; no probe prompt is allowed.
- The job contract independently derives requirements from actions, attachment MIME types, and native workspace intent. A route that omits an action-required capability is invalid even when an internal caller supplied it.
- Automatic fallback consumes the ranked list without capability degradation. When no provider satisfies `research.deep` or another mandatory capability, routing stops with `task_capability_route_unavailable` rather than falling back to plain chat.
- The result records the canonical requirements, selected provider, provider strategies, runtime observations, evidence, and ranked remaining routes.
