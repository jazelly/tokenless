# Design QA

**Source visual truth**

- `/var/folders/q7/shn9fgs933z44trf4ngg_kmw0000gn/T/codex-clipboard-bf431d33-7c80-4d8e-9af0-f4d6c8ee4794.png`
- Source state: the attached English Arena provider row with text `Unknown`, a successful-readiness green dot, relative check time, and a refresh button.
- The source was a focused row crop at approximately `1519 × 146`, density `1x`. Its temporary clipboard path expired while the task was paused; the source remained available as the conversation's visual target and had already been inspected before implementation.

**Rendered implementation**

- State comparison: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/provider-access-states.png`
- Arena row: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/provider-access-arena-row.png`
- Mobile: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/provider-access-icons-mobile.png`
- Desktop CSS viewport: `1920 × 929`, device scale factor `1`, focused row pixels `742 × 67`.
- Mobile CSS viewport and pixels: `430 × 900`, device scale factor `1`.
- State: English Overview, profile `web-ai`, showing authenticated paid, authenticated free, signed-out guest, authenticated plan-unknown, and never-checked Arena examples.

**Comparison evidence**

- Full-view evidence: the original row hierarchy, provider modes, age, and refresh control remain unchanged. The ambiguous `Unknown` text and unrelated successful-job green dot are removed.
- Focused evidence: `provider-access-states.png` stacks exact rendered rows for ChatGPT, Claude, Gemini, Grok, and Arena so every requested icon state is readable at one density.
- The implementation uses one to three Lucide `DollarSign` icons for relative paid levels, Lucide `Gift` for free or guest access, `UserRoundCheck` for signed in, `UserRoundX` for signed out, `UserRoundSearch` for unknown or never checked, and `BadgeQuestionMark` for an authenticated account whose plan is unknown.
- Mobile evidence shows the same indicators within the existing compact row layout and reports zero horizontal document overflow.

**Required fidelity surfaces**

- Fonts and typography: the existing system family, provider-name weight, mode-pill typography, and age-label hierarchy are preserved. No replacement status text competes with the provider name.
- Spacing and layout rhythm: indicators remain on the former secondary-label line with an `8px` gap and fit the existing `67px` row height. Desktop and mobile report no horizontal overflow.
- Colors and visual tokens: existing muted, green, red, amber, ink, and subtle semantic tokens are reused; no new palette was introduced.
- Image and icon fidelity: no raster asset is required. All status marks come from the installed Lucide icon family; no emoji, handcrafted SVG, CSS drawing, or text glyph substitutes are used.
- Copy and content: icon-only presentation has accessible English and Simplified Chinese labels and hover tooltips. Provider names, mode labels, timestamps, and refresh copy remain unchanged.

**Interaction verification**

- The real local Dashboard rendered through `ego-browser` at desktop and mobile widths.
- Hover tooltips and `aria-label` values expose the exact auth and plan meaning without permanent status text.
- Live inspection found ChatGPT `Plus` as paid level `2`, Claude as free, Gemini as signed out with guest access, Grok as signed in with plan unknown, and Arena as never checked.
- Two live Arena readiness jobs completed as `succeeded`, but the snapshot still returned `observation: null`; the UI therefore correctly retained the unknown-auth icon and did not infer a sign-in state.
- Successful readiness jobs no longer render a green status dot. Active or failed operational job states remain available.
- Browser inspection reported no horizontal overflow and no runtime exception events.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- The missing Arena observation is a provider-readiness data issue, not a visual implementation issue. The UI intentionally shows unknown until the backend provides evidence.

**Comparison history**

- Initial rendered evidence contained a stale hover tooltip from a prior readiness control. The pointer was moved off the controls and every focused row was recaptured; the final evidence is clean.
- The mobile pass found no overflow or clipped indicators, so no responsive fix was required.

**Follow-up polish**

- None required for this slice.

final result: passed
