# Design QA

**Source visual truth**

- `/var/folders/q7/shn9fgs933z44trf4ngg_kmw0000gn/T/codex-clipboard-3e988201-a254-4312-8985-e1f651888c51.png`
- Source pixels: `1640 × 1280`, density `1x`.
- The source is a contextual crop of Provider readiness, not a full application viewport.

**Rendered implementation**

- Overview: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00dac-95b3-7112-95cf-5b1a390fd811/provider-modes-overview.png`
- Provider detail: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00dac-95b3-7112-95cf-5b1a390fd811/provider-modes-detail.png`
- Implementation pixels and CSS viewport: `1920 × 1050`, density `1x`.
- State: English, `web-ai` profile, ChatGPT Browser and Direct modes configured.

**Comparison evidence**

- Full view: the implementation preserves the source card, header, row density, provider glyph, name/status hierarchy, readiness dot, and trailing navigation affordance.
- Focused comparison: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00dac-95b3-7112-95cf-5b1a390fd811/provider-readiness-comparison.png`.
- Density normalization: the source Provider readiness region was cropped from `1488 × 1174` and reduced to `744 × 587`; the implementation region was captured at `744 × 587` without scaling.
- The new Browser and Direct badges are intentional additions beside provider names. They fit within the existing first-line space without changing row height or secondary status alignment.

**Required fidelity surfaces**

- Fonts and typography: existing application font family, weights, line heights, and hierarchy are unchanged; badge text uses the existing small UI scale and remains readable.
- Spacing and layout rhythm: the source row height, dividers, glyph alignment, readiness dot, and arrow positions are preserved. Badges use an `8px` name gap and `4px` internal group gap.
- Colors and visual tokens: configured badges reuse the existing semantic green; supported-but-disabled badges use the neutral border; unsupported badges use a dashed neutral treatment and reduced opacity.
- Image and icon fidelity: no raster imagery is required. Browser uses the existing Lucide `Monitor` icon and Direct uses `Link2`, matching the application's current icon family.
- Copy and content: Browser/Direct labels and supporting detail copy are localized in English and Simplified Chinese.

**Interaction verification**

- 45 provider rows rendered 45 badge groups.
- ChatGPT rendered Browser and Direct as configured.
- AI Badgr rendered Browser as not supported and Direct as not configured.
- ChatGPT Direct was disabled, the page was fully reloaded, the disabled state persisted, and the original enabled state was restored.
- Unsupported mode toggles are disabled in Provider detail.
- Browser event queue reported `0` console errors after the verified interactions.

**Findings**

- No actionable P0, P1, or P2 visual differences.

**Comparison history**

- First pass: no actionable P0/P1/P2 findings; no visual correction loop was required.

**Follow-up polish**

- None required for this slice.

final result: passed
