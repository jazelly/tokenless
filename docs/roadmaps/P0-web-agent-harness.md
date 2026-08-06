# Web Agent Harness

Status: proposed | Priority: P0 | First provider: ChatGPT | First harness capability: Caller-Selected Skill Injection

Depends on: the typed visible-provider capability seam, durable daemon jobs and conversation lanes, the Context Envelope contract, and real ChatGPT Project, instruction, upload, and continuation evidence

Related: [Agent Session Integrations](P1-agent-session-integrations.md) owns the caller-facing local MCP server, exact caller-session/turn binding, and Agent adapters that transmit Skill selections; this roadmap owns resolving those selections, injecting `SKILL.md`, and executing MCP tool calls proposed by the web model

Packaging direction: one independently buildable workspace package as the implementation owner, exposed through authenticated daemon HTTP and CLI in the same first usable slice; separate Harness project only after the provider-turn interface and real agent loop are stable

## Outcome

Tokenless treats visible AI websites as model providers, not as the agent harness itself. A caller can start one durable agent run whose model turns happen through a real provider website while the harness owns caller-selected skill resolution, instruction delivery, tool discovery, authorization, execution, result return, loop limits, recovery, and the final run result.

The current repository remains the Web Provider API project. It converts evidence-backed visible website workflows into durable, provider-neutral jobs and results. Today's CLI, daemon, capability, and planned P1 integration interfaces are different ways to call that same Web Provider layer; they do not add an agent loop. The new harness is not another provider capability implementation. It begins as a separate package built specifically on top of the Web Provider interface.

The first complete path is ChatGPT because it is the current strategic target for persistent Projects, instructions, files, exact conversation continuation, and tool-loop instruction following. This is a sequencing decision, not a permanent claim that other providers cannot support agent runs.

Web turns are materially slower and more expensive than local tool execution. The Harness therefore optimizes for fewer provider round trips rather than imitating an API-native one-tool-call-at-a-time loop. Every non-final web response must describe one complete current action batch: all executable actions the model can determine now, plus all user inputs or other prerequisites it already knows are missing. It cannot defer an independent known action or ask for one known missing item at a time.

V1 proves caller-selected skill delivery and one bounded batch-control loop before adding general filesystem or MCP authority:

1. accept one `AgentRunSpec` through the package interface, authenticated daemon HTTP interface, or CLI, including the current caller turn and an ordered set of Skill selections made explicitly by the user or automatically by the caller Agent;
2. resolve only those selected Skills inside explicitly approved roots, validate and freeze their exact `SKILL.md` revisions, and reject ambiguous or unavailable selections before a provider mutation;
3. create or resolve an exact ChatGPT Project and a fresh conversation;
4. inject every selected `SKILL.md` body with the versioned Harness instructions, user goal, available tool catalog, and batch-completeness contract before the first task turn;
5. parse either a schema-valid `action_batch` containing all currently known calls and consolidated missing-input requests, or a schema-valid final result;
6. validate and persist the whole batch, collect every required local user decision in one request, and return one ordered aggregate result to the exact same conversation; and
7. repeat only when results reveal a genuinely new dependency, until ChatGPT returns a schema-valid final result or the run reaches a waiting or terminal state.

This first slice deliberately has no Skill resource read, Skill asset upload, Skill script execution, workspace write, arbitrary file read, process execution, network tool, or MCP server. It proves the hard web-specific parts—caller-to-run context handoff, high-payload `SKILL.md` instruction delivery, complete-batch output framing, correlation, validation, consolidated user input, aggregate result return, continuation, and durable looping. Filesystem and MCP then enter through the same batched tool-runtime seam instead of creating separate agent loops.

## User-Visible Batch Stories

| User input | Expected Harness behavior | User-visible result |
| --- | --- | --- |
| The user explicitly selects two Skills in the caller Agent | The caller passes both selections to Tokenless; the Harness injects both complete `SKILL.md` revisions before the first task turn | The web model can use both Skills immediately; there is no web-side Skill-selection round trip |
| The caller Agent automatically selects three Skills from its current interaction | The caller adapter sends all three selected identities and their selection provenance in the initial run request | All three `SKILL.md` bodies are present in the first web prompt; the Harness does not guess or ask the web model to select again |
| The caller supplies no Skill selection | Start the run without scanning or advertising unrelated Skills to the web model | The task runs without Skill instructions; selection is never inferred from the web model's answer |
| “Compare these three project files” | Return all three independent reads in one action batch and execute them concurrently when safe | One reading phase, one aggregate result submission, then the answer |
| The task is missing audience, jurisdiction, and output language | Return all three missing-input items together | The user receives one form or question list and answers once |
| A batch contains two safe reads and one write | Run the reads, show the write in the same consolidated review, and preserve a decision for each call | The user reviews all known work at once; denied calls are reported alongside successful calls |
| A Google Drive MCP call needs login while a GitHub read is ready | Persist both calls, finish the GitHub read, pause the Drive call for local login, then resume its exact arguments | The user logs in once; the model does not repeat or change the Drive request; both outcomes return together |
| One later action needs an id produced by an earlier call | Execute the known call first and return its result | A second action batch is allowed because the later arguments were genuinely unknowable, not merely deferred |

The user may inspect batch progress and individual outcomes, but the default experience emphasizes the task result rather than raw MCP or filesystem protocol details.

## AI Turn Versus Agent Run

A normal AI turn is one request followed by one generated response. It may use provider-native features, but Tokenless treats the completed provider response as the output.

An agent run adds a host-controlled loop around those turns:

```text
goal
  -> model turn
  -> validate complete action batch
  -> collect consolidated approval, auth, or user input
  -> execute every ready action
  -> append one aggregate result
  -> next model turn
  -> final result
```

The model proposes the complete set of actions and missing inputs it can currently identify. The harness decides whether the batch is valid and authorized, persists it, executes ready actions outside the provider page, pauses and resumes exact blocked actions without replanning, and controls whether another expensive provider turn is justified. Agency therefore belongs to the Tokenless harness even when ChatGPT supplies the planning and text generation.

Provider-native Agent, Research, apps, connectors, or other modes remain visible provider capabilities. They are not silently treated as Tokenless tool executions and do not bypass local policy.

## Two-Layer Architecture

```mermaid
flowchart TB
  Caller["Caller"]
  SkillSelection["Caller-selected Skill identities<br/>explicit user or caller Agent"]
  Skills["Approved Skill roots<br/>SKILL.md only in V1"]
  Harness["Layer 2: Web Agent Harness<br/>batched model-output execution loop"]
  Tools["Harness tool runtime<br/>batched filesystem + MCP execution"]
  Files["Approved workspace roots"]
  MCP["Configured MCP servers"]
  Provider["Layer 1: Web Provider API<br/>Projects + files + conversations + turns"]
  Playwright["Playwright provider adapters"]
  Websites["Visible AI provider websites"]

  Caller --> Harness
  Caller --> SkillSelection
  SkillSelection --> Harness
  Skills --> Harness
  Harness <--> Tools
  Tools <--> Files
  Tools <--> MCP
  Harness <--> Provider
  Provider <--> Playwright
  Playwright <--> Websites
```

The seam is deliberately above DOM operations. The harness never receives a Playwright `Page`, selector, browser profile path, provider credential, or raw provider action menu. The provider runtime never receives an MCP client, tool approval policy, or agent-loop state.

Authorization, local tools, MCP clients, instruction compilation, and loop persistence are internal modules of Layer 2. They are not additional product layers.

## The Two Modules and Eventual Projects

The intended end state contains two independently useful projects:

| Module and eventual project | Owns | Does not own |
| --- | --- | --- |
| Web Provider API | Playwright provider adapters, managed browser execution, Projects, files, conversations, visible model controls, durable provider turns, routing, scheduling, scaling, evidence, and the versioned Web Provider interface | Skill injection, MCP tool execution, approvals, or an agent loop |
| Web Agent Harness | Agent runs, caller-selected Skill resolution, web-specific high-payload instruction delivery, complete action batches, bounded filesystem tools, MCP tool execution, consolidated approvals and input, aggregate results, output validation, loop policy, and harness-owned run state | Caller-Agent Skill selection policy, provider DOM, browser profiles, selectors, credentials, or direct Playwright operations |

The repository is not split while both interfaces are still moving. The delivery sequence is:

1. keep the existing Web Provider API implementation in this repository;
2. add the harness as an independently buildable workspace package, provisionally `packages/web-agent-harness/`;
3. make that package depend only on a versioned provider-turn client and shared wire schemas;
4. prove complete caller-selected `SKILL.md` injection, then the first external-tool loop, and stabilize the cross-package interface; and
5. extract the harness package into its own project only when doing so is a mechanical repository move rather than an architectural rewrite.

No external package scope, registry namespace, or final package name is assumed by this roadmap. Those names require separate ownership verification before publication.

### Package Dependency Rule

The allowed dependency direction is:

```text
web-agent-harness package
  -> provider-turn client + versioned wire schemas
  -> authenticated daemon HTTP interface
  -> Web Provider API implementation
  -> Playwright and visible provider website
```

The harness package must not import from provider adapters, Playwright, daemon job-store implementation, profile management, DOM locators, or CLI command modules. The Web Provider API implementation must not import harness prompt, MCP, skill, approval, or loop modules.

The provider-turn client is an adapter over the durable daemon interface, not a wrapper that exposes internal classes. Opaque provider job, workspace, conversation, and evidence identifiers cross the seam; database handles, tables, browser objects, and internal state-machine values do not.

The harness owns its AgentRun persistence schema and migrations behind its own module. It may initially be hosted in the same installation or process topology, but the Web Provider implementation never reads harness tables and the harness never reads provider tables. Correlation happens through public opaque identifiers.

### Initial Package Shape

The first implementation belongs at `packages/web-agent-harness/`. That location makes the dependency rule mechanically enforceable while both sides of the Provider interface are still changing. It is not a claim on an external package name or a commitment to keep the Harness in this repository permanently.

```text
packages/web-agent-harness/
  package.json
  src/
    index.ts                  # the only public package surface
    harness.ts                # durable run entry points
    internal/
      control/                # visible envelope schemas, framing, and validation
      instructions/           # precedence, provenance, budgets, and rendering
      skills/                 # caller selection resolution, SKILL.md validation, and injection
      tools/                  # registry, policy, execution, and bounded outcomes
        filesystem/           # rooted read, search, patch, and artifact materialization
        mcp/                  # MCP tool execution, authentication, and resume
      artifacts/              # content-addressed results and provider artifacts
      persistence/            # harness-owned AgentRun records and migrations
```

Only `src/index.ts` is an exported package path. Internal directories express ownership and locality, not public extension points. The public Harness interface remains small:

```ts
interface WebAgentHarness {
  start(spec: AgentRunSpec): Promise<AgentRunRef>
  read(ref: AgentRunRef): Promise<AgentRunState>
  resume(ref: AgentRunRef, input?: AgentRunIntervention): Promise<AgentRunState>
  cancel(ref: AgentRunRef): Promise<AgentRunState>
}
```

Selected Skills are part of `AgentRunSpec`; they are not tool calls. Callers do not invoke `readFile`, `writeFile`, or `callMcpTool` directly through this interface. Those operations originate in validated web-model action batches handled inside one run.

### Entry Points: One Module, Three Access Paths

Package, daemon HTTP, and CLI are all required in the first usable Harness slice. They are not competing implementations or separate behavior owners:

| Access path | Role | Required behavior |
| --- | --- | --- |
| Package interface | Canonical in-process Harness interface and implementation seam | Own `start`, `read`, `resume`, and `cancel`, validation, persistence, Skill injection, batching, and final results |
| Authenticated daemon HTTP | Durable process interface over the same Harness module | Expose the same run lifecycle and schemas without leaking package internals or daemon storage |
| CLI | Human, scripting, diagnostics, and recovery adapter | Submit the same `AgentRunSpec`, including selected Skills and caller-turn context, then read or resume the same durable run through the daemon client |

The CLI must not implement a second instruction compiler, Skill resolver, validation loop, or state machine. In-process callers may use the package interface directly; normal local CLI and future caller adapters use the authenticated daemon interface. The same request must produce the same durable run semantics through every access path.

### Web-Harness Specificity

This is not a generic model-API harness with a Web Provider adapter added afterward. Its loop is designed around the actual Web Provider interface:

- model output arrives as a slow, complete visible webpage response rather than a native function-call event stream, so the Harness contract maximizes useful work per turn;
- caller-selected `SKILL.md` instructions and the MCP calling contract must be injected through proven Project instructions, files, or a visible conversation bootstrap;
- the current tool catalog and per-turn nonce must fit provider message and file limits;
- every currently executable filesystem and MCP request plus every known missing input must be parsed from one complete action batch;
- locally independent actions execute without additional provider turns, and their ordered aggregate results return as one next message in the exact same provider conversation;
- Projects, attachments, citations, provider blockers, slow turns, and conversation recovery remain part of the loop; and
- each provider becomes harness-capable only after its complete real website loop is proven.

The harness is therefore Web-Provider-aware but DOM-agnostic. It understands Web Provider semantics and limitations while all selectors, clicks, browser profiles, and provider-specific visible operations remain below the Web Provider interface.

### Extractability Tests

The package shape is correct when all of these deletion and replacement checks hold:

- deleting the harness package leaves current CLI and daemon provider jobs working;
- running the Web Provider API project without the harness does not load MCP clients, skills, or agent-loop state;
- changing Playwright or provider-adapter implementation behind the Web Provider interface does not change harness code;
- moving the harness package to another repository requires dependency and release wiring, not source reorganization; and
- provider and harness release versions can advance independently under explicit protocol compatibility rules.

## Layer 1: Web Provider API

The existing provider architecture becomes a deep model-turn module. Its interface exposes provider outcomes rather than general browser automation.

All currently exposed operations belong to this layer: they are structured wrappers around supported, real-E2E-verified web workflows. P1 may expose those operations through MCP and bind them to an external session, but that still does not make P1 an Agent Harness.

The provider runtime owns:

- resolving the exact provider, managed profile, native Project or conversation workspace, and conversation;
- visibly creating, selecting, and verifying Projects and conversations;
- delivering approved instructions and files through provider-supported visible controls;
- applying provider-owned model, effort, mode, and attachment strategies;
- submitting one correlated message and waiting for one complete response;
- reading bounded response text, citations, artifacts, and visible completion evidence;
- continuing the exact conversation on the next harness turn; and
- classifying authentication, CAPTCHA, plan, availability, navigation, and selector blockers.

The conceptual external interface stays small and preserves the provider runtime's asynchronous job semantics:

```ts
type ProviderTurnRequest = {
  route: CapabilityRoute
  workspace: ProviderWorkspaceRef
  conversation: ProviderConversationIntent
  instructions: InstructionDeliveryPlan
  message: AgentMessage
  attachments: ContextArtifactRef[]
  correlation: TurnCorrelation
}

type ProviderTurnRef = {
  jobId: string
}

type ProviderTurnState =
  | { status: 'queued' | 'running' | 'waiting_for_user' }
  | { status: 'succeeded'; result: VisibleProviderResponse }
  | { status: 'failed' | 'cancelled'; error: ProviderTurnError }

interface ProviderTurnClient {
  submit(request: ProviderTurnRequest): Promise<ProviderTurnRef>
  read(ref: ProviderTurnRef): Promise<ProviderTurnState>
  resume(ref: ProviderTurnRef): Promise<ProviderTurnState>
  cancel(ref: ProviderTurnRef): Promise<ProviderTurnState>
}
```

This is a design target, not a commitment to those exact TypeScript names. The important constraint is that callers ask for one verified provider turn and do not orchestrate individual clicks.

Raw visible actions remain internal interfaces used by provider adapters. They are not part of the public Web Provider interface, are not MCP tools, and are not made available to the web model.

The provider runtime does not own:

- agent instructions or skill precedence;
- tool discovery, schema projection, or tool-call parsing;
- approval, filesystem, network, or side-effect policy;
- MCP server processes, credentials, or protocol sessions;
- loop termination, turn budgets, or final agent-run semantics; or
- automatic application of provider-generated artifacts to the local project.

## Layer 2: Web Agent Harness

The harness is a deep module at the caller-to-model seam. Its external interface accepts one `AgentRunSpec` and returns a durable run handle or terminal `AgentRunResult`.

An `AgentRunSpec` contains:

- the user goal and optional structured output requirement;
- an exact caller/session/project/turn binding and bounded caller-turn context when available;
- a Context Envelope and selected attachments;
- approved Skill roots and access rules plus an ordered `SkillSelection[]` supplied by the caller, with each selection attributed to `explicit_user` or `caller_agent`;
- an explicit tool-set reference, not an ambient global tool dump;
- approval policy and local resource scopes;
- provider/profile constraints and required provider capabilities; and
- hard limits for provider turns, action batches, calls per batch, total calls, consolidated user-input items, wall time, input and output bytes, and parallelism.

The conceptual caller-supplied selection is deliberately small:

```json
{
  "selectedSkills": [
    {
      "name": "legal-writing",
      "selectedBy": "explicit_user",
      "expectedRevision": "sha256:optional"
    },
    {
      "name": "pdf-processing",
      "selectedBy": "caller_agent"
    }
  ]
}
```

`name` resolves only within the run's approved Skill roots; an optional logical root identity may disambiguate names without accepting an arbitrary path. `expectedRevision`, when present, must match the locally resolved `SKILL.md`. The request never embeds the Skill body. Every accepted selection—especially one explicitly named by the user—must be compiled into the initial instruction payload before the first web task turn.

The harness implementation owns:

- compiling instruction layers with explicit precedence and provenance;
- resolving only caller-selected Skills against approved roots, validating their `SKILL.md` files, and freezing the ordered exact revisions for the run;
- freezing a bounded tool-catalog snapshot for the run;
- creating a fresh provider conversation for each new run;
- driving provider turns through the provider runtime interface;
- parsing and validating complete action batches and the requested final-output contract;
- authorizing and dispatching validated batches without asking the model to re-emit blocked calls;
- consolidating local approvals, authentication handoffs, and user-input requests;
- delimiting, truncating, storing, and returning one aggregate result per completed batch;
- persisting checkpoints before every external mutation;
- stopping on final, denial, limit, cancellation, ambiguity, or unrecoverable failure; and
- returning final text, artifacts, citations, provider identity, and a bounded audit trail without private reasoning.

The harness does not know provider selectors, daemon internals, or MCP transport internals. It depends on the provider-turn client and tool-runtime interfaces.

## Provider Eligibility for Agent Runs

Normal chat support does not imply agent-harness support. The runtime catalog should distinguish at least:

| Level | Minimum proven behavior |
| --- | --- |
| `qa` | Submit one prompt and return one correlated complete response |
| `continuable` | Reopen and continue the exact durable conversation without identity ambiguity |
| `harness_agent` | Deliver the required instruction fidelity, follow the control protocol, complete tool-result round trips, and reach a bounded final result through real browser E2E |

An `agent.run` route requires every capability needed by that run, including normal chat, exact continuation, the selected instruction-delivery mode, attachments or native workspace when requested, and a real-E2E-closed harness protocol route.

ChatGPT is the only initial `harness_agent` candidate. Claude, Gemini, Grok, Qwen, DeepSeek, and future providers remain `qa` or `continuable` until the same real-boundary criteria close independently. Similar UI labels or one successful demonstration do not establish parity.

Once the first provider turn mutates a conversation, the run is pinned to that provider, profile, workspace, conversation, instruction revision, and tool-catalog revision. Mid-run provider fallback is not allowed because model state, tool decisions, and prior mutations are not portable.

## Instruction Delivery, Not Hidden Prompt Injection

Tokenless must not claim a native `system` role when a provider website does not expose one. It records the actual visible delivery method:

| Fidelity | Meaning |
| --- | --- |
| `project_instruction` | Versioned harness instructions are installed in a Tokenless-owned Project or merged into another Project with explicit approval and visible verification |
| `conversation_bootstrap` | Instructions are delivered as a visible first conversation message and verified through the resulting conversation |
| `unsupported` | The required instruction semantics cannot be delivered or verified safely |

Project instructions are preferred for the stable Harness contract when the exact Project is Tokenless-owned or the user explicitly approved the update. Tokenless never overwrites unrelated user instructions. Stable Harness behavior, including the complete-batch requirement, belongs in a versioned Project instruction or equivalent durable instruction surface. Dynamic task context, caller-selected Skill revisions, tool schemas, run nonce, and limits belong in the fresh conversation bootstrap so Project instructions do not churn on every run.

Instruction compilation uses this precedence:

1. immutable Tokenless safety and control-protocol contract;
2. explicit user and organization policy;
3. caller-selected Skill instructions in the order frozen by the run request;
4. tool catalog and per-tool usage guidance;
5. task goal and Context Envelope; and
6. prior filesystem, MCP, and other external tool results, which are always marked as untrusted data.

Lower layers cannot grant permissions, add tools, or rewrite higher-layer policy. Instructions are source-attributed and content-addressed. A run stores the exact instruction revision that was visibly delivered.

### Web-Turn Payload Policy

The Harness optimizes provider turns before optimizing prompt bytes. Each task turn should contain enough bounded information for the model to make every decision that does not depend on an unknown future tool result:

- inject the complete bodies of every caller-selected `SKILL.md` before the first task turn;
- do not advertise an ambient Skill catalog or ask the web model to select additional Skills in V1;
- include the complete selected tool schemas, effects, and usage guidance when they fit the run budget; never advertise a tool that the Harness cannot validate and dispatch;
- include every result from the preceding batch in one ordered aggregate provider turn; when bounded text does not fit comfortably in the message, attach one or more indexed, content-addressed result artifacts in that same turn and include their manifest in the prompt;
- include every locally collected answer, denial, authentication completion, and approval outcome together when resuming the model.

This is not a requirement to predict unknowable later work. If the arguments for action B depend on the unknown result of action A, B belongs in the next batch. If A and B are both already well-defined, returning only A violates the Harness contract and triggers the bounded repair path.

## Visible Web-Agent Control Protocol

Tokenless's visible-site interface does not receive the native function-call events available through model APIs, and it does not inspect private provider traffic to obtain them. V1 therefore uses one explicit visible text protocol optimized around slow provider turns. Every complete model response must contain exactly one envelope of one of these kinds:

- `action_batch`: all actions whose arguments are currently known plus all known missing user inputs; or
- `final`: the final Markdown or structured result and declared artifacts.

An `action_batch` may contain many filesystem, registered-local, and MCP calls. It may also contain many missing-input items. Skill selection and injection happen before the first web turn and are not represented as tool calls. At least one list must be non-empty. The model must not use empty batches, prose promises, or serial one-call responses to defer work it can already specify.

The conceptual envelope is:

```json
{
  "protocol": "tokenless.web-agent/v1",
  "kind": "action_batch",
  "runId": "run_opaque",
  "turn": 2,
  "nonce": "per_turn_opaque_nonce",
  "calls": [
    {
      "id": "call_file_a",
      "tool": "fs.read_text",
      "arguments": {
        "path": "docs/a.md"
      }
    },
    {
      "id": "call_file_b",
      "tool": "fs.read_text",
      "arguments": {
        "path": "docs/b.md"
      }
    }
  ],
  "needs": [
    {
      "id": "need_jurisdiction",
      "kind": "user_input",
      "prompt": "Which jurisdiction applies?",
      "inputSchema": {
        "type": "string",
        "minLength": 2,
        "maxLength": 120
      }
    }
  ]
}
```

The actual framing must be unambiguous in rendered page text and survive provider Markdown rendering. The parser accepts only the declared protocol version, current run and turn, current nonce, unique call and need ids, registered tool names, arguments valid against the frozen JSON Schema, supported missing-input kinds, bounded user-facing prompts, and optional acyclic `dependsOn` references between calls.

The nonce detects stale or replayed envelopes; it is not authorization. Valid model output is still untrusted input.

The Harness validates and persists the entire batch before dispatching any call. One unknown tool, invalid argument, duplicate id, impossible dependency, or malformed need rejects the whole batch, preventing partial execution followed by an ambiguous repair. Malformed output receives at most one bounded protocol-repair turn containing all validation errors but no new authority. A second malformed response fails the run.

After validation, the Harness executes every ready call, concurrently only where local policy proves that safe. It consolidates model-requested user inputs with Harness-discovered approvals, authentication handoffs, and elicitations into one local interaction. A blocked call keeps its exact validated arguments and resumes after the local requirement is satisfied; the model does not regenerate it. Independent calls may finish while another waits, but the Harness sends no provider continuation until the batch has a stable outcome for every call and need.

The aggregate result uses versioned framing, preserves every original call and need id, and reports a stable outcome for each item. Filesystem, MCP, and other external tool results are delimited as untrusted data. Large or binary results are stored as local artifacts and represented by bounded metadata or approved excerpts. No result can modify the frozen catalog, higher-priority instruction layers, or authorization policy.

The Harness-to-model continuation is one `action_batch_result`, conceptually:

```json
{
  "protocol": "tokenless.web-agent/v1",
  "kind": "action_batch_result",
  "runId": "run_opaque",
  "batchId": "batch_opaque",
  "callResults": [
    {
      "id": "call_github_read",
      "status": "succeeded",
      "content": "bounded untrusted result"
    },
    {
      "id": "call_drive_create",
      "status": "succeeded",
      "artifact": {
        "id": "artifact_opaque",
        "mediaType": "application/vnd.google-apps.document",
        "digest": "sha256:opaque"
      }
    }
  ],
  "needResults": [
    {
      "id": "need_jurisdiction",
      "status": "answered",
      "value": "South Australia"
    }
  ]
}
```

This envelope is input compiled by the Harness, not model output and not an authorization surface. It is sent only after every call and need in the original batch is stable: calls are `succeeded`, `denied`, `failed`, or `cancelled`, and needs are answered, denied, or cancelled. Authentication completion is reported without credentials. If the bounded inline representation is too large, the same continuation contains an ordered artifact manifest instead of splitting the batch across provider turns.

Batch completeness is partly a model behavior rather than something a JSON validator can prove. A provider becomes `harness_agent` eligible only when real-browser acceptance shows that it reliably groups multiple independent actions and missing inputs instead of forcing avoidable provider turns.

### Model Output Validation Pipeline

Validation is a staged gate. No tool dispatch, file mutation, approval request, or terminal success occurs until every applicable stage passes:

1. **Framing:** extract exactly one bounded control envelope from the complete correlated visible response; reject missing, duplicate, nested, or trailing executable envelopes.
2. **Syntax:** parse strict JSON with duplicate-key rejection plus configured depth, property-count, string, and byte limits; never evaluate code or repair JSON locally.
3. **Schema:** validate the declared protocol version and exact `action_batch` or `final` shape against canonical JSON Schema.
4. **Correlation:** require the current run id, turn number, nonce, unique call and need ids, valid dependency references, and a response belonging to the exact provider conversation.
5. **Capability:** for `action_batch`, require every canonical tool name and argument to match the frozen catalog and input schema and every missing-input item to use an allowed kind and schema; for `final`, require every declared artifact to resolve to a provider result or Harness artifact already owned by this run.
6. **Authority:** evaluate the complete valid batch against local policy and current resource state before dispatch, then bind every approval to its exact call. Schema validity and model assertions never imply permission.
7. **Output contract:** validate the terminal value as bounded Markdown by default or against the caller's frozen JSON Schema when structured output was requested. Reject undeclared files, unknown artifact ids, media-type or digest mismatches, and output that exceeds the run budget.

Protocol errors return one bounded repair turn with machine-readable validation issues and the same authority. A repair cannot add a tool, change a root, relax a schema, or increase a limit. A second invalid response fails clearly.

Provider-native generated images, files, citations, and other multimodal results remain Layer 1 result artifacts. The Harness may correlate and return those artifact references after validation. It never treats assistant prose such as “I wrote `x.png`” as filesystem evidence, and it materializes an artifact into the local workspace only through an explicit authorized filesystem tool call.

## Durable Agent Loop

```mermaid
stateDiagram-v2
  [*] --> preparing
  preparing --> awaiting_provider
  awaiting_provider --> validating_response
  validating_response --> awaiting_local_input: consolidated needs or approvals
  validating_response --> executing_batch: complete batch locally allowed
  validating_response --> succeeded: valid final envelope
  validating_response --> repairing_protocol: invalid envelope
  repairing_protocol --> awaiting_provider
  awaiting_local_input --> executing_batch: answers and decisions recorded
  awaiting_local_input --> aggregating_batch: all remaining calls denied
  executing_batch --> waiting_for_batch_user: tool auth, elicitation, or ambiguity
  waiting_for_batch_user --> executing_batch: resume exact persisted call
  executing_batch --> aggregating_batch: every batch item stable
  aggregating_batch --> awaiting_provider: one aggregate result
  preparing --> waiting_for_provider_user: provider or setup blocker
  awaiting_provider --> waiting_for_provider_user: provider auth, CAPTCHA, consent, or ambiguity
  waiting_for_provider_user --> preparing: explicitly resumed
  preparing --> failed
  validating_response --> failed
  executing_batch --> failed
  awaiting_provider --> cancelled
  awaiting_local_input --> cancelled
  executing_batch --> cancelled
  succeeded --> [*]
  failed --> [*]
  cancelled --> [*]
```

Hard limits are correctness controls, not optional tuning. V1 has finite defaults for provider turns, action batches, total calls, calls per batch, missing-input items, aggregate-result bytes, wall time, and local-intervention wait. Repeating the same invalid or denied call consumes the budget and eventually terminates clearly.

All ready read-only calls in one batch may execute concurrently only when their locally verified policy, dependency graph, and resource scopes do not conflict. Mutating calls execute serially by default. The model may describe dependencies but cannot increase concurrency or weaken ordering chosen by the Harness.

## Tool Runtime

The tool runtime is an internal deep module with concrete adapter families for bounded filesystem operations, MCP tools, and any later explicitly registered local tools. Skills do not enter this runtime because V1 Skill activation is instruction compilation, not execution. The runtime's one execution interface accepts a fully validated call batch plus execution context and returns one bounded batch outcome. Adapter-specific lifecycle, transport, authentication, path handling, per-call execution, and result conversion stay behind that seam.

```ts
interface ToolRuntime {
  executeBatch(batch: ValidatedCallBatch, context: BatchExecutionContext): Promise<ToolBatchOutcome>
}
```

Every tool descriptor records:

- a stable, collision-free canonical name;
- source kind and exact server or local adapter identity;
- input and optional output JSON Schemas;
- locally assigned read/write, network, destructive, and credential effects;
- allowed filesystem roots, network destinations, or resource scopes;
- timeout, result-size, and concurrency limits;
- idempotency, resumability, and cancellation behavior; and
- provenance for descriptions and annotations.

Tool descriptions help the model choose a tool. They do not grant authority. MCP annotations are treated as untrusted unless local configuration explicitly trusts that server and independently constrains the tool.

### Distinct MCP Roles

Tokenless uses MCP in two separate roles, named by behavior rather than by network direction:

| Role | Tokenless behavior | Owner |
| --- | --- | --- |
| Caller MCP interface | Tokenless is an MCP server exposing run creation, job reads, resume, and cancel to Codex or another caller | [Agent Session Integrations](P1-agent-session-integrations.md) |
| MCP tool execution | The Harness is an MCP host/client executing calls that came from a validated web-model action batch | This roadmap |

These roles share durable run identity and policy types but not transport sessions, credentials, tools, or approval decisions. Invoking Tokenless through its caller MCP interface never grants authority to execute a web-model-proposed MCP call.

### MCP Tool Execution, Authentication, and Resume

The first MCP phase supports explicitly configured local `stdio` servers through the official MCP TypeScript SDK v2, with an explicit legacy, pinned modern `2026-07-28`, or opt-in auto-negotiation mode:

- Tokenless launches each server with a minimal allowlisted environment and an explicit working directory;
- each server receives one isolated MCP client and transport binding;
- modern discovery or the configured legacy initialization and capability negotiation must complete before its tools enter the catalog;
- `tools/list` is snapshotted and namespaced by a stable local server alias;
- `tools/call` arguments and structured results are schema-validated and size-bounded;
- server stderr is bounded diagnostic data and never becomes model context automatically;
- deprecated MCP Roots are not used as an access-control mechanism; local resource scope is enforced by Harness policy and the concrete tool adapter;
- server-initiated sampling is disabled in the first MCP phase to prevent a recursive model loop; and
- elicitation becomes `waiting_for_user`; the web model never supplies credentials or sensitive answers on the user's behalf.

Every MCP invocation originates in a validated and durably persisted web-model action batch. If execution discovers that a configured server or external account requires login, the Harness retains the exact server, tool, arguments, call id, dependencies, and authorization decision; moves that call to `waiting_for_auth`; allows unrelated safe calls in the same batch to finish; and exposes one local login handoff. After the user completes login, the Harness resumes the same persisted call rather than asking the model to propose it again. Only after all calls in the batch have stable outcomes does it return one aggregate result to the provider conversation.

MCP prompts and resources are not automatically exposed as tools. A later phase may map selected resources into the Context Envelope and selected prompts into skill instructions with explicit provenance.

Remote Streamable HTTP is deferred until Tokenless has a concrete remote-server use case and can implement the current MCP authorization requirements, OAuth discovery, PKCE, resource/audience binding, secure token storage, consent, and origin protections without leaking credentials to the provider page.

### Filesystem Adapter

Filesystem support is a first-party adapter, not a requirement to install an MCP filesystem server. That keeps core coding behavior deterministic and lets Tokenless enforce scope before any third-party process sees a path.

The first read-only catalog is intentionally small: `fs.list`, `fs.read_text`, and `fs.search`. A later mutating catalog adds `fs.apply_patch`, `fs.write_file`, `fs.create_directory`, and `fs.materialize_artifact` only when their real-boundary approval and recovery behavior is proven. There is no generic shell command.

Every filesystem call:

- resolves from a logical workspace-relative path under one frozen run root;
- canonicalizes existing ancestors and rejects symlink or mount escapes before access;
- rejects browser profiles, Tokenless state, VCS credential stores, SSH directories, broad home-directory access, and any path outside the approved roots;
- applies per-call file-count, byte, depth, search-result, and binary-media limits;
- records the preimage identity before mutation and the resulting digest, diff, or artifact identity after completion; and
- returns bounded content or an artifact reference rather than silently placing arbitrary provider output on disk.

Writes are proposed only through a schema-valid tool call. They execute serially, require an exact approval or pre-reviewed policy rule, and fail on stale preimage rather than overwriting a concurrently changed file. A `final` response, Markdown fence, provider-generated patch, or image declaration can never write by itself.

### Registered Local Tools

Local tools use the same `ToolDescriptor`, authorization, execution, and result contracts as MCP tools. They are typed adapters over a narrow operation, not arbitrary shell text returned by the model.

Each local tool must declare exact resource scopes and side effects. Filesystem operations are rooted and symlink-safe. Process and network tools require explicit allowlists. V1 does not provide a generic unrestricted shell tool.

### Skills

A Skill is an Agent Skills-compatible instruction package, not executable authority. V1 separates selection from delivery:

1. the upstream caller decides which Skills apply to the current interaction, either because the user explicitly selected them or because the caller Agent selected them using its own interaction context;
2. the caller sends the complete ordered selection through `AgentRunSpec` over the package interface, daemon HTTP, or CLI, preserving whether each selection came from `explicit_user` or `caller_agent`;
3. the Harness resolves only those selections from the exact bound worktree conventions or explicitly configured roots, validates name, frontmatter, file size, symlink containment, compatibility, and access policy, and freezes each selected `SKILL.md` revision;
4. the Harness injects all selected `SKILL.md` bodies into the initial visible instruction payload in deterministic order; and
5. the web model receives no ambient Skill catalog and has no `skill.load` tool in V1.

The caller normally transmits Skill identities and selection provenance, not copied Skill bodies. The Harness resolves and reads the local `SKILL.md` under its own approved-root and revision checks so a caller cannot silently substitute different instruction content under a trusted Skill name.

“Automatic Skill selection” therefore means automatic selection by the caller Agent before the Tokenless invocation. It never means that the Web Harness scans installed Skills and guesses from the task, or that the slower web model spends another turn choosing them. If the caller supplies no selection, the Harness injects no Skill.

V1 reads only `SKILL.md`. It accepts the standard `name`, `description`, `license`, `compatibility`, and string-map `metadata` fields, but the experimental `allowed-tools` field and product-specific metadata never grant permission. The Harness does not read, enumerate, upload, or expose `references/`, `assets/`, or `scripts/`; it does not follow remote Skill URLs, download packages, install dependencies, or execute anything from a Skill directory. Those resource types require a later explicit, bounded, provenance-preserving attachment or tool design.

The Harness records one `SkillSelectionRevision` containing the caller provenance, resolved identity, content digest, validation outcome, and deterministic injection order for every selected Skill. It renders all accepted bodies together as source-attributed instruction layers before the first task turn, not as external tool data. This treatment can influence the web model but cannot influence local authorization.

Activating a skill may:

- add versioned instructions and examples to the instruction compiler;
- request named tools already present in the configured tool registry;
- narrow recommended usage or default limits; and
- contribute output validation or artifact-handling guidance.

A Skill cannot launch a process, add an MCP server, widen a filesystem root, approve a tool call, or bypass a higher-priority policy merely by being installed, selected, or mentioned. Missing required tools fail Skill preparation before the first provider mutation.

## Authorization and Containment

Tool arguments are proposed by an untrusted web model, even when the user trusts the provider and MCP server.

Authorization is evaluated inside Tokenless immediately before execution against the frozen run policy and the current resource state:

- read-only, locally scoped calls may be pre-authorized by explicit policy;
- local writes, network mutations, external messages, purchases, credential flows, destructive operations, and scope expansion require explicit approval unless a prior reviewed rule covers that exact operation;
- approvals bind the run id, call id, tool identity, argument digest, target scope, and expiry;
- any argument change invalidates the approval;
- denial is returned to the model as a normal structured tool result;
- headless operation never converts missing approval into approval; and
- server or model descriptions, annotations, and claims cannot downgrade the locally assigned risk.

The local web control plane should consolidate every currently known pending call and missing input into one review surface while preserving per-call decisions. It displays exact targets, dependencies, redacted sensitive fields, why each approval or login is required, the requesting provider conversation, and the effect of allow-once, deny, or cancel. CLI and caller MCP integrations may observe and resolve the same durable batch through the same application contract.

Tokenless never requests, reads, logs, or sends browser credentials, cookies, storage secrets, Keychain items, MCP OAuth tokens, or the daemon bearer token to the web model. MCP authentication occurs out of band through user-controlled flows.

## Durability, Idempotency, and Recovery

One durable `AgentRun` owns ordered child records:

- `AgentTurn` for each provider request and correlated response;
- `InstructionRevision`, `SkillSelectionRevision`, and `ToolCatalogRevision` frozen for the run;
- `ActionBatch` for each complete model proposal, including its dependency graph and validation outcome;
- `RunNeed` for every model-requested input and Harness-discovered approval, authentication, elicitation, or ambiguity;
- `SkillInjection` for each exact selected Skill revision delivered before the first task turn;
- `ToolCall` for the model proposal and validation outcome;
- `ApprovalDecision` bound to the exact call digest;
- `ToolExecution` for dispatch, completion, error, or ambiguity;
- `ActionBatchResult` containing the ordered stable outcome for every call and need returned in one provider continuation; and
- the final output-validation result, artifacts, citations, provider identity, and completion evidence.

Persist intent before every provider or tool mutation. A tool call id is unique within a run and cannot produce a second execution record accidentally.

Recovery follows explicit evidence:

- a read-only call may be repeated only when its locally declared semantics and observed state make that safe;
- a mutating call with proven non-dispatch may be retried;
- a mutating call with ambiguous dispatch waits for user resolution and is never replayed automatically;
- a completed tool result may be returned to the same provider conversation again only when the prior visible submission is proven absent;
- an ambiguous provider submission uses the existing at-most-once replay policy; and
- resume reuses the same provider conversation, instruction revision, catalog revision, limits, batch, call ids, arguments, dependencies, and already completed outcomes.

Cancellation stops future turns and requests MCP cancellation where supported. It does not claim to reverse an external side effect or guarantee that a server lacking cancellation stopped its work.

## Delivery Phases

### Phase 0: Seams, Contracts, Package, HTTP, and CLI

- Define the four-entry-point `WebAgentHarness` interface plus `AgentRunSpec`, `AgentTurnContext`, `SkillSelection`, `SkillSelectionRevision`, `AgentRun`, `AgentTurn`, `ActionBatch`, `ValidatedCallBatch`, `RunNeed`, `ActionBatchResult`, `BatchExecutionContext`, `ToolBatchOutcome`, `ProviderTurnRequest`, `ProviderTurnRef`, `ProviderTurnState`, `ProviderTurnClient`, `InstructionDeliveryPlan`, `ToolDescriptor`, `ToolCall`, `ToolOutcome`, and approval-policy schemas.
- Keep visible browser actions behind provider adapters and expose one provider-turn interface to the harness.
- Add an independently buildable harness workspace package with no imports from provider, Playwright, daemon-storage, profile, DOM, or CLI implementation modules.
- Add authenticated daemon HTTP and CLI adapters for the same four durable Harness operations and request/result schemas; do not duplicate Harness logic in either adapter.
- Add a provider-turn client adapter over the authenticated durable daemon interface and version the wire schemas it consumes.
- Give the harness ownership of its AgentRun state and migrations; correlate provider jobs only through opaque public identifiers.
- Define `qa`, `continuable`, and `harness_agent` evidence without enabling a route from product reconnaissance alone.
- Persist parent/child identity, turn intent, limits, checkpoints, dispatch certainty, and failure codes before any later tool mutation exists.
- Document the caller MCP interface and web-model-driven MCP tool-execution roles without directional terminology.

Exit: the same no-tool `AgentRunSpec` can be started, read, resumed, and cancelled through the package interface, authenticated daemon HTTP, and built CLI with one durable identity and equivalent observable behavior; today's normal ChatGPT QA flow remains unchanged when the Harness package is removed.

### Phase 1: ChatGPT Batch Instruction, Control Protocol, and Final Validation

- Create or resolve an exact ChatGPT Project and a fresh conversation per run.
- Add explicit Project-instruction merge, preview, revision, and rollback behavior without overwriting unrelated instructions.
- Implement the versioned `action_batch` and `final` envelopes, per-turn nonce, whole-batch validation before dispatch, consolidated missing-input requests, aggregate batch results, Markdown and JSON Schema final-output contracts, and one bounded repair turn.
- Freeze and report instruction and Context Envelope revisions.
- Prove exact continuation in the same conversation.

Exit: real ChatGPT returns a schema-valid final envelope, consolidates multiple known missing inputs into one `action_batch`, and can complete one bounded protocol repair through the built CLI, packaged daemon, managed profile, and visible website.

### Phase 2: Caller-Selected `SKILL.md` Injection

- Accept an ordered Skill selection from the package, daemon HTTP, and CLI request, including `explicit_user` or `caller_agent` provenance for each item.
- Resolve only the selected Agent Skills-compatible `SKILL.md` files from the bound worktree conventions and explicitly configured roots.
- Validate frontmatter, names, containment, compatibility, duplicate handling, access policy, and byte limits; content-address each accepted revision.
- Inject every selected `SKILL.md` body before the first task turn and freeze one `SkillSelectionRevision` for the run.
- Do not advertise an ambient Skill catalog, expose `skill.load`, or read, enumerate, upload, or execute `references/`, `assets/`, or `scripts/` in V1.

Exit: the same run submitted through package, authenticated daemon HTTP, and built CLI carries three caller-selected, uniquely canaried `SKILL.md` revisions into the first visible ChatGPT task turn and returns a schema-valid final result using all three canaries without a Skill-selection provider round trip. An unavailable, unauthorized, malformed, duplicate, ambiguous, or changed-after-snapshot selection fails before provider mutation, and no Skill resource or script is read.

### Phase 3: Rooted Filesystem and Approval

- Add the first-party rooted filesystem adapter with `fs.list`, `fs.read_text`, and `fs.search` before any write operation.
- Add stale-preimage-safe `fs.apply_patch`, bounded `fs.write_file`, and `fs.materialize_artifact` only after exact path, policy, approval, and journal checks pass.
- Prevent the filesystem adapter from treating a selected Skill directory as ambient workspace authority or bypassing the V1 exclusion of Skill resources and assets.
- Validate and persist each complete filesystem batch before mutation, consolidate its approvals, return one ordered set of bounded diffs and digests, and stop on ambiguous completion or concurrent file change.
- Prove denial, symlink escape, broad-root, secret-path, binary, size-limit, and cancellation behavior through the real filesystem.

Exit: ChatGPT requests at least three independent real reads in one batch, receives their results in one continuation, and produces a correlated final answer; a batch of proposed real patches is presented for one consolidated review, cannot execute before exact per-call approval, cannot escape the worktree, and is not duplicated across a process restart.

### Phase 4: MCP Tool Execution, Authentication, and Resume

- Implement the MCP host/client adapter for explicitly configured local `stdio` servers.
- Negotiate the configured protocol mode, snapshot and namespace valid tool schemas, and expose only the selected bounded tool set to ChatGPT.
- Apply the same local effects, scopes, limits, allow, deny, approval, artifact, and audit contracts as the filesystem adapter.
- Execute every ready MCP call from one validated batch, disable server sampling, treat tool annotations as untrusted, and consolidate elicitation or Multi Round-Trip input requirements as `waiting_for_user`.
- Persist an exact call when its server or external account needs login, expose one local authentication handoff, resume that same call after login, and never ask the web model to regenerate it.
- Validate skill-required MCP tool references before the first provider mutation without letting a skill add or configure a server.

Exit: one real ChatGPT run uses a caller-selected Skill and multiple real local MCP calls in one batch under one frozen policy; an unauthenticated call waits for local login and resumes with the same id and arguments, unrelated calls are not lost, all results return in one aggregate continuation, and a mutating call pauses before exact approval.

### Phase 5: Recovery and Failure Hardening

- Persist every turn, action batch, need, Skill selection and injection, call, approval, authentication handoff, execution, aggregate result, artifact, output-validation result, and evidence transition.
- Enforce turn, call, byte, wall-time, concurrency, and catalog limits across mixed skill, filesystem, and MCP runs.
- Handle unknown tools, invalid arguments, denial, timeout, server failure, provider blocker, cancellation, and ambiguous mutation.
- Resume the same run and conversation after daemon, runner, browser, or MCP process restart when evidence makes continuation safe.
- Return structured state through CLI, daemon, local control plane, and the caller MCP adapter.

Exit: focused real-process restart checks prove no duplicate provider submission, filesystem mutation, or MCP mutation, and every ambiguous external mutation stops for user resolution.

### Phase 6: Caller Integrations and Approval UX

- Add `agent.run` to the canonical caller capability catalog only after the ChatGPT route is E2E-closed.
- Extend the existing Harness CLI adapter with consolidated pending-input, approval, final-result, and audit views, and add the caller-facing local MCP adapter over the same durable operations.
- Add approval and recovery surfaces to the local web control plane without exposing the daemon bearer token to browser JavaScript.
- Bind Codex and later callers through exact `AgentSessionBinding` records from the related roadmap.

Exit: a Codex session can explicitly start a Tokenless web-agent run, resolve one consolidated set of pending inputs and tool approvals, and receive the final result in the same originating session without gaining direct browser or web-model MCP execution authority.

### Phase 7: Additional Providers and Remote MCP

- Evaluate each provider independently for instruction fidelity, exact continuation, protocol adherence, and bounded real tool loops.
- Add provider routes only after real browser E2E closes all required outcomes.
- Add authenticated Streamable HTTP MCP only with complete authorization, consent, token handling, and transport-security behavior.
- Add selected MCP resources, prompts, tasks, or tool-search behavior only after their semantics fit the same policy and durability model.

Exit: a second provider or remote MCP transport satisfies the same interface and evidence contracts without ChatGPT, transport, or provider fields leaking into the harness interface.

## Real-Boundary Verification

All support and release claims use the built CLI, packaged TypeScript daemon, real SQLite state, real filesystem, managed browser, explicitly selected setup-managed profile, real ChatGPT website and provider network, plus real MCP server processes where the claimed capability involves MCP.

The initial acceptance flow must prove:

- visible instruction installation or conversation bootstrap with exact revision evidence;
- fresh conversation creation and exact continuation;
- the same ordered caller-selected Skill set and provenance crossing package, authenticated daemon HTTP, and CLI access paths;
- complete injection of every selected `SKILL.md` before the first task turn, with no ambient Skill catalog or web-model Skill-selection turn;
- one schema-valid `action_batch` containing multiple known missing inputs, followed by one consolidated local request and one aggregate provider continuation;
- a final answer that uses unique canaries available only in every selected `SKILL.md` body;
- no read, enumeration, upload, or execution of Skill `references/`, `assets/`, or `scripts/`;
- structured final-output validation, artifact-reference validation, invalid arguments, unknown tools, duplicate envelopes, stale nonce, size limits, and bounded protocol repair;
- no workspace write, arbitrary file read, process execution, network call, or MCP server during the initial skill slice;
- in later filesystem and MCP phases, multiple independent calls execute from one batch and return through one aggregate continuation, while mutating calls cannot execute before exact approval;
- prompt-injection text inside tool output cannot widen policy or execute an unapproved tool;
- daemon and, where applicable, MCP process restart does not duplicate a provider submission or tool mutation;
- final text, artifacts, citations, conversation identity, calls, approvals, and execution outcomes are durably correlated; and
- the profile test target retains keychain-neutral flags, production Chromium sandboxing remains enabled, processes are cleaned up, and no Keychain prompt appears.

No provider fixtures, route interception, simulated responses, invented DOM, fake runtime, synthetic fetch, or source-regex test can close `harness_agent` support. Redacted real DOM fixtures may still support focused selector or parser maintenance under the repository fixture policy, but they are not agent-loop acceptance evidence.

Real E2E does not automate login, CAPTCHA, MFA, consent, or Keychain approval and does not collect screenshots, full DOM, storage, credentials, or unrelated account content.

## Acceptance Criteria

- The harness and provider runtime communicate only through the provider-turn interface; harness code contains no provider selectors or page operations.
- The harness is an independently buildable workspace package, exports only its declared root interface, and imports no provider adapter, Playwright, daemon storage, profile, DOM, or CLI implementation module.
- Provider Integration and Harness own separate persistence schemas and correlate only through versioned public identifiers.
- Removing the harness package leaves all normal provider CLI, daemon, and browser execution behavior working.
- Extracting the harness to another repository requires no provider source move and no harness source reorganization.
- The provider runtime can still execute a normal one-turn QA job without loading MCP or agent-harness modules.
- ChatGPT is the only initial `harness_agent` route, and its first support claim is backed by real visible caller-selected `SKILL.md` injection and batch-control behavior before filesystem or MCP claims are added.
- Every new agent run uses a fresh conversation and freezes exact caller-turn, instruction, context, Skill-selection, tool-catalog, provider, profile, workspace, and limit revisions.
- Project instructions are changed only in a Tokenless-owned Project or after explicit preview and approval; unrelated instructions are never overwritten.
- Visible instruction delivery is reported honestly and is never mislabeled as a native system role.
- Every model response is exactly one complete `action_batch` or `final` envelope and passes framing, syntax, schema, correlation, capability, authority, and output-contract validation as applicable before any tool action or terminal success.
- One invalid item rejects the entire undispatched batch; partial execution never precedes a protocol repair.
- A valid batch lists all currently well-defined actions and all known missing user inputs; providers that repeatedly serialize independent work across avoidable turns are not `harness_agent` eligible.
- The Harness persists blocked calls and resumes their exact ids and arguments after approval, authentication, or elicitation instead of asking the model to replan.
- All stable outcomes from one batch return to the provider in one ordered aggregate continuation.
- Tool names and arguments must match the frozen schema snapshot; parser success never implies authorization.
- MCP annotations and model claims never override locally assigned effects or approval policy.
- The first skill slice launches no MCP server, executes no process, and has no general workspace read or write authority.
- The first MCP phase launches only explicitly configured local `stdio` servers with bounded environment, resource policy, processes, logs, and results.
- Skills are selected upstream, resolved only through approved roots, injected by exact `SKILL.md` revision before the first task turn, and may contribute instructions and tool requirements but cannot execute or authorize operations.
- Package, authenticated daemon HTTP, and CLI expose the same four durable Harness operations and do not contain competing Harness implementations.
- Filesystem writes occur only through schema-valid, rooted, stale-preimage-safe tool calls; final prose and artifact declarations never write implicitly.
- No mutating call executes without a matching explicit policy rule or exact approval digest.
- Every provider and tool mutation has durable pre-dispatch intent and unambiguous completion or waiting state.
- Ambiguous external mutations are never retried automatically.
- Provider-turn, batch, call, missing-input, time, byte, dependency-depth, and parallelism limits prevent infinite or unbounded loops.
- Mid-run provider fallback, arbitrary shell execution, secret delivery, and implicit approval are absent from V1.
- Final results satisfy the frozen Markdown or JSON Schema contract, contain only valid run-owned artifact references and bounded user-facing evidence, and exclude hidden chain-of-thought or unrelated provider content.

## Risks and Responses

| Risk | Response |
| --- | --- |
| A provider follows the control protocol inconsistently | Provider-specific real E2E, strict validation, one repair turn, finite limits, and honest `qa` fallback |
| A provider returns one independent call or one missing question per slow turn | Make batch completeness part of the stable Harness instruction and `harness_agent` acceptance; fail or downgrade providers that repeatedly force avoidable turns |
| One batch is too large to validate, execute, or return safely | Bound calls, needs, dependencies, schemas, results, and artifacts; reject over-limit batches and require task or tool selection to narrow the run |
| One call in a batch needs login or approval | Persist every call first, finish unrelated safe work, consolidate local interaction, resume the exact blocked call, and send one aggregate result only after all outcomes are stable |
| Visible instructions are weaker than a native system role | Record fidelity, prefer approved Project instructions, enforce safety in the local runtime, and never claim semantic parity |
| Tool output injects instructions into the model | Delimit it as untrusted data and make local policy authoritative even if the next model turn is compromised |
| The model invents a tool or malformed arguments | Frozen schema snapshot, strict validation, structured error result, and bounded recovery |
| The caller Agent automatically selects the wrong Skill | Preserve selection provenance, expose the selected list in run state, allow explicit caller overrides, and never add another Skill from web-model inference |
| Duplicate or conflicting Skills change model behavior unpredictably | Validate only the caller selection, fail duplicate or ambiguous identities, apply access policy, and freeze exact content-addressed revisions and order per run |
| A selected Skill contains references, assets, or scripts | V1 reads only `SKILL.md`; all other Skill-directory content remains untouched until a later explicit resource-delivery design |
| MCP tool annotations understate side effects | Treat annotations as hints and assign effects and scopes through reviewed local policy |
| A crash duplicates an external mutation | Persist intent first, use call ids and evidence, and stop on ambiguous dispatch |
| Tool catalogs are too large for a web prompt | Require an explicit selected tool set and byte budget; add tool search only after real full-catalog evidence |
| Project instructions collide with user content | Use Tokenless-owned Projects by default and require previewed merge or conversation bootstrap elsewhere |
| Provider state changes during a long loop | Pin exact identity, re-check visible preconditions each turn, and wait rather than switch providers |
| A local MCP server receives excessive ambient authority | Explicit configuration, minimal environment, scoped roots, bounded processes, and per-call policy |
| Remote MCP leaks or misuses credentials | Defer it until full authorization and secure token lifecycle support exists; never pass credentials through the web model |
| Skills become an authority bypass | Keep skills instruction-only and resolve every executable action through the same tool registry and policy |

## Non-Goals

- Exposing general browser RPA, selectors, raw DOM, or low-level provider actions to the web model
- Depending on provider private APIs, hidden function-call events, response streaming, or network interception
- Claiming that a visible user or Project instruction is a native system message
- Extracting or cloning provider, caller, or agent hidden prompts or private reasoning
- Letting ChatGPT approve its own tool calls or answer MCP credential prompts
- Automating login, CAPTCHA, MFA, Keychain approval, purchases, or external consent
- Providing unrestricted shell execution or converting arbitrary generated text into a command
- Treating installed skills as trusted executable code or ambient permission
- Letting the Web Harness or web model automatically discover or select additional Skills in V1
- Reading, uploading, or executing Skill `references/`, `assets/`, or `scripts/` in V1
- Reproducing an OpenAI-compatible one-tool-call-at-a-time loop when multiple actions or missing inputs are already knowable
- Multi-agent handoffs, delegation, autonomous planning graphs, or cross-provider continuation in V1
- Automatically applying generated code, patches, messages, or destructive changes without the applicable local review and approval
- Advertising Claude, Gemini, Grok, Qwen, DeepSeek, or another provider as agent-harness capable before its independent real-browser loop closes
- Splitting repositories or publishing the harness package before the provider-turn interface and first real agent loop are stable
- Assuming ownership of an npm scope, package name, organization, or other external namespace for the future extracted project

## Primary References

- [OpenAI Agents SDK runner lifecycle and tool loop](https://openai.github.io/openai-agents-js/guides/running-agents/)
- [ChatGPT Projects, files, and Project instructions](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)
- [Agent Skills format](https://agentskills.io/specification)
- [OpenCode Agent Skills behavior](https://opencode.ai/docs/skills/)
- [OpenCode skill discovery implementation](https://github.com/anomalyco/opencode/blob/16caaa222955ae10406d054f2fa84cd78985c09f/packages/opencode/src/skill/index.ts)
- [MCP 2026-07-28 release changes](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [MCP versioning and modern/legacy compatibility](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
- [MCP tools, schemas, results, annotations, and trust guidance](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [MCP stdio and Streamable HTTP transports](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports)
- [MCP elicitation and input-required behavior](https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
