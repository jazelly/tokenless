# Provider guest-access routing

This document records signed-out provider behavior observed in a user-provided Chrome Incognito window on 2026-07-25, plus the current experimental Qwen guest route proven through the selected live guest profile. Provider websites can change independently of Tokenless, so runtime decisions must continue to rely on visible page state.

| Provider | Signed-out entry | First submit | Runtime route |
| --- | --- | --- | --- |
| ChatGPT | Active composer | Returns a response | Continue as guest |
| Claude | `/new` redirects to `/login?from=logout`; no composer | Not available | Handoff for sign-in |
| Gemini | Active composer | Returns a response | Continue as guest |
| Grok | Active composer, but guest submission is not supported | Replaced by a non-dismissible “Continue your conversation” sign-up wall | Handoff before running the action |
| Qwen | Active composer in the selected guest profile | Returns a first correlated response | Continue as experimental guest |

None of the 2026-07-25 ChatGPT, Claude, Gemini, or Grok pages exposed a dismissible authentication dialog with a guest-continuation control. The runtime rule below still supports that state when a provider introduces it.

## Provider account map

| Provider | Guest | Free evidence | Paid evidence |
| --- | --- | --- | --- |
| ChatGPT | Supported | `Free` | `Go`, `Plus`, `Pro`, `Team`, `Business`, `Enterprise` |
| Claude | Unsupported | `Free` | `Pro`, `Max`, `Team`, `Enterprise` |
| Gemini | Supported | Unknown until reliable visible plan evidence is available | Unknown until reliable visible plan evidence is available |
| Grok | Unsupported | `Auto`, `Expert`, and `Heavy` all visibly unavailable | Any of `Auto`, `Expert`, or `Heavy` visibly available (`SuperGrok`) |
| Qwen | Experimental supported | Unknown until reliable visible plan evidence is available | Unknown until reliable visible plan evidence is available |

Account labels classify a visible session as `signed_in_free`, `signed_in_paid`, or `signed_in_unknown`. They are diagnostic evidence, not capability authorization.

## Routing rules

1. Setup runs one visible `auth.status` observation per enabled provider and reports `auth`, `access`, and any observed tier. A page that has not stabilized may be reported as `unknown`. Setup does not submit a prompt, open a sign-in handoff, or retry after user login.
2. A visible sign-in or sign-up affordance is not a blocker by itself when a usable composer remains visible.
3. ChatGPT and Gemini are supported guest providers; Qwen is an experimental guest provider. Before handoff, Tokenless accepts an exact visible guest-continuation control such as “Continue as guest” or “Continue without signing in”, then checks the page again.
4. Claude and Grok require authentication for Tokenless jobs. An unauthenticated runtime check hands off before entering or submitting the task.
5. Before a gated action, an unknown page surface waits for a stable account, guest composer, sign-in surface, challenge, or terminal blocker. An unsupported-guest provider that remains unknown conservatively hands off; a supported-guest provider with no usable surface fails with a retryable technical error.
6. Challenge, plan, quota, and rate-limit blockers remain separate from authentication routing.

## Live evidence

The fresh-profile real CLI matrix is stored under `test-results/live-provider-guest-access/`, and current provider capability status is summarized in `test/live-provider-capability-matrix.json`. Provider behavior is verified only on the real website; DOM captures and fixture promotion are not part of development or testing.
