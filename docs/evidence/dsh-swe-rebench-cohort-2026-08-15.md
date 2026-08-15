# DSH SWE-rebench Cohort Evidence — 2026-08-15

This report records a three-task, answer-blind interoperability cohort through official Harbor, an unmodified DSH checkout, the packaged Tokenless daemon, and the real DeepSeek website. The cohort observed tool-loop behavior and official evaluator outcomes; it is not a SWE-rebench score or leaderboard submission.

## Frozen boundary

| Item | Evidence |
| --- | --- |
| Harbor | Official `harbor` CLI `0.21.0`, invoked with `uvx` |
| Dataset discovery | `swe-rebench/swe-rebench-leaderboard@latest` |
| Frozen dataset | Revision `2`, `sha256:ebe7444e313a0d8db94fa541139826eaebe2b0abcd4900c6f73e750494910dca`, 860 tasks |
| Split | Each selected task declares source `nebius/SWE-rebench-leaderboard::test/<task>`; Harbor exposes no per-task `YYYY_MM` field, so no monthly split is inferred |
| Tokenless | `647eb1f`, clean before and after |
| DSH | `/Users/jazelly/Desktop/github/deepseek-harness`, revision `47f943859bef60e4160492346772ded9b24f765a`, clean before and after |
| Harness surface | Built DSH `apps/cli/lib/bin.js`, `headless` profile, existing `llm-deepseek` adapter |
| Provider | `tokenless/deepseek`, packaged daemon, real DeepSeek browser mode and network |
| Execution | Harbor Docker on Apple Silicon using the upstream `linux/amd64` task images; tasks ran serially with Harbor `n_attempts=1`, `n_concurrent=1`, and `max_retries=0` |
| Configuration | Original Tokenless config SHA-256 `ca57f4cac4b6f090c239748d6a04512194d4bd9eb47601e0c4c0e8f711b74c57`; restored byte-for-byte after the cohort |

The checked-in DSH Python SDK example was not used because this checkout has no built Linux SDK runtime carrier and the SDK distributions are not published at the checkout's development version. A temporary, uncommitted Harbor `BaseAgent` bridge instead downloaded each real container `/testbed` to a fresh host workspace, ran the unmodified built DSH CLI there, and uploaded the workspace to the same trial before verification. No DSH or Tokenless source was patched.

The temporary DSH overlay SHA-256 was `0750371c26c11c1457b6a2e50c6f4eadbad97b164163779be374e22ec6fa70d5` for the first two tasks. After task two exposed DSH's provider retry policy, the only change was `retryPolicy.maxRetries: 0`; the third-task overlay SHA-256 was `8fff6e57414e440676de6debb97fcd6d5b85d318b969d4ebe65aa889eb761233`.

## Answer-blind selection

The rule was fixed before reading task instructions: sort all canonical task names bytewise, derive the repository key by removing the final `-<issue>` suffix, and take the first three unseen repository keys. Instructions, solutions, verifier files, difficulty, and prior results were not used for selection.

| Order | Task | Task revision and content hash | Base image manifest digest |
| --- | --- | --- | --- |
| 1 | `swe-rebench/ASPP__pelita-863` | Revision `1`; `sha256:59891d1a46b6169bd4d22336b98b4644ddddc98f3116bfd8d2ae5c413b3fe355` | `swerebench/sweb.eval.x86_64.aspp_1776_pelita-863@sha256:a365fe9d839a35706a8f86b6babc20a1d8a39c3a734dcd8c1b9f77e55d5148a7` |
| 2 | `swe-rebench/AbsaOSS__generate-release-notes-207` | Revision `1`; `sha256:9ad3c70e743b057fb4386cb43528aeb5f380a15b463448beb38d6f65161a82fb` | `swerebench/sweb.eval.x86_64.absaoss_1776_generate-release-notes-207@sha256:b5310183d46cab6d44563104127004febac514840704b682ec40f776b48b9dca` |
| 3 | `swe-rebench/All-Hands-AI__OpenHands-10628` | Revision `1`; `sha256:7cd04302d16e870a823c21e7cdceac1e05776531d2ced4f2848e6ed1182443bc` | `swerebench/sweb.eval.x86_64.all-hands-ai_1776_openhands-10628@sha256:83becd24b1af4219665ebf78261d83097a0e4856cc819ec090d0d82b6ff7ca0b` |

The image digests were resolved from the registry immediately before the cohort. The immutable task packages still contain upstream Dockerfiles with `:latest`; this report records the observed manifest resolution and does not claim that those upstream tags can never move.

## Per-task outcomes

| Task | DSH trace | Tool behavior | Terminal classification | Official evaluator |
| --- | --- | --- | --- | --- |
| `ASPP__pelita-863` | Session `session-8aa58f48-4a58-452d-b305-13b8c9eaa3e7`; JSONL SHA-256 `00d08cef662512f07f1beaf985181a2f5891d4203ec9cc3ac1cb926def64e70c` | 4 steps, 4 assistant messages, 9 calls and 9 matching results: `glob` 4, `grep` 4, `read` 1 | Agent stopped with a final response before any edit, bash, or test; workspace stayed clean. This is an agent-behavior failure, not a protocol failure. | Same trial completed normally; reward `0.0` |
| `AbsaOSS__generate-release-notes-207` | Session `session-9c5813b4-72ed-4f0a-9f6c-a8b63b5a5ec1`; JSONL SHA-256 `a91f520599fd441133ab0f32c03972f4c22a87f4737430bfc6b0b08bba2f06c9` | 3 steps, 2 assistant messages, 5 calls and 5 matching results: `grep` 3, `read` 2 | After the reads, DeepSeek returned malformed structured JSON. Tokenless failed closed with `provider_output_protocol_error`; DSH's then-default provider policy recorded 4 `llm/retry` and 4 `llm/retry-started` events. No edit/test occurred and the workspace stayed clean. | Agent exception prevented the same trial's verifier phase; an evaluator-only Harbor `nop` run on the identical clean immutable task returned reward `0.0` |
| `All-Hands-AI__OpenHands-10628` | Session `session-fb8d5a93-fefc-4501-bb35-3eb4bd5a5780`; JSONL SHA-256 `bf04a64e2ed16ef6ab6dd97faf7b093bcf594a57e26da14ebcc802a7177f357b` | 3 steps, 2 assistant messages, 10 calls and 10 matching results: `grep` 1, `glob` 2, `read` 7; DSH retry events `0` | A later model request hit a visible `provider_rate_limited` blocker before submission, remained the same queued job, and ended at DSH's 300-second stream-idle timeout. No edit/test occurred and the workspace stayed clean. | Agent exception prevented the same trial's verifier phase; an evaluator-only Harbor `nop` run on the identical clean immutable task returned reward `0.0` |

The evaluator-only runs did not invoke a model and are not replacement agent attempts. They exist only to record the official outcome of the unchanged workspaces after terminal agent failures.

## Tokenless correlation

All provider jobs below used provider `deepseek`; every submitted job recorded one provider attempt.

- `ASPP__pelita-863`: five succeeded jobs — `e3c4c926-3412-4c9c-863b-8ffc4efeaf0b`, `59bf0003-7d36-4f65-b598-30ddd8238bed`, `ee453d5d-188f-4516-b9e3-fbd2d48f0b47`, `fadc3c08-859d-4d6f-b12a-1526be47c412`, `d9fb8dee-3472-4b1e-9cf0-6009a9806627`.
- `AbsaOSS__generate-release-notes-207`: eight succeeded upstream jobs — `69fb61f9-cf7a-4e6b-b308-b254012d653d`, `7e284290-9d2c-484a-926e-52604fe402ee`, `5ac21d53-04dc-43c6-beeb-8aa1cf6a5839`, `e1978853-7597-4a03-8099-12e9c3bfc457`, `1ea26cad-2ec3-4b8e-866d-5605b7d20f4e`, `d570736d-19b9-4398-a002-fcf1b4b3a28d`, `568a2d38-339f-4627-a0ec-8b8babbe8b4b`, `8274fefa-22d2-46fe-ab0c-d44e41ae6142`. The public DSH turn still failed because the resulting structured outcome was invalid.
- `All-Hands-AI__OpenHands-10628`: three succeeded jobs — `35ecd6e0-0175-40ae-87a9-8011f4a861ca`, `f00d9331-a2c6-4c05-93cd-54f96a76c56f`, `04a1dde4-a1e3-46c7-91e6-fe38b84745c0` — followed by pre-submit job `ef339c86-21a0-4c1e-a689-4614aa50870c`. The latter was never submitted, and was canceled after DSH timed out so no orphaned provider action could resume.

Each session also generated one ordinary DSH title request; job counts therefore exceed assistant step counts. Across the three task sessions, DSH recorded 24 tool calls and 24 matching results, zero undeclared tool names, zero unmatched ids, zero schema-invalid exposed calls, zero truncated tool streams, one premature final, one terminal structured-protocol error, and one terminal stream-idle timeout.

## Diagnostic before the cohort

The first Harbor integration diagnostic reached DSH but used Tokenless's original `executionMode: direct`, and the direct G4F route returned upstream HTTP 401 before a valid model turn. The run was excluded from the cohort, normal Tokenless configuration temporarily selected browser execution, and the daemon was restarted through its normal shutdown path. No parser or DSH source change was made.

## Phase 3 closure attempt

A separate follow-up tried to close the roadmap's stronger edit/test requirement without changing task selection or product source. It reused `swe-rebench/ASPP__pelita-863`, Harbor `n_attempts=1` / `max_retries=0`, the same unmodified DSH revision, and a temporary instruction requiring an implementation edit plus a validation command before any final response. The temporary bridge, instruction, and final ChatGPT overlay had SHA-256 `8a2161b1db99f1014bbc012df7c7558c6a2184b668d7fc8686e89ad7db95b3af`, `dd5c60f9980d897af50f98f843395cd3b5c80614c76fd922399fdf3bfdf7e916`, and `e1590e4408eda919883d8a42280544b3a5bb08c178227beebda2570e28d79a42`.

The first ChatGPT setup diagnostic completed one submitted `skill` call/result, then a later request failed before submission with `prompt_input_failed`; it made no workspace change. Exact DeepSeek and `tokenless/auto` diagnostics then remained pre-submission queued while DeepSeek was unavailable and were explicitly canceled before they could submit; their DSH sessions contain no assistant or tool turn.

The final exact ChatGPT trial `ASPP__pelita-863__yKDdqi7` reached the real provider. DSH session `session-7c2918dd-ebc1-4fd2-82a0-b2d6bf839922` has SHA-256 `a10ed8a6b604d6575961f32cd1906773fd9db09c8e35db9ed204c439f8b72d20` and records two calls with two matching results (`skill` and `glob`). The later public turn failed closed with `provider_output_protocol_error` because the prompt-emulated response contained an invalid JSON string escape. DSH exited without an edit, test, or verifier result; the task workspace and both source repositories remained clean.

This follow-up is not a replacement successful attempt and does not close Phase 3. It establishes the current blocker at the real provider-output boundary: DeepSeek was unavailable before submission, while ChatGPT reached tool execution but later produced malformed structured control after submission, where cross-provider replay is forbidden. The Tokenless configuration began and ended at SHA-256 `10c43fe6b4ccc0a9e0df71d2620354a29d3cad6238e0d886c95473966d6a9e44`; no browser profile was closed or replaced.

## Boundary statement

This cohort demonstrates reliable search/read tool serialization, matching call/result history, multiple calls in one assistant turn, and clear fail-closed terminal behavior on three current real task repositories. It did not demonstrate edit/bash/test completion: all three official rewards were `0.0`, and the exact failure layer is recorded for each task. No provider fixture, intercepted response, synthetic tool output, hidden solution, or gold patch was used; no full prompt, model response, tool output, credential, DOM, or screenshot is retained in this report.
