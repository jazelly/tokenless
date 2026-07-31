# Provider Capability Census

Last reviewed: 2026-07-31

This is a product reconnaissance record, not a Tokenless support declaration. Official provider documentation establishes that a product feature exists. Tokenless advertises a route only after the provider adapter implements the complete visible lifecycle and real-provider browser E2E closes the required evidence.

The checked-in runtime catalog and provider routing matrix live in `packages/cli/src/providers/task-capabilities.ts`. `tokenless capabilities list --json` exposes that versioned catalog without opening a browser. The current V1 routeable outcomes are:

- `conversation.chat`: ChatGPT, Claude, Gemini, Grok, and experimental Qwen;
- `file.upload`: ChatGPT, Claude, and Grok; and
- `workspace.native`: Claude and Grok.

All other entries below remain discoverable candidates. In particular, `research.deep`, citations as a required production postcondition, continuation as an explicit capability, generated media, and generated work artifacts remain non-routeable until their complete execution contracts are implemented and real-provider E2E-closed.

## Evidence Ladder

Every provider/capability cell progresses independently:

1. `product_documented`: the provider officially describes the web product capability;
2. `live_observed`: the selected managed profile visibly exposes the relevant controls or state;
3. `implemented`: a provider strategy can execute the lifecycle through the packaged daemon;
4. `e2e_closed`: the built product proves the final visible and durable outcome against the real provider; and
5. `routeable`: the capability router may advertise and select the route for the observed account class.

A visible menu item never advances a capability beyond `live_observed`. Account tier, region, quota, rollout, and workspace policy may keep an officially documented feature unavailable for a specific profile.

## Current Tokenless Providers

The product surface is broader than the current Tokenless evidence. The middle column combines official documentation with prior live product reconnaissance; the final column summarizes the checked-in live acceptance matrix, not the provider's marketing claims.

| Provider | Documented or live-observed web product capabilities relevant to Tokenless | Current Tokenless evidence |
| --- | --- | --- |
| ChatGPT | Chat, web search with citations, Deep Research, file and image input, image generation and editing, data analysis, Canvas, agent mode, and Projects with files and instructions | Supported baseline chat, file acceptance, response citations, and same-conversation continuation; native Project, Deep Research, image generation, and agent lifecycles are not yet closed |
| Claude | Chat, web search, Research, files and images, Projects and project knowledge, Artifacts, model selection, extended thinking, and connectors | Supported baseline chat, model selection, file acceptance, continuation, citations, and native Project lifecycle; Research, Artifacts, and connector outcomes are not yet routeable |
| Gemini | Chat, web-grounded answers, Deep Research, file and image input, Deep Think, image/video/music generation, Canvas, Gems, notebooks, connected sources, and GitHub repository import | Supported baseline prompt and cited response for the selected profile; file acceptance, continuation, native workspace, Deep Research, generated media, and connected-source lifecycles are not yet closed |
| Grok | Chat, X and web search with citations, reasoning modes, image input, and image generation | Supported baseline chat, model and effort selection, file acceptance, continuation, citations, and native Project lifecycle; generated-image lifecycle is not yet closed |
| Qwen | Chat, web search, Deep Research Normal/Advanced, file-assisted research, image generation/editing, video generation, Web Dev, Artifacts, Slides, Learn, and travel planning modes | Experimental baseline chat, effort selection, and provider-specific mode selection; full Deep Research report, file acceptance, continuation, generated media, and native workspace remain unclosed |

Official references:

- [ChatGPT capabilities](https://help.openai.com/en/articles/9260256-chatgpt-capabilities-overview), [Deep Research](https://help.openai.com/en/articles/10500283-deep-research-in-chatgpt), and [Projects](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [Claude Research](https://support.anthropic.com/en/articles/11088861-using-research-on-claude-ai), [web search](https://support.anthropic.com/en/articles/10684626-enabling-and-using-web-search), [Projects](https://support.anthropic.com/en/articles/9529781-examples-of-projects-you-can-create), and [Artifacts](https://support.anthropic.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
- [Gemini Apps capability index](https://support.google.com/gemini) and [Gemini Deep Research](https://support.google.com/gemini/answer/15719111)
- [Grok web search and citations](https://x.ai/news/grok-1212) and [Grok on the web](https://help.x.com/en/using-x/about-grok)
- [Qwen Deep Research](https://qwen.ai/blog?id=qwen-deepresearch) and [Qwen Image](https://qwen.ai/blog?id=qwen-image-2.0)

## Candidate Web Providers

| Candidate | Canonical web entry | Officially documented or currently confirmed surface | Recommended evaluation |
| --- | --- | --- | --- |
| Kimi | `https://www.kimi.com/` | Web chat, built-in web search and deep thinking, large file inputs, asynchronous Deep Research with clarification, progress, citations and multi-format reports, general Agent, Agent Swarm, Docs, Sheets, Slides, Websites, image generation, and coding products | P1. Best next provider for proving the complete `research.deep`, background-task, and generated-artifact contracts |
| Z.ai / GLM | `https://chat.z.ai/` | GLM-5.2 web chat, 1M context, flexible effort levels, coding and long-horizon agent strengths | P1. Treat Z.ai and `chatglm.cn` as separate web surfaces until origin, account, and conversation identity are proven equivalent; begin with baseline, effort, long-context file, and coding reconnaissance |
| Perplexity | `https://www.perplexity.ai/` | Web search with citations, Pro Search, Advanced Deep Research, file-aware research, Spaces, model selection, image generation/editing, and creation of documents, spreadsheets, presentations, and HTML apps | P1. Strong reference adapter for research, citation, source-scope, Space, and multi-format artifact semantics |
| Mistral Le Chat | `https://chat.mistral.ai/` | Web search and citations, Deep Research, Think mode, Projects and Libraries, files, code interpreter, image generation/editing, Canvas, agents, and MCP connectors | P1. Broad capability match with relatively clear official documentation; useful second adapter for research and artifact semantics |
| DeepSeek Chat | `https://chat.deepseek.com/` | Web chat, Instant/Expert modes, 1M context, agent/search improvements, file upload, and webpage summarization | P1. High user value and likely compact baseline; product-specific search, file, and conversation behavior still require live web reconnaissance |
| Doubao | `https://www.doubao.com/chat/` | The official web product and feature-introduction surface exist, but stable official web help does not currently provide enough detail to classify its advanced capability lifecycles | P2 pending policy and live reconnaissance. Review the product terms before automation work and treat every advanced capability as `unknown` until visibly proven |
| Meta AI | `https://www.meta.ai/` | Web chat, voice, personalization, image generation and editing, multi-reference composition, search-grounded image creation, Discover, and limited document editor/import experiments | P2 image-first candidate. Do not infer Deep Research, stable file analysis, or document workflow from experiments |
| Microsoft Copilot | `https://copilot.microsoft.com/` | Web chat, Quick/Think Deeper/Smart modes, Deep Research, file upload, image generation/editing, Pages, connectors, voice, and browser-related experiences | P2. Rich canonical coverage, but Microsoft account, product-surface, and connector policy complexity raise the reconnaissance cost |
| Tencent Yuanbao | `https://yuanbao.tencent.com/` | Web product, Tencent-enhanced web search, multi-format file reading, reasoning/model surfaces, and the broader Tencent content ecosystem | P2. Valuable Chinese search and file route; advanced artifact and workspace claims need official and live closure |
| MiniMax Agent | `https://agent.minimax.io/` | Long-horizon planning, web and application generation, code execution, multimedia understanding and generation, and MCP integrations | P3 specialist adapter. Its autonomous-agent lifecycle is materially different from chat and should not be forced into the baseline provider contract |

Official candidate references:

- [Kimi overview](https://www.kimi.com/help/getting-started/overview), [Kimi Deep Research](https://www.kimi.com/help/deep-research/deep-research-overview), and [Kimi Agent](https://www.kimi.com/help/agent/agent-overview)
- [GLM-5.2 on Z.ai](https://z.ai/blog/glm-5.2)
- [Perplexity overview](https://www.perplexity.ai/help-center/en/articles/10352895-how-does-perplexity-work), [Spaces](https://hub-prod.perplexity.ai/hub/faq/what-are-spaces), [image generation](https://www.perplexity.ai/help-center/en/articles/10354781-generating-images-with-perplexity), and [generated assets](https://www.perplexity.ai/help-center/en/articles/12528830-creating-assets-with-perplexity-overview)
- [Mistral Le Chat research and Projects](https://mistral.ai/news/le-chat-dives-deep/) and [Le Chat product surface](https://mistral.ai/news/all-new-le-chat/)
- [DeepSeek V4 web modes](https://api-docs.deepseek.com/news/news260424) and [DeepSeek updates](https://api-docs.deepseek.com/updates/)
- [Doubao official web product terms](https://www.doubao.com/legal/ey01) and [official feature introduction](https://www.doubao.com/legal/feature_intro)
- [Meta AI web product](https://about.fb.com/news/2025/04/introducing-meta-ai-app-new-way-access-ai-assistant/) and [Muse Image on meta.ai](https://ai.meta.com/blog/introducing-muse-image-muse-video-msl/)
- [Microsoft Copilot capabilities](https://support.microsoft.com/en-gb/microsoft-copilot), [Deep Research](https://support.microsoft.com/en-us/Microsoft-Copilot/deep-research-in-microsoft-copilot), and [file upload](https://support.microsoft.com/en-US/microsoft-copilot/file-upload-in-microsoft-copilot)
- [Tencent Yuanbao web search](https://cloud.tencent.com/product/wsa) and [desktop file support](https://yuanbao.tencent.com/evt/dl)
- [MiniMax Agent](https://www.minimax.io/news/minimax-agent)

## Canonical Capability Schema

The caller catalog must describe outcomes, not provider controls. `qwen.mode`, `model.choice`, `effort.choice`, DOM selectors, and marketing model names stay inside provider strategy adapters.

### Proposed Capability Families

| Family | Candidate canonical capabilities |
| --- | --- |
| Conversation | `conversation.chat`, `conversation.continue` |
| Inputs | `file.upload`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
| Retrieval and reasoning | `search.web`, `research.deep`, `reasoning.extended`, `code.execute`, `data.analyze` |
| Media generation | `image.generation`, `image.edit`, `video.generation`, `audio.generation` |
| Artifact generation | `document.generation`, `presentation.generation`, `spreadsheet.generation`, `website.generation` |
| Workspace and knowledge | `workspace.native`, `workspace.instructions`, `workspace.knowledge`, `source.connected` |
| Evidence and lifecycle | `response.citations`, `artifact.download`, `task.background`, `task.interactive` |

This is a candidate vocabulary. A capability becomes public only when at least one provider has a complete semantics and real-provider closure. Similar provider labels do not establish equivalent behavior.

Keep the first public catalog small. Real-time voice conversations, persistent personalization or memory, arbitrary autonomous web actions, connector writes, and iterative artifact editing or sharing require separate safety and lifecycle contracts. The schema may add those outcomes later, but provider marketing labels such as “agent,” “canvas,” or “memory” must not enter V1 as underspecified generic capabilities.

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

All V1 requirements are mandatory. Attachments infer the corresponding input capabilities. Requested output kinds infer generation capabilities. The router must find one provider strategy set that satisfies every explicit and inferred requirement, including the requested parameter subset.

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
5. preserve the same durable job while research runs in the background;
6. detect provider progress, limits, cancellation, and terminal failure;
7. read the completed final report rather than an intermediate message;
8. prove visible citations or source links; and
9. return report text plus any downloadable report artifacts.

### Generated Media and Files

- `image.generation`: prove a completed visible image result and return a bounded artifact reference; text claiming that an image was created is not closure.
- `image.edit`: prove that the edited result belongs to the submitted source image and instruction.
- `video.generation` and `audio.generation`: handle long-running progress and return the completed playable or downloadable artifact.
- `file.upload`: a populated `FileList` proves selection only; a visible provider attachment state proves acceptance.

### Generated Work Artifacts

Document, presentation, spreadsheet, and website capabilities must declare their output format and prove a completed preview or downloadable artifact. A prose answer containing Markdown, code, or slide suggestions does not satisfy an artifact-generation capability.

## Routing Consequences

- Product documentation expands reconnaissance; it never makes a route eligible.
- The router considers only implemented and real-E2E-closed provider strategies.
- Account, region, rollout, and quota are runtime eligibility checks.
- One V1 provider must satisfy the full requirement set.
- Provider preference is evaluated after capability compatibility, so a later preferred provider may win when earlier entries cannot satisfy the request.
- The result records the canonical requirements, selected provider, provider strategies, runtime observations, and evidence used for the decision.
