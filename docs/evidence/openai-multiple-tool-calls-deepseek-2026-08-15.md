# OpenAI Multiple Tool Calls — DeepSeek — 2026-08-15

This report records redacted real-provider evidence through the packaged daemon and real DeepSeek website. It retains no credential, provider session, full prompt, full tool output, DOM, or screenshot.

## Run identity

| Item | Evidence |
| --- | --- |
| DSH checkout | `/Users/jazelly/Desktop/github/deepseek-harness` |
| DSH revision | `47f943859bef60e4160492346772ded9b24f765a` |
| DSH build | `pnpm run build`, exit 0 |
| DSH source worktree | Clean before and after; source unmodified |
| Client setup | Isolated temporary headless home with an `openai-completions` route to packaged Tokenless; bearer present only in process memory |
| DSH session | `2dba3cd7-701e-4ae8-9c80-4932e5abba6a` |
| Compressed JSONL | SHA-256 `d1512872fc2ed3339ab733a89b226ecd2ecd0c2df31ecf9baa34df7fd1739465`; 40 rows |

Relevant session counts were `assistant/chunk`: 13, `assistant/message`: 2, `tool/call`: 2, `tool/result`: 2, `step/start`: 2, `step/end`: 2, `turn/start`: 1, and `turn/end`: 1.

## DSH multiple-call sequence

The first assistant message contained two calls in one outcome and no accompanying text. DSH reconstructed two complete calls from the terminal SSE delivery in model order:

| Index | Public call id | Tool | Arguments selection |
| --- | --- | --- | --- |
| 0 | `call_931a284b1c2b48fcb7591245db521330` | `read` | `package.json` |
| 1 | `call_592299e5b5ac4770886c192ff5f46cad` | `read` | `packages/cli/src/daemon/openai-tool-protocol.ts` |

Each delta carried its complete arguments string. The stream terminated with `tool-calls`; DSH executed both real local reads, recorded one matching result for each id, replayed the complete call/result group, and received a final `stop` answer stating package version `0.1.0` and `OPENAI_TOOL_PROTOCOL` value `tokenless.openai-tools/v1` with both source paths.

The tool-call turn was Tokenless job `0cdf9fcc-3ea8-40f9-a5dd-69de7afe43cb`; the final continuation was `ba0bdb6f-b873-484c-8a28-b11a74dea04e`. DSH also made its ordinary session-title request as job `cf50c7f4-5041-46e7-a159-b1298d4730f8`. All three real DeepSeek browser jobs succeeded.

Observed protocol counters were two model turns, two calls, zero schema-invalid calls, zero undeclared names, zero unmatched ids, zero truncated streams, zero premature finals, and zero terminal protocol errors.

## Mixed content and calls

A separate non-streaming packaged API request explicitly required short accompanying content plus two calls. Real DeepSeek returned `content: "MIXED_M4_CONTENT"`, followed by model-ordered `record_left` and `record_right` calls with unique public ids and schema-valid arguments, then `finish_reason: tool_calls` (job `32f7930f-b740-42d5-9408-3669d33bdc0d`).

This was a separate conformance case, not a correction or retry of the DSH session. No provider-output correction ran in either successful case.

## Diagnostic before the run

One earlier DSH process exited with a loopback transport connection error because the packaged Tokenless daemon was not listening. It created no Tokenless provider job. Starting the current packaged daemon directly unlocked the successful run; no ambiguous or completed provider submission was replayed.

## Boundary statement

The calls came from the real DeepSeek website through the packaged Tokenless daemon. DSH—not Tokenless—executed the caller-owned tools. The runs used no provider fixture, response interception, synthetic SSE, local provider replica, DSH source change, scheduler, or runtime retry framework.
