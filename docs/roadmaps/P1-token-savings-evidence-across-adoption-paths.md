# Token Savings Real-Project Test Matrix

Status: proposed | Priority: P1 | First runnable path: Skill + CLI selective delegation  
Last reviewed: 2026-08-10

Related: [Optional Output Savings Measurement](P1-optional-output-savings-measurement.md) owns the existing savings metric and runtime; [Web Agent Harness](P0-web-agent-harness.md) owns System Prompt, Skill, tool, and multi-turn execution; [Context Delivery and Workspace Alignment](P0-context-delivery-and-workspace-alignment.md) owns authorized project context transport; [Real Provider Browser E2E and Native Projects](P0-real-provider-browser-e2e-and-native-projects.md) owns the existing real-provider boundary

## Outcome

Run one user-reviewed, real-project task through every Tokenless adoption path and every provider enabled in the configured production test profile. Record the estimated output tokens saved by each real Tokenless response, round by round, then extend the same run to prove that the Web Agent Harness receives project context, delivers its System Prompt Bundle, requests real Skills and tools, and continues after their results.

This roadmap is the test initiative. It assumes the three product paths are implemented when their rows run; it does not own their API design or implementation.

## Fixed Savings Definition

The existing definition remains authoritative:

> Estimated tokens saved = the normalized visible assistant output produced through Tokenless at the shared `response.read` boundary, tokenized with the versioned `o200k_base` estimator.

Every measured response turn contributes once. A multi-turn Harness run therefore saves the sum of its measured visible response turns. Failed submissions and responses that never reach `response.read` contribute zero and remain visible as failures, not estimated values.

The test does not run an official-agent baseline, inspect the primary agent's token usage, or calculate net reduction.

## Assumed Adoption Paths

| Path | Real entry boundary under test | Provider sweep |
| --- | --- | --- |
| 1. Full replacement API | A real compatible client or agent sends the approved task through the Tokenless OpenAI-compatible API | One explicit request to every enabled provider |
| 2. Tokenless sub-agent | A real primary-agent task delegates one bounded subtask to a sub-agent configured with the Tokenless API | One explicit sub-agent request to every enabled provider |
| 3. Skill + CLI selective delegation | A real agent selects the installed Tokenless Skill and invokes the built CLI | One explicit Skill + CLI request to every enabled provider |

The same approved task intent is used across all cells. Each path uses its real wrapper and identity fields, but no path may silently rewrite the task to make a provider look better.

## One Configured Provider Set

All browser and provider runs load the repository-local `.env`, follow `TOKENLESS_TEST_HOME` to one complete Tokenless home, derive its root `config.json`, and use only the adjacent registry's default production profile. The provider set is exactly that profile's `enabledProviders`.

The release test profile should enable every registered provider the user intends to test and has authorized. Before prompt submission, the coordinator reports:

- every registered provider;
- every provider enabled in the default test profile;
- disabled providers and the fact that they are outside this run;
- current readiness and authentication state; and
- which enabled providers satisfy the additional Harness capability requirements.

The test never edits the user's provider selection, changes profiles, creates accounts, or automates login. Missing authentication fails that provider's run unless it matches the repository's sole declared Claude Cloudflare skip.

The configured profile and runtime remain the only source of browser identity. Provider workers do not create their own profiles, user-data directories, browser processes, or test configs.

## Prompt Review Gate

Each complete matrix begins with a new prompt derived from a real, current task in a real project.

1. The test coordinator inspects the selected project and proposes one concrete task prompt.
2. The prompt names the desired outcome and acceptance evidence, not a toy token-generation instruction.
3. The coordinator presents the exact prompt, project root, proposed context files, GitHub URLs, roadmap files, Harness System Prompt Bundle revision, requested Skills, and tool/MCP scope to the user.
4. No provider submission occurs until the user approves the package.
5. Approval freezes the exact user-prompt bytes, SHA-256 digest, context manifest, System Prompt template revision, and Harness expectations for the run; run-specific correlation values remain generated and recorded per run.

A rejected prompt is revised and reviewed again. The approved prompt is not regenerated independently for each provider or adoption path.

### Prompt Selection Criteria

The task must be useful even when a provider receives only the prompt. It should also become materially better when the full Harness context is available.

Prefer a task that naturally requires:

- understanding at least one important implementation file;
- comparing implementation with an active roadmap or design decision;
- following one or more user-approved GitHub repository, issue, pull-request, or documentation URLs;
- inspecting current local repository state through a bounded Bash/process tool;
- loading a relevant installed Skill through `skillLoads`; and
- reading one real external fact through a configured MCP server.

Do not put a fabricated answer, expected token count, or complete expected action envelope into the prompt. The task should cause the web model to request the context and tools because they are genuinely needed.

## Provider-Worker Orchestration

The coordinator assigns exactly one sub-agent worker to each enabled provider. That worker owns the provider for the complete matrix and uses an explicit provider constraint so routing cannot fall through to another provider.

Workers share the configured production profile and use Tokenless's normal daemon scheduling. They may prepare or wait concurrently, but they do not bypass provider/profile lanes. The coordinator closes one logical round across all providers before advancing the matrix.

Each provider worker must:

- use only the approved prompt and context revision;
- enter through the real adoption-path surface named by the round;
- create a fresh provider conversation for each adoption path unless the round explicitly tests continuation;
- retain exact job, response-request, conversation, path, provider, profile, and prompt-digest identity;
- perform no internal retry when a required run fails;
- record visible blockers and unavailable capabilities honestly;
- detach its CDP client after its work; and
- leave the configured browser, profile, pages, conversations, and provider artifacts intact.

## Round-by-Round Procedure

### Round 0: Freeze Input and Coverage

- Resolve `TOKENLESS_TEST_HOME`, the default production profile, and its `enabledProviders`.
- Generate the real-project prompt package and stop for user review.
- Freeze the approved prompt and context hashes.
- Assign one provider worker per enabled provider.
- Produce the empty `3 × enabledProviders` savings matrix before submission.

Exit: every planned cell has one owner, one exact provider, and the same approved prompt digest.

### Round 1: Full Replacement API Sweep

Every provider worker sends the approved task through a real OpenAI-compatible client configured with the Tokenless API and its assigned explicit provider.

For each provider, verify:

- the request entered through the compatibility API;
- the assigned provider received one real visible submission;
- Tokenless read the real visible response;
- one savings event belongs to the exact response request; and
- the provider row records visible characters, estimated tokens saved, estimator revision, duration, and outcome.

Exit: every enabled provider has passed, failed, or reached the one allowed known-issue state. No provider remains silently unrun.

### Round 2: Tokenless Sub-Agent Sweep

Every provider worker runs the same task as a real Tokenless-backed sub-agent while the primary agent remains on its normal provider. The Tokenless sub-agent is constrained to the worker's assigned provider.

For each provider, verify:

- the primary agent created a real sub-agent delegation;
- the sub-agent entered through the Tokenless API rather than the primary provider API;
- the delegated response returned to the originating agent boundary; and
- every Tokenless response turn produced its normal savings event.

Only Tokenless-visible response tokens count. The primary agent's coordination tokens are not measured or subtracted.

Exit: the sub-agent column is complete for every enabled provider.

### Round 3: Skill + CLI Sweep

Every provider worker runs the approved task through a real agent session that selects the installed Tokenless Skill and invokes the built CLI with its assigned provider.

For each provider, verify:

- the Tokenless Skill was the agent-facing routing entry;
- the built CLI and packaged daemon created the real provider job;
- the response returned through the same invoking agent turn; and
- the exact response savings event appears in the job detail and aggregate savings total.

Exit: the Skill + CLI column is complete for every enabled provider.

### Round 4: Harness Bootstrap and Project Context

The savings sweeps above require only a real prompt and response. Providers without file upload or other Harness prerequisites still remain valid savings rows.

For every enabled provider that supports the Harness's required `conversation.chat` and `file.upload` boundary, start a fresh Harness run using the approved task and deliver a bounded, user-approved context package containing:

- repository identity and the exact project/worktree root;
- selected important source and configuration files;
- relevant active roadmap files;
- repository instructions that are authorized to share;
- approved GitHub URLs as explicit links with their source labels;
- the task goal, constraints, and completion criteria; and
- a manifest containing display names, provenance, byte counts, and SHA-256 digests.

Verify each source at two boundaries: Tokenless staged the approved bytes, and the provider visibly accepted the rendered prompt or attachment. Record omissions and capability degradation per provider.

A provider that supports the savings prompt but cannot accept the Harness package keeps its savings result and receives an explicit `harness_unavailable` result. It is not removed from the matrix.

Exit: every Harness-eligible provider has a context receipt tied to the exact run, conversation, provider, profile, and source revision.

### Round 5: System Prompt Bundle and First Model Turn

Compile the exact `HarnessSystemPromptBundle` for the run. It must include the frozen protocol, run and turn correlation rules, complete bounded Skill metadata registry, tool catalog, MCP catalog, limits, action-batch schema, and final-output contract.

Before sending the user task, verify:

- the compiled System Prompt Bundle bytes and SHA-256 digest;
- its immutable staged attachment identity;
- visible provider acceptance of that exact attachment;
- the prompt manifest's exact bundle name and digest; and
- that the first task prompt was not submitted before bundle acceptance.

The first provider response must then prove behavioral receipt by returning a schema-valid envelope with the exact `runId`, `turn`, and `nonce`. When the approved task requires more instructions or evidence, the response must expose them through:

- `skillLoads` for the relevant installed Skill;
- a bounded Bash/process tool call for local project inspection; and
- a call to the configured real MCP tool for the required external fact.

Tokenless verifies visible delivery and correlated protocol behavior. It does not scrape or claim access to a provider's hidden system prompt.

Exit: the first response is measured for savings and is either a valid complete `action_batch` containing the genuinely required requests or a valid final result that satisfies the frozen task without them. A task selected specifically to require Skill, Bash, and MCP fails this Harness case if those needs are silently ignored.

### Round 6: Execute, Continue, and Finish

- Resolve and visibly deliver all successfully requested `SKILL.md` files before the next prompt.
- Execute the approved bounded Bash/process call against the real project.
- Execute the approved call against the configured real MCP server without mocks.
- Return one ordered aggregate result to the same provider conversation.
- Accept another action batch only when prior results reveal a genuinely new dependency.
- Continue until the provider returns a schema-valid final result or the run reaches an explicit waiting or terminal failure state.

Verify that every visible provider response in the loop creates one savings event, no response is counted twice, and the run's saved-token total equals the sum of its measured turns.

Exit: each eligible provider either completes the real task with grounded evidence or reports the exact failed/waiting boundary; tool requests, results, continuation, final output, and savings remain correlated to one run.

## Evidence Record

The coordinator produces two compact tables from the round records.

### Savings Matrix

| Field | Meaning |
| --- | --- |
| Adoption path | Full replacement API, Tokenless sub-agent, or Skill + CLI |
| Provider | Exact enabled provider assigned to the worker |
| Prompt revision | Approved prompt SHA-256 |
| Outcome | Passed, failed, waiting, or declared known issue |
| Responses | Number of real visible responses measured |
| Visible characters | Sum of normalized visible response characters |
| Estimated tokens saved | Sum of the response-level `o200k_base` estimates |
| Estimator revision | Exact tokenizer basis and version |
| Evidence identity | Run, job, response request, conversation, profile, and date |

Totals may be shown per provider, per adoption path, and for the complete successful matrix. Failed and unrun rows never receive projected token values.

### Harness Matrix

| Field | Meaning |
| --- | --- |
| Provider eligibility | Required Harness capabilities present or exact unavailable reason |
| Context | Accepted and omitted file, roadmap, instruction, and GitHub-link sources |
| System Prompt Bundle | Digest, visible acceptance, and manifest correlation |
| First response | Valid `action_batch` or `final`, with exact run/turn/nonce |
| Skill | Requested, delivered, omitted, and used revisions |
| Bash/process | Proposed call, authorization, execution, and bounded result |
| MCP | Real server/tool identity, authorization, execution, and bounded result |
| Continuation | Aggregate result delivery and same-conversation next turn |
| Final | Grounded outcome, artifacts/citations when applicable, or exact blocker |
| Savings | Per-turn estimates and summed Harness-run total |

Reports contain no screenshots, full DOM, browser storage, credentials, hidden headers, hidden prompts, or unrelated account content.

## Documentation Deliverables

1. Keep this round-by-round procedure as the source of truth for the P1 test initiative.
2. Add a compact three-path summary to both product READMEs after the first matrix has real results.
3. Publish aligned English and Simplified Chinese evidence pages containing the savings and Harness matrices.
4. Link every published number to its dated local real-run report and label incomplete provider coverage.
5. Preserve prior runs as dated evidence instead of silently replacing their values.

## Out of Scope

- Official-agent before-and-after baselines or net-token-reduction telemetry.
- Invented prompts, synthetic project fixtures, provider DOM fixtures, route interception, or simulated responses.
- Automatically enabling providers, logging users in, solving CAPTCHAs, approving Keychain prompts, or changing the configured default profile.
- Assuming every provider supports files, native Projects, Skills, Bash/process tools, MCP, citations, or Harness execution merely because it supports a savings prompt.
- A new generalized test scheduler, analytics platform, or benchmark service before the manual provider-worker matrix proves the flow.
- A fourth adoption path based on deep agent-specific request-rerouting hooks.

## Acceptance Criteria

- One user-approved real-project prompt revision drives the complete `3 × enabledProviders` savings matrix.
- The provider set comes only from the default production profile resolved through `TOKENLESS_TEST_HOME`, and the report shows disabled providers explicitly.
- One provider worker owns each enabled provider, uses an explicit provider constraint, and cannot silently fall through to another provider.
- Every enabled provider is attempted in every adoption path without internal retry or silent skip.
- Every real response uses the existing output-savings event and `o200k_base` estimator; the current savings mechanism is not replaced.
- Providers with prompt-only capability retain valid savings coverage even when the Harness extension is unavailable.
- Every Harness-eligible provider receives the approved project files, roadmaps, repository instructions, GitHub links, and exact System Prompt Bundle with attributable delivery evidence.
- The Harness test proves correlated `skillLoads`, bounded Bash/process, and real MCP requests when the approved task genuinely requires them, then returns aggregate results through the same conversation.
- Every visible response turn in the Harness loop is counted once and the run total equals the sum of its response events.
- Evidence distinguishes pass, failure, waiting, known issue, disabled, and Harness-unavailable states without projected savings.
