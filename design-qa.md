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

---

# Tokenless API Design Atlas QA

## Scope

- Independent Storybook design surface under `packages/dashboard/design-atlas`.
- Production source is visual/reference input only; the atlas imports no Dashboard views, components, styles, or API clients.
- Root screens: Setup, Overview, Profiles, Providers, Capabilities, Chat History, and System.
- Design-only additions: foundations, provider detail, job detail, loading/offline/fatal states, and modal studies.

## Visual truth and rendered evidence

| Surface | Reference | Implementation | Viewport |
| --- | --- | --- | --- |
| Overview desktop | `test-results/design-atlas/reference/overview-desktop.png` | `test-results/design-atlas/implementation/overview-default-1920.png` | 1920 × 1080 |
| Overview mobile | `test-results/design-atlas/reference/overview-mobile.png` | `test-results/design-atlas/implementation/overview-mobile.png` | 390 × 844 |
| Root screens desktop | `test-results/design-atlas/reference/screens-contact-sheet.png` | `test-results/design-atlas/comparison-root-screens.png` | 1920 × 1080 per screen |
| Root screens mobile | Individual `*-mobile.png` reference captures | `test-results/design-atlas/implementation/root-screens-mobile.png` | 390 × 844 per screen |
| Storybook workbench | Current Storybook manager | `test-results/design-atlas/implementation/storybook-manager.png` | 1600 × 1000 |

All captures use device scale factor 1. Desktop comparisons use the same viewport and empty/local design state. The mobile pass uses the same 390 × 844 viewport and profile selection.

## Comparison findings and corrections

| Severity | Finding | Correction | Result |
| --- | --- | --- | --- |
| P1 | The first Profiles, Providers, and Jobs stories were redesigns rather than current-page mirrors. | Rebuilt them around the production profile summary, nine-provider grid, and Chat History empty/select-conversation layout. | Fixed |
| P1 | Overview mobile used a custom toolbar, a split range control, and a clipped panorama table. | Matched the production mark/profile header, full-width range control, stacked panorama header, and two-column mobile table header. | Fixed |
| P1 | Capabilities and System were too card-heavy and did not preserve current information density. | Restored grouped capability rows and the production-shaped configuration card hierarchy. | Fixed |
| P1 | The `screen` Control initialized the canvas but did not update an existing component instance. | Synchronized external `screen` changes while preserving local in-canvas navigation; verified Overview → Providers → Overview in Storybook. | Fixed |
| P1 | The default `design` profile was absent from the desktop and modal selectors. | Unified the profile options and verified that the desktop selector resolves to `design`. | Fixed |
| P1 | Provider cards shared one toggle state. | Replaced the shared Boolean with provider-slug state; verified that toggling ChatGPT leaves the other eight cards unchanged. | Fixed |
| P1 | The production Chat History surface was misleadingly titled `Jobs / List`, and superseded design branches remained in the template. | Renamed the story to Chat History and removed the unreachable branches; Job Detail remains a clearly separate design exploration. | Fixed |
| P2 | Three icon-only switches emitted missing-label accessibility warnings. | Added localized `aria-label` values and rebuilt without Svelte accessibility warnings. | Fixed |
| P2 | A canceled job story referenced a value absent from its Storybook control. | Added `job-4796` to the control options. | Fixed |
| P2 | Several secondary surfaces retained English copy in `zh-CN` mode. | Added focused bilingual variants for Setup, Foundations, Capabilities, provider detail, job detail, and the capability modal. | Fixed |

## Browser and interaction checks

- All 39 stories mounted in the real browser with no visible Storybook error and no console exception.
- Desktop root screens rendered without horizontal overflow at 1920 × 1080; canonical 1440 × 900 stories also rendered successfully.
- Profiles, Providers, Capabilities, Chat History, and System rendered at 390 × 844 with `scrollWidth === innerWidth`.
- Storybook Controls changed density from `comfortable` to `compact`; the canvas updated to `density-compact` and 28 px page top padding.
- Storybook Controls changed language from `en` to `zh-CN`; the Overview heading updated from `Usage analytics` to `使用分析`, then reset successfully.
- The same runtime Control changed the Capabilities family, title, description, and status to `对话`, `聊天`, a Chinese description, and `支持`.
- Navigation, provider/profile selection, local switches, modal actions, forms, and illustrative state controls remain local to Storybook and do not call the Tokenless API daemon.

## Build and isolation checks

- `npm run design:build`: passed with Storybook 10.5.10.
- `npm run lint --workspace packages/dashboard`: passed with 0 errors and 0 warnings.
- `npm run build --workspace packages/dashboard`: passed.
- `git diff --check`: passed.
- Production import scan across `.storybook` and `design-atlas`: no Dashboard `src` imports.
- Static Storybook output is ignored and is not part of the committed source.
- `packages/dashboard/design-atlas/README.md` documents startup, Controls, boundaries, and the coded-workbench limitation.

The remaining build notices are Storybook's default Svelte-config fallback and a single JavaScript chunk over 500 kB. Neither changes the V1 user boundary or the independent-source contract.

Final result: passed

---

# Tokenless API Storybook UI Correction QA

## Source and implementation

- Source visual truth: `test-results/design-atlas/reference/overview-mobile.png`.
- Rendered implementation: `test-results/design-atlas/implementation/overview-profile-switcher-mobile.png`.
- Combined comparison: `test-results/design-atlas/comparison-overview-profile-switcher-mobile.png`.
- Focused open-menu evidence: `test-results/design-atlas/implementation/overview-profile-switcher-mobile-open.png`.
- Source and implementation pixels: `390 × 844` each; CSS viewport `390 × 844`, device scale factor `1`, no density normalization required.
- State: English Overview, `research` profile selected after a real custom-picker interaction. The source uses the production native `design` select; the custom picker and profile-specific content are an intentional correction requested by the user.

## Comparison and required fidelity surfaces

- Full view: page hierarchy, mobile header height, analytics range, two-column KPI grid, Insights, Provider Panorama, and fixed bottom navigation preserve the production composition.
- Focused region: the custom profile picker aligns to the production header slot, uses a 38 px trigger, and opens a 280 px four-option menu fully inside the 390 px viewport.
- Typography: existing system type hierarchy and weights remain consistent; the selected profile and KPI values use the same compact emphasis as the production UI.
- Spacing and layout: the header, page gutters, card rhythm, and bottom navigation remain aligned; all 54 stories report zero document-level horizontal overflow at both `390 × 844` and `1440 × 900`.
- Colors and tokens: the existing canvas, surface, line, ink, muted, success, warning, and radius tokens are reused.
- Images and icons: the existing Tokenless API mark and installed Lucide icons are used; no new raster, handcrafted SVG, emoji, or CSS-drawn icon was introduced.
- Copy and content: no page canvas contains `Design Atlas`, `Illustrative design data`, `Independent UI surface`, `设计面`, or `示例设计数据`. Story data now reads as real Dashboard content while remaining local to Storybook.

## Interaction and component evidence

- The header contains zero native `select` elements on desktop and mobile; it exposes an accessible button, listbox, four options, selected state, outside-click close, Escape close, and ArrowDown open.
- Selecting `research` closes the menu and changes the top header to `12.9k / 1 / 18`, Overview to `Perplexity / 18 / 89% / 15/34`, and its supporting copy.
- Selecting `personal` on Profiles changes the heading, purpose to `Personal workspace`, provider list to `ChatGPT / Grok`, and header totals to `4.2k / 0 / 7`.
- Selecting `research` on Providers changes the active cards to `Claude / DeepSeek / Perplexity`; providers outside that profile become visibly disabled, while Gemini remains unavailable because its setup state is unresolved.
- Components now have isolated, controllable Stories for Profile switcher, Action button, Status badge, Metric card, Provider card, and Navigation item. The page implementation reuses ProfileSwitcher and MetricCard.
- The corrected Storybook index contains 54 stories; the former Foundations design-only page is absent.

## Comparison history

- Initial finding P1: the profile control was a native select and profile changes mostly changed only the slug. Fixed with the custom reusable picker and four profile data models; post-fix browser evidence confirms distinct header, KPI, purpose, and provider outputs.
- Initial finding P1: design-workbench copy leaked into page canvases and detail states. Removed from setup, state, provider detail, job detail, system, modal, controls copy, and the story index; the 54-story sweep found no remaining visible leak.
- Initial finding P2: the first component build emitted three Svelte local-state warnings and two scoped-icon selector warnings. Reworked prop synchronization and the chevron wrapper; `svelte-check` now reports zero errors and zero warnings.

## Findings

- No actionable P0, P1, or P2 issue remains.
- The custom profile menu intentionally improves on the source native select; this is the user-requested design change rather than fidelity drift.

final result: passed
