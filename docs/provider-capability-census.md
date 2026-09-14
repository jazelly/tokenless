# Provider Capability Census

Last reviewed: 2026-09-14

## 2026-09-14 provider inventory audit

The current Tokenless API registry contains **41 store providers**: **19 Browser**, **35 Direct API**, with **13 in both modes**. Browser task routes exist for 17 providers; Microsoft Copilot and HuggingChat are registered but still have no advertised task route. Direct API counts describe adapter mappings, not 35 individually verified providers.

GLHF, TheB.AI, and Fenay AI were removed after their live sites failed to load. Blackbox AI was removed after the selected account reached its enterprise-only access page.

Puter was also removed from the supported catalog after local evaluation.

GPT4Free main was reviewed at [`e5d68e1`](https://github.com/xtekky/gpt4free/tree/e5d68e15499260ec2e5da351dda4352270a15c40) (2026-09-10). Browser-assisted authentication, challenge handling, and in-page HTTP requests do not supply Tokenless API DOM adapters. The following browser-assisted providers have no corresponding completed Browser task route in this repository:

| Provider | GPT4Free implementation | Current Tokenless API mode |
| --- | --- | --- |
| Hugging Face / HuggingChat | [HuggingChat.py](https://github.com/xtekky/gpt4free/blob/e5d68e15499260ec2e5da351dda4352270a15c40/g4f/Provider/needs_auth/hf/HuggingChat.py) | Browser entry without a completed task route; Direct API |
| Pi | [Pi.py](https://github.com/xtekky/gpt4free/blob/e5d68e15499260ec2e5da351dda4352270a15c40/g4f/Provider/needs_auth/Pi.py) | Direct API |
| MiniMax / HailuoAI | [HailuoAI.py](https://github.com/xtekky/gpt4free/blob/e5d68e15499260ec2e5da351dda4352270a15c40/g4f/Provider/needs_auth/mini_max/HailuoAI.py) | Direct API |
| ElevenLabs | [ElevenLabs.py](https://github.com/xtekky/gpt4free/blob/e5d68e15499260ec2e5da351dda4352270a15c40/g4f/Provider/audio/ElevenLabs.py) | Direct API |
| Microsoft Designer | [MicrosoftDesigner.py](https://github.com/xtekky/gpt4free/blob/e5d68e15499260ec2e5da351dda4352270a15c40/g4f/Provider/needs_auth/MicrosoftDesigner.py) | Not registered |

These are candidates, not verified additions. MiniMax Agent is a separate web product from the HailuoAI adapter above.

## Agnes AI Browser acceptance · 2026-09-14

The experimental `agnes` adapter completes real Browser Chat, durable continuation, Markdown/document and PNG/image input, normalized citations, and account inspection through the built CLI and packaged daemon. Ego Lite reconnaissance supplied live selectors; the acceptance below used the registry-default managed profile instead.

| Boundary | Observed result |
| --- | --- |
| Built CLI / packaged daemon | Build and focused real-provider gates passed; no fixture or direct-protocol substitution |
| Chat, document, image, continuation, and citations | Fresh `TOKENLESS_LIVE_AGNES_GATE=1 node --test test/live-agnes-chat.e2e.mjs` run completed five submissions in 123.6s: `tlp_ec3fbde3-06fa-4a23-9a3b-16420a3b6e0a`, `tlp_a8c6027b-9d15-48bf-9f85-974691227830`, `tlp_82f1e8d1-9774-46cc-aa89-52befa2515b4`, `tlp_7bc08362-7aec-4dec-9b36-cda6347a00b1`, `tlp_90ab918d-e1d2-4de7-aae3-5d019e38170e`; all jobs succeeded, including durable continuation and normalized citation output |
| Harness attachment roundtrip | Fresh `test/live-agnes-harness.e2e.mjs` run completed two turns in 83.8s: `b0c3f67a-c4c6-4686-9387-d3657ba16b96`, `d523f9ba-f6d4-45d8-bd8d-94d0a0453d71`; both accepted Markdown attachments, used local read-only `workspace.read`, and returned exact final proof without fallback |
| Managed capability matrix | Non-submission `test-results/live-provider-e2e/20260914T073222Z_52ca655a-non_submission.json` passed readiness, prompt draft, and file selection 3/3; mutation `test-results/live-provider-e2e/20260914T072313Z_85788bbb-mutation.json` passed continuation, citations, and baseline 3/3. The generic attachment-plus-citation `conversation-workflow` case remains unavailable and is not advertised |
| Selected profiles | `web-ai` is `Jason Z4350`; registry-default `login-2026-09-05` is `XZHA4350`, with the existing Cloak runtime binding preserved; Agnes Browser membership is enabled through `tokenless config` |
| Authentication | `tlp_7f089d0c-cced-4851-9509-a4872723f0d8`: authenticated `xzha4350`, observed `Free`, `signed_in_free`; account menu inspected and restored, no session values acquired |
| Yellow profile | Live `auth.status` through the production browser control API returned authenticated `jasonz4350`, observed `Free`, `signed_in_free`; both configured profiles are now logged in to Agnes |
| Rate limits | `limits inspect` returned `unknown` because the page exposes only non-numeric monthly Web credits. The bounded real probe in `test-results/live-provider-e2e/agnes-rate-probe-20260914.json` ran three serial prompts at one-second spacing; all succeeded with no `rateLimit` or `retryAfter`, so no numeric RPM claim is made |
| Blocker check | Final rebuilt adapter: `tlp_306e3f7c-f7e1-411c-8b82-e2d9823d2b22` passed against the retained real conversation, `blocked: false`; unobserved Agnes-specific quota-warning selectors remain absent |
| Terminal-Bench | Official 4.0 `wal-recovery-ordering`, fixed `tokenless/agnes`, blue profile, k=1, retry=0: valid daemon run `05-wal-recovery-ordering-agnes-20260914` ended reward 0 with 44/97 verifier checks passed and 53 failed; the preceding real host job `5149b4f1-d162-43ef-81de-5188ea85c85a` returned a visible 1,020-character answer that was not JSON (`protocol/nonce/kind/calls` absent), while the later run exceeded the DSH client window and ended `client_closed_request`; no rate-limit signal observed |
| Structured schema/tool boundary | The exact official input contained 23 declared functions and `tool_choice=read`; Agnes produced no observed `tool_calls`, no tool result, and no continuation/child chain. The route therefore remains Chat/document/image/citation only; agentic Terminal-Bench support is not advertised |

The [consumer subscription page](https://app.agnes-ai.com/subscription) displayed monthly credits: Starter 9,000, Plus 18,000, Pro 90,000. Credit balances and monthly allowances do not establish a per-message Chat cost, RPM, or reset window. The separate [official API Token Plan FAQ](https://github.com/AgnesAI-Labs/AgnesAI-Models/blob/main/docs/TOKEN_PLAN_FAQ.md) is not evidence of consumer Web quotas.

The benchmark used the pinned Harbor/DSH setup with reasoning effort `high`; no website model/effort label was observed. The completed official run had one trial, zero retries, and no native token/cost usage.

The parent job stored `capabilityRoute: null`; no benchmark capability requirements or completed provider-routing event are inferred from the current capability catalog.

Raw results are retained under `benchmarks/terminalbench/results/agnes-20260914/` for the serial official attempts; startup identities and all evidence/artifact hashes are in `observations/agnes-20260914/`. The canonical collector requires `tokenless-run.json`, absent from these direct fixed-provider runs, so no schema-validated `run-observation.json` is claimed.

Reproduce Chat acceptance with `TOKENLESS_LIVE_AGNES_GATE=1 node --test test/live-agnes-chat.e2e.mjs`, Harness with `test/live-agnes-harness.e2e.mjs`, and the managed matrix with `TOKENLESS_LIVE_E2E_GATE=mutation TOKENLESS_LIVE_E2E_PROVIDER=agnes TOKENLESS_LIVE_E2E_CASES=conversation-continuation,workspace-response-citations,workspace-response-baseline env -u CODEX_THREAD_ID node --test --test-concurrency=1 test/live-managed-playwright.e2e.mjs`. Model/effort selection, native Projects, scheduled workflows, generic `conversation-workflow`, and other agentic actions are not advertised without live closure. The earlier workflow timeout remains job history, not rate-limit evidence.

The checked-in live-matrix validator now passes for 42 cases across 19 providers. Focused Agnes gates are separate; no all-provider live E2E suite pass is claimed.

## Earlier capability evidence

This is a product reconnaissance record, not a Tokenless support declaration. Official provider documentation establishes that a product feature exists. Tokenless advertises a route only after the provider adapter implements the complete visible lifecycle and real-provider browser E2E closes the required evidence. The normative naming, mapping, support, and extension rules live in the [Capability Matrix](capability-matrix.md).

The checked-in runtime catalog and provider routing matrix live in `packages/server/src/providers/task-capabilities.ts`. `tokenless capabilities list --json` exposes that versioned catalog without opening a browser. The current V3 routeable outcomes are:

- `conversation.chat`: ChatGPT, Claude, Gemini, Grok, Arena, and experimental Qwen, DeepSeek, Perplexity, Z.ai, Doubao, Kimi, Dola, Meta AI, GitHub Copilot, Lovable, Monica, and Agnes;
- `conversation.continue`: supported Arena plus experimental GitHub Copilot and Agnes;
- `image.generation` and `artifact.download`: experimental ChatGPT, Gemini, Grok, Doubao, Arena, and Meta AI;
- `file.upload` (transport): supported ChatGPT, Claude, and Grok; experimental Gemini, Qwen, DeepSeek, Perplexity, Z.ai, Doubao, Kimi, Dola, Meta AI, and Agnes, plus image-scoped Arena;
- `document.input` for Markdown/PDF-style documents: the same evidence-backed generic-document provider set as `file.upload`, excluding Arena's image-only route and including Agnes;
- `image.input`: experimental Arena and Agnes;
- `search.web`: experimental Kimi; and
- `response.citations`: experimental Kimi search and Agnes.

All other entries below remain discoverable candidates. In particular, `research.deep`, provider-specific citation or continuation outcomes without a closed route, other generated media, and generated work artifacts remain non-routeable until their complete execution contracts are implemented and real-provider E2E-closed.

The Harness attachment gate is stricter than generic file upload: it requires bootstrap Markdown, a framed tool call, real read-only tool execution, same-conversation tool-result Markdown, and a succeeded child run without fallback. ChatGPT, Gemini, DeepSeek, Z.ai, Doubao, Kimi, and Dola passed on 2026-08-31; Qwen passed on 2026-09-01 in 74,595ms with two submissions, visible attachment/submission/response proof, one conversation with two visible turns, durable state, and no fallback. Claude, Grok, Perplexity, and Meta AI retain generic Markdown document routes but are excluded from Harness V0 and Auto. Arena accepts image files but not Markdown; its experimental `file.upload` transport is paired with `image.input` and has no `document.input` route. Exact current reasons are recorded in the [Capability Matrix](capability-matrix.md#harness-attachment-eligibility).

The unified `POST /v1/images/generations` endpoint persists browser and direct results into the same scoped asset store. Browser auto routing selects only enabled, usable providers with both `image.generation` and `artifact.download`; its Gemini and Doubao gates each completed one visible submission, terminal artifact, local digest, and authenticated readback. Dola image routing is currently unavailable after the focused 2026-09-01 run reached `daemon_unavailable` after 300 seconds. Direct V1 includes the logical `tokenless/pollinations/sana` route and the explicit `tokenless/chatgpt/gpt-image` route; both keep private implementation names out of public model IDs, responses, and capability evidence. The Pollinations direct gate produced and read back one 768×768 JPEG, while ChatGPT direct uses an ephemeral browser-scoped auth bridge before persisting verified image bytes.

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
| ChatGPT | Chat, web search with citations, Deep Research, file and image input, image generation and editing, data analysis, Canvas, agent mode, and Projects with files and instructions | Supported chat plus Harness-verified `file.upload` transport and `document.input`; the live gate completed bootstrap, tool execution, continuation upload, and exact final proof without fallback. Independent image and Project evidence remains separately scoped |
| Claude | Chat, web search, Research, files and images, Projects and project knowledge, Artifacts, model selection, extended thinking, and connectors | Supported chat, generic Markdown `file.upload` transport plus `document.input`, and native Project routes remain; upload, submit, and response pass, but Harness attachment instructions are rejected as prompt injection |
| Gemini | Chat, web-grounded answers, Deep Research, file and image input, Deep Think, image/video/music generation, Canvas, Gems, notebooks, connected sources, and GitHub repository import | Supported chat plus experimental Harness-verified `file.upload` transport and `document.input`; upload control redraw is observed within the existing interaction timeout. Image generation remains independently experimental |
| Grok | Chat, X and web search with citations, reasoning modes, image input, and image generation | Supported chat plus generic Markdown `file.upload` transport and `document.input`; the selected profile is blocked by a visible weekly limit until 2026-09-02 06:47:22 UTC, so it is not currently Harness-eligible. Imagine image generation remains independently experimental |
| Qwen | Chat, web search, Deep Research Normal/Advanced, file-assisted research, image generation/editing, video generation, Web Dev, Artifacts, Slides, Learn, and travel planning modes | Experimental Markdown `file.upload` transport and `document.input`, now Harness-verified: the 74,595ms built CLI/packaged-daemon gate completed two submissions with visible attachment/submission/response proof in one conversation, two visible turns, durable state, and no fallback. The adapter waits for spinner/`Parsing...` terminal state, removes only exact-name matching pending stale drafts with card-local **Remove file**, then uses the visible Select Mode → Upload attachment path and sets the current `#filesUpload` input once; terminal busy state uses only `button.stop-button` |
| DeepSeek | Signed-in web chat, Instant/Expert/Vision modes, DeepThink, web search, broad file and image input, and synchronized chat history | Experimental chat plus Harness-verified `file.upload` transport and `document.input`; bootstrap, framed read-only tool call, same-conversation tool-result upload, and exact final proof passed without fallback |
| Perplexity | Web search with citations, Pro Search, Advanced Deep Research, file-aware research, Spaces, model selection, image generation/editing, and multi-format asset creation | Experimental chat plus generic Markdown `file.upload` transport and `document.input`; the selected Free profile's official 3/day allowance is currently exhausted, so the API capacity guard excludes the two-upload Harness request before browser work |
| Z.ai / GLM | GLM-5.2 web chat, 1M context, flexible effort levels, coding, and long-horizon agent strengths | Experimental chat plus Harness-verified Markdown `file.upload` transport and `document.input`; ordinary Enter submission after a failed click transition and the conversation-page composer completed both turns |
| Doubao / 豆包 | Signed-in Chinese web chat; visible free-account discrimination; Fast, Expert, and Work Task modes; writing, presentation, image, video, deep-research, podcast, music, problem-solving, and spreadsheet Web skills; broad file input; desktop-only recording transcription entry | Experimental chat, image, and Harness-verified Markdown `file.upload` transport plus `document.input`; the adapter precisely dismisses the provider desktop-promotion dialog before submission |
| Kimi | Signed-in web chat; Instant, K3, and K3 Swarm models; Standard/High thinking effort; files, Web search, Plugins, Skills, Projects, and broader research/agent/artifact surfaces | Experimental chat, search, and Harness-verified Markdown `file.upload` transport plus `document.input`; the selected `web-ai` Cloak profile is signed in on `kimi.ai` and completed both turns |
| Dola | Signed-in web chat; Fast and Pro choices; file input; Create Image, Writing, Create Video, Translate, and Homework entries; a separate Seedream image-creation surface; no observed Project, file library, or persistent knowledge-management surface | Experimental chat plus Harness-verified `file.upload` transport and `document.input`; both Markdown turns were individually visible and consumed. Image generation is currently unavailable after the focused 2026-09-01 run reached `daemon_unavailable` after 300 seconds |
| Arena | Signed-in Battle, Direct, and Side-by-Side chat; model selection; file input; Search, Code, Agent, Image, and Video surfaces | Supported Direct chat and independent experimental generated-image routes remain; experimental image-scoped `file.upload` transport plus `image.input` accepts PNG, JPEG, and WebP, but no `document.input` or Markdown route is advertised |
| Meta AI | Signed-in web chat; Instant and Thinking modes; broad file input; visible image generation; research-progress and assistant-response surfaces | Experimental chat, image, and generic Markdown `file.upload` transport plus `document.input` remain; exact Harness bytes upload, but the combined attachment instruction is silently rejected without a conversation |
| GitHub Copilot | Signed-in Ask/Agent, repository context, model access, files/images, message tokens, account AI credits, Spaces, and cloud agents | Experimental Ask/Agent controls, repository-as-Project, selectable versus Pro+/Max-locked models, message token counters, and account/session AI credits. Real GPT-5.6 Luna acceptance covers TXT, Markdown, JSON, CSV, TypeScript, PNG, repository reading, cloud Agent tool steps, and the two-turn Harness Markdown workflow without fallback. See [controls and verification](github-copilot.md). Spaces remain unadvertised |
| Lovable | Signed-in AI app builder with project preview and same-project chat | Experimental Browser `conversation.chat`; fresh packaged CLI/daemon `lovable-project-roundtrip` acceptance passed on 2026-09-14 in profile `login-2026-09-05`, including a real project prompt, visible response, preview heading, and working counter button. Report: `test-results/live-provider-e2e/20260914T070953Z_3d9f7673-mutation.json` |
| Agnes AI | Browser Chat with Markdown/document and PNG/image input, durable conversation reuse, visible citations, and account-plan inspection | Experimental Browser `conversation.chat`, `conversation.continue`, `file.upload`, `document.input`, `image.input`, and `response.citations`; model/effort controls, native Projects, and provider-native agentic workflows remain unadvertised |

Official references:

- [GitHub Copilot web chat](https://docs.github.com/en/copilot/how-tos/copilot-on-github/chat-with-copilot/chat-in-github) and [usage limits](https://docs.github.com/en/copilot/concepts/usage-limits)
- [Lovable](https://lovable.dev/) and [pricing and credits](https://lovable.dev/pricing)
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
| Lovable | `https://lovable.dev/` | Real signed-in page accepted a minimal counter build and created a project on 2026-09-12 | Experimental Browser adapter is implemented and routeable for `conversation.chat`; the packaged CLI/daemon `lovable-project-roundtrip` gate and preview counter readback passed on 2026-09-14 in `login-2026-09-05`. |
| Replit | `https://replit.com/` | [Replit Agent](https://replit.com/products/agent) builds apps through chat; the inspected browser requires login | Requested first addition. Manual login is required before inspecting and implementing the real workspace workflow. No adapter is advertised |
| Mistral Le Chat | `https://chat.mistral.ai/` | Web search and citations, Deep Research, Think mode, Projects and Libraries, files, code interpreter, image generation/editing, Canvas, agents, and MCP connectors | P1. Broad capability match with relatively clear official documentation; useful second adapter for research and artifact semantics |
| Microsoft Copilot | `https://copilot.microsoft.com/` | Observed on 2026-09-05: chat, Smart/Think deeper/Study and learn/Search modes, Markdown upload, image and Deep Research entries, podcasts, quizzes, connectors, and Projects | The signed-in ego-browser Observer completed two chat turns and read a unique token from an uploaded Markdown file in the same conversation. The configured Tokenless API profile still requires separate CLI/daemon acceptance |
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
| Inputs | `file.upload` (transport), `document.input`, `image.input`, `audio.input`, `video.input`, `url.input`, `repository.import` |
| Retrieval and reasoning | `search.web`, `research.deep`, `reasoning.extended`, `audio.transcription`, `code.execute`, `data.analyze` |
| Media generation | `image.generation`, `image.edit`, `video.generation`, `audio.generation` |
| Artifact generation | `document.generation`, `presentation.generation`, `spreadsheet.generation`, `website.generation` |
| Workspace and knowledge | `workspace.native`, `workspace.instructions`, `workspace.knowledge`, `source.connected` |
| Evidence and lifecycle | `response.citations`, `artifact.download`, `task.background`, `task.interactive` |

This is a candidate vocabulary. A capability becomes public only when at least one provider has a complete semantics and real-provider closure. Similar provider labels do not establish equivalent behavior.

Provider-native labels such as Kimi Skill or Dola Homework remain namespaced workflows. A user-owned `SKILL.md` is separate Harness context delivered through `conversation.chat`, `file.upload`, and `document.input`; it is not part of the canonical capability vocabulary.

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
