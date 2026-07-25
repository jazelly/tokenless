# Provider guest-access routing

This document records the signed-out provider behavior observed in a user-provided Chrome Incognito window on 2026-07-25. Provider websites can change independently of Tokenless, so runtime decisions must continue to rely on visible page state.

| Provider | Signed-out entry | First submit | Runtime route |
| --- | --- | --- | --- |
| ChatGPT | Active composer | Returns a response | Continue as guest |
| Claude | `/new` redirects to `/login?from=logout`; no composer | Not available | Handoff for sign-in |
| Gemini | Active composer | Returns a response | Continue as guest |
| Grok | Active composer, but guest submission is not supported | Replaced by a non-dismissible “Continue your conversation” sign-up wall | Handoff before running the action |

None of the four observed pages exposed a dismissible authentication dialog with a guest-continuation control. The runtime rule below still supports that state when a provider introduces it.

## Provider account map

| Provider | Guest | Free evidence | Paid evidence |
| --- | --- | --- | --- |
| ChatGPT | Supported | `Free` | `Go`, `Plus`, `Pro`, `Team`, `Business`, `Enterprise` |
| Claude | Unsupported | `Free` | `Pro`, `Max`, `Team`, `Enterprise` |
| Gemini | Supported | Unknown until reliable visible plan evidence is available | Unknown until reliable visible plan evidence is available |
| Grok | Unsupported | `Auto`, `Expert`, and `Heavy` all visibly unavailable | Any of `Auto`, `Expert`, or `Heavy` visibly available (`SuperGrok`) |

Account labels classify a visible session as `signed_in_free`, `signed_in_paid`, or `signed_in_unknown`. They are diagnostic evidence, not capability authorization.

## Routing rules

1. Setup runs one visible `auth.status` observation per provider and reports `auth`, `access`, and any observed tier. A page that has not stabilized may be reported as `unknown`. Setup does not submit a prompt, open a sign-in handoff, or retry after user login.
2. A visible sign-in or sign-up affordance is not a blocker by itself when a usable composer remains visible.
3. ChatGPT and Gemini are the supported guest providers. Before handoff, Tokenless accepts an exact visible guest-continuation control such as “Continue as guest” or “Continue without signing in”, then checks the page again.
4. Claude and Grok require authentication for Tokenless jobs. An unauthenticated runtime check hands off before entering or submitting the task.
5. Before a gated action, an unknown page surface waits for a stable account, guest composer, sign-in surface, challenge, or terminal blocker. An unsupported-guest provider that remains unknown conservatively hands off; a supported-guest provider with no usable surface fails with a retryable technical error.
6. Challenge, plan, quota, and rate-limit blockers remain separate from authentication routing.

## Capture evidence

Signed-out DOM captures are stored as redacted, provenance-bound candidates under `test-results/provider-guest-captures/`. The fresh-profile real CLI matrix is stored under `test-results/live-provider-guest-access/`. These artifacts are not promoted into the authenticated provider fixture inventory because the current fixture policy requires authenticated visible-session provenance.
