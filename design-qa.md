# Design QA

**Source visual truth**

- `/var/folders/q7/shn9fgs933z44trf4ngg_kmw0000gn/T/codex-clipboard-148ecc88-e7ee-4f3a-8e3b-12e3dc05423c.png`
- Source pixels: `3242 × 904`, density `1x`.
- State: English Overview before aggregation, with four metric tiles and one output-savings tile.

**Rendered implementation**

- Desktop: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/top-header-desktop.png`
- Mobile: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/top-header-mobile.png`
- Desktop pixels and CSS viewport: `1920 × 929`, density `1x`.
- Mobile pixels and CSS viewport: `430 × 900`, density `1x`.
- State: English Overview, profile `web-ai`, runtime running, no active or waiting jobs, output-savings summary ready.

**Comparison evidence**

- Combined source/implementation comparison: `/Users/jazelly/.codex/visualizations/2026/08/21/01a023f2-ad73-7493-baf3-cf0f53d94a16/top-header-comparison.png`.
- The source was resized to `1920 × 536`; the implementation was cropped to the same `1920 × 536` region and stacked below it.
- Full view: the requested operational information now occupies one `70px` global header. Overview begins directly with provider readiness and recent jobs.
- Focused header region: tokens and measured responses are grouped left; runtime and job counts sit centrally; profile switching and System/version sit right.
- Mobile evidence is separate because the source did not specify a mobile state. The `430px` layout retains tokens and profile switching without horizontal overflow.

**Required fidelity surfaces**

- Fonts and typography: existing Inter/system family, weights, and compact UI scale are preserved. Values remain visually stronger than labels.
- Spacing and layout rhythm: the header aligns with the existing `64px` rail and keeps section boundaries in one row. Desktop and mobile have no horizontal document overflow.
- Colors and visual tokens: existing canvas, surface, line, ink, muted, and semantic status colors are reused.
- Image and icon fidelity: no raster imagery is required. Header controls use the installed Lucide icon family and the existing Tokenless mark remains in the rail.
- Copy and content: existing English and Simplified Chinese message keys cover token, runtime, jobs, profile, System, and version labels.

**Interaction verification**

- The real local Dashboard rendered the header at `1920 × 929` and `430 × 900` through `ego-browser`.
- The configured-persistent-browser E2E switched between `work` and `personal` through the new header select and verified URL synchronization.
- Token savings and System/version link to `#system`; runtime and job counts link to `#jobs`.
- The legacy Overview page header, metric cards, and output-savings tile are absent.
- Browser inspection reported no horizontal overflow and no error or exception events.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.

**Comparison history**

- First visual pass passed. No P0/P1/P2 fixes were required after the combined comparison.
- The focused E2E initially assumed profile registry ordering; the assertion was corrected to verify the option set, then the real switch behavior passed. This was test evidence only and did not require a UI change.

**Follow-up polish**

- None required for this slice.

final result: passed
