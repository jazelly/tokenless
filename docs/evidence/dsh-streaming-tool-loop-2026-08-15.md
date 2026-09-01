# DSH Streaming Tool Loop Evidence — 2026-08-15

This report records one redacted real-provider interoperability run. It proves the current single-call terminal SSE path, not multiple calls, parallel calls, forced `tool_choice`, or `strict: true`.

## Run identity

| Item | Evidence |
| --- | --- |
| DSH checkout | `/Users/jazelly/Desktop/github/deepseek-harness` |
| DSH revision | `47f943859bef60e4160492346772ded9b24f765a` |
| DSH build | `pnpm run build`, exit 0 |
| DSH worktree | Clean before and after; source unmodified |
| Client setup | Isolated temporary headless home with an `openai-completions` route to packaged Tokenless; bearer loaded only in process memory |
| Session | `ef503c8f-1e77-4eaa-951b-b1ca64bd1197` |
| Compressed JSONL | SHA-256 `50fe25191792c3b7fca39c9d05535b5c5b5a831c51a91553a49b9f4b47d7427c`; 45 rows |

Session event counts were `assistant/chunk`: 15, `assistant/message`: 3, `tool/call`: 2, `tool/result`: 2, `step/start`: 3, `step/end`: 3, `turn/start`: 1, and `turn/end`: 1.

## Observed sequence

| Step | Public stream and Harness result | Tokenless response/job |
| --- | --- | --- |
| 1 | Tool-call delta at index 0 with id `call_a8feaf2b49e94fa696819f1230ccea19`, name `read`, and complete arguments selecting `package.json`; terminal finish was `tool-calls`. DSH executed the read and recorded the result. | `c014f773-7dc4-4898-b933-e5f87cb60c20` |
| 2 | Tool-call delta at index 0 with id `call_34b28236aa7c4b9b99b53a585c19b521`, name `read`, and complete arguments selecting `packages/cli/src/daemon/api-proxy.ts`; terminal finish was `tool-calls`. DSH executed the read and recorded the result. | `769ea4ae-e2c8-42e8-a526-857da57efe1e` |
| 3 | Final text correctly reported package version `0.1.0` and that streaming tool calls use terminal `finish_reason: tool_calls`; terminal finish was `stop`. | `54018574-88d1-4565-a8a2-738d15d786ba` |

The Tokenless database recorded all three jobs with provider `deepseek`, action `visible_provider_actions`, status `succeeded`, and execution backend `playwright`.

## Failure that unlocked the run

The first DSH attempt failed before provider submission because Tokenless rejected a real DSH tool description longer than its arbitrary 1,024-character limit. That limit was not part of the OpenAI or DSH contract and duplicated the compiled prompt's 1 MiB bound, so the milestone removed it before the successful run.

## Boundary statement

The run used the real DeepSeek website through the packaged daemon. It used no provider fixture, mock, intercepted response, or synthetic SSE; DSH source was not modified, and Tokenless never executed the caller-owned tools.
