# DSH Tokenless Repository Grounding Evidence — 2026-08-15

This report records one redacted repository-grounding run through an unmodified DSH checkout, the packaged Tokenless daemon, and the real DeepSeek website. It proves local search/read/result continuation and a source-verifiable final answer; it does not prove benchmark task completion or the generic DSH `llm-pi-ai` route.

## Run identity

| Item | Evidence |
| --- | --- |
| Tokenless revision | `262a8d4d46c8b6f8697ba1af653d6f864a4232f0` on `dev` |
| Tokenless worktree | Clean before and after the read-only run |
| DSH checkout | `/Users/jazelly/Desktop/github/deepseek-harness` |
| DSH revision | `47f943859bef60e4160492346772ded9b24f765a` on `master` |
| DSH worktree | Clean before and after; source unmodified |
| DSH client | Built `apps/cli/lib/bin.js`, `headless` profile, normal temporary YAML overlay using the existing `llm-deepseek` adapter |
| Provider boundary | Packaged daemon at the configured OpenAI-compatible route, `tokenless/deepseek`, real DeepSeek browser mode and network |
| Execution authority | DSH owned and executed `grep` and `read`; Tokenless only supplied structured model outcomes |
| Session | `session-4e12899a-a37e-49cd-ab94-57d5965d97c1` |
| Compressed JSONL | SHA-256 `2b21d63ca660ab81513b0860f342c5da688fe78518bcd93cd6012c2ec7c98481` |
| Temporary overlay | SHA-256 `f425f27ec562200f12ce6ec987bd4d3e204b5fa15e60dbf0f115eac859c1ea0b`; credential loaded only in process memory |

No provider fixture, response interception, synthetic SSE, local provider replica, or Tokenless-specific DSH source change was used.

## Observed tool loop

The compressed session contains two assistant messages, two steps, two tool calls, two matching tool results, and one completed turn. It also contains eleven streamed assistant chunks and no DSH `llm/retry` event.

| Order | DSH event | Bounded observation |
| --- | --- | --- |
| 1 | `tool/call` | `grep`, call id `call_7b9d4d9ed1dd413790d0c78730422318`; searched for `tokenless/auto` in `packages/cli/src/daemon/api-proxy.ts` |
| 2 | `tool/result` | Same call id; 729-byte result recorded by DSH |
| 3 | `tool/call` | `read`, call id `call_c61a25e04010417d911949f23506b5ed`; targeted the same source file |
| 4 | `tool/result` | Same call id; 59,290-byte source result recorded by DSH |
| 5 | Later model turn | Tokenless's compiled canonical history contained both unchanged call ids, the paired tool-role history, and the read source fact |
| 6 | Final assistant message | Correctly named `structuredControlRequirements` and `autoPublicCallId`, described the provider-origin public id, and identified that bounded correction pins the settled provider with `fallbackRoutes: []` |

Those facts were checked against the same revision of `packages/cli/src/daemon/api-proxy.ts`. The final answer did not merely repeat the task wording: the prompt supplied no source excerpt, implementation summary, symbol list, or answer.

## Tokenless job correlation

The two DSH model turns produced three successful DeepSeek jobs:

| Role | Job id | Provider submission | Attempts |
| --- | --- | --- | --- |
| First tool outcome | `fc7833b3-855b-4e15-9b9b-787c8bd954ed` | Present | 1 |
| Existing bounded same-provider JSON correction | `29d92ef0-4b81-432b-a921-0c68c2f3e5aa` | Present | 1 |
| Final continuation | `2c0c7c31-9b99-4670-b1c0-4b37f4991a98` | Present | 1 |

The short correction job was internal to the existing Tokenless strict-envelope path. DSH did not retry, no second provider received the request, and the final continuation carried the caller-owned tool history.

## Earlier natural outcomes

Three earlier fresh attempts were retained as diagnostic session artifacts rather than promoted as success:

- DeepSeek first used broad, low-value searches and produced an ungrounded final answer.
- A stricter DeepSeek prompt found relevant files but stopped before the targeted implementation read, so its final answer remained incomplete.
- ChatGPT reached the real provider but Tokenless rejected its malformed structured response with `provider_output_protocol_error`.

The successful run followed with a narrower factual question, not a source-bearing prompt or a parser relaxation. No repository file changed during any attempt.

## Boundary statement

This lane proves that the current DSH Tool Registry and Agent Loop can search and read the local Tokenless checkout through Tokenless, replay the results into a later model turn, and produce source-verifiable facts. It does not claim a SWE-rebench score, edit/test behavior, native provider tool calling, or generic DSH custom-provider compatibility.
