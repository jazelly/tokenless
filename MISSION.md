# Mission: Complete Tool-Calling, Structured Output, and Portable Context

## Goal

Complete the active P0 tool-calling roadmap so Tokenless can serve an unmodified OpenAI-compatible harness, preserve tool-call history across supported provider strategies, guarantee structured results or explicit protocol errors, and prove the result through the real local DeepSeek Harness and executable software-engineering tasks.

## Non-goals

- Execute caller-owned tools inside the Universal API.
- Add a second scheduler, queue, approval system, MCP host, or general conversation database.
- Emulate provider-hosted search, computer use, code interpreter, or MCP as caller function tools.
- Retry or switch providers after an ambiguous or completed provider submission.
- Claim access to proprietary provider server source or hidden reasoning.
- Turn the three-task DSH interoperability cohort into a benchmark leaderboard.

## V1 boundary

The first working path is one real DSH request containing function tools, one validated tool call returned through the packaged Tokenless Chat Completions endpoint, DSH execution of that local tool, one `role: tool` continuation request, and a final real-provider answer.

That path is the first milestone, not mission completion. Later milestones add the explicitly requested complete contract: streaming, multiple calls, `tool_choice`, strict schemas, structured final output, shared Harness primitives, Responses mapping, explicit auto routing, provider conformance evidence, and real DSH SWE-task evidence. Recovery frameworks, background orchestration, generalized telemetry, and compatibility with deprecated `functions` remain deferred.

## Assertions and evidence

| ID | Observable assertion | Required evidence |
| --- | --- | --- |
| TC-001 | Chat Completions accepts modern function `tools`, assistant `tool_calls`, and `role: tool` history while rejecting malformed or unpaired history before provider submission. | Built CLI plus focused real local daemon integration; request/response examples in synchronized API docs. |
| TC-002 | A successful non-streaming turn returns either a schema-valid declared tool call with stable public identity or final text; invalid provider output returns a machine-readable protocol error. | Real provider turn through packaged daemon; redacted boundary trace. |
| TC-003 | Streaming tool calls expose reconstructable stable indexes, ids, names, ordered argument fragments, terminal `finish_reason: tool_calls`, and `[DONE]`. | Unmodified built DSH stream plus its session JSONL and Tokenless trace. |
| TC-004 | `tool_choice` (`auto`, `none`, `required`, named), multiple calls, strict argument schemas, and tool-result continuation preserve their declared semantics. | Focused daemon checks plus real DSH single, sequential, and multiple-call runs. |
| TC-005 | `json_object` and the published `json_schema` subset return valid final JSON or an explicit error, including after intermediate tool turns. | Built public API boundary, real provider output, and schema validation result. |
| TC-006 | Standalone Harness and Universal API share only the low-level canonical/framing/schema primitives needed by both while retaining separate execution ownership. | Source dependency inspection, build/lint, and one real provider strategy exercised through both surfaces. |
| TC-007 | Responses function-call items, outputs, call ids, non-streaming, streaming, full-input replay, and `previous_response_id` continuation map to the same canonical semantics as Chat Completions while provider-required opaque replay items remain provider-affine. | Current official SDK client through packaged daemon and a real provider, including full-input and prior-response-id tool-result continuation. |
| TC-008 | Explicit auto routing can continue a completed tool-call/result pair from provider A on provider B without changing public call ids or silently losing history; post-submission ambiguity never falls back. | Two real providers, one external-Harness logical session, and redacted route/canonical trace. |
| TC-009 | Every advertised native route is mapped from current official OpenAI, Anthropic, Gemini, or DeepSeek contracts and backed by an exact endpoint/model live probe; prompt-emulated routes remain labeled as such. | Versioned conformance table plus redacted live probes; vLLM used only as a public server-side implementation reference. |
| TC-010 | The pinned local DSH can inspect the Tokenless checkout and answer a source-verifiable repository question using real local tools without modifying the repository. | DSH HEAD/build identity, session JSONL, Tokenless trace, verified file/symbol citations, and empty diff. |
| TC-011 | The same DSH/Tokenless path runs three frozen current SWE-rebench tasks with real search/read/edit/bash/test chains and upstream evaluator verdicts. | Immutable task/image revisions, fresh sessions, tool traces, diffs, commands, and separate protocol/task outcomes. |
| TC-012 | User-visible API and CLI contracts are documented in aligned English and Simplified Chinese and carry the required changeset. | API contract check, docs comparison, changeset, build, lint, and applicable real-boundary suites. |

## Constraints

- Follow `AGENTS.md`, especially no over-engineering, real-boundary tests, provider credential safety, and browser-profile preservation.
- Use the existing daemon, provider registry, job model, strict-envelope code, and test boundaries; add no parallel infrastructure.
- Do not use mocks, fakes, stubs, provider fixtures, intercepted provider responses, or local provider replicas.
- Keep caller tools ephemeral and scoped to the current request. Tokenless validates but never executes them on the Universal API path.
- Treat user/tool/provider content as untrusted data inside protocol framing.
- Keep provider-local continuation metadata adapter-local; only canonical public history is portable.
- Every milestone gets one implementation worker, a fresh read-only reviewer, coordinator verification, and exactly one commit on `dev` before the next milestone.
- Preserve unrelated existing working-tree changes and never include them in mission commits.

## Complexity admission

Every non-trivial mechanism must name the assertion that fails without it, an existing repository contract that requires it, a reproduced failure, or an immediate severe risk. Otherwise it is deferred or removed.

## Stop condition

Complete only when TC-001 through TC-012 have evidence, all fresh-reviewer blocking findings are resolved, every milestone is independently committed, and no mission agent remains active. Stop and report a concrete blocker only when required credentials, provider access, benchmark infrastructure, or another external condition prevents real-boundary evidence after all safe in-scope checks are exhausted; do not replace missing evidence with simulation.
