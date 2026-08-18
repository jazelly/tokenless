# Design QA

**Source visual truth**

- `/var/folders/q7/shn9fgs933z44trf4ngg_kmw0000gn/T/codex-clipboard-1c30754e-0e96-46ec-b16c-02c0552fe62f.png`
- Source pixels: `1312 × 1646`, density `1x`.
- State: old successful job detail with a long internal task ID, raw result JSON, empty error rendered in red, null details, and raw provider-attempt JSON.

**Rendered implementation**

- List: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00f0d-db54-7eb3-9137-7c8b7e94b000/chat-history-final-list.png`
- Routed detail: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00f0d-db54-7eb3-9137-7c8b7e94b000/chat-history-final-detail.png`
- Long-title detail: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00f0d-db54-7eb3-9137-7c8b7e94b000/chat-history-final-long-title.png`
- Narrow detail: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00f0d-db54-7eb3-9137-7c8b7e94b000/chat-history-final-mobile.png`
- Desktop pixels and CSS viewport: `1920 × 1050`, density `1x`.
- Narrow pixels and CSS viewport: `430 × 900`, density `1x`.
- State: English, two completed API conversations; one uses Direct and a 256-character provider title, and one uses Browser with ChatGPT-to-Gemini fallback.

**Comparison evidence**

- Combined source/implementation comparison: `/Users/jazelly/.codex/visualizations/2026/08/17/01a00f0d-db54-7eb3-9137-7c8b7e94b000/chat-history-comparison.png`.
- The source and implementation represent the same successful-detail purpose but different viewport proportions and content. The comparison therefore judges the requested hierarchy and failure corrections rather than pixel-for-pixel placement.
- Full view: the new list uses short chat titles, provider identity glyphs, Browser/Direct mode, approximate total tokens, status, and time without horizontal overflow.
- Focused detail: the old raw operational dump is replaced by a readable User/Assistant transcript; technical JSON remains available in one collapsed disclosure.

**Required fidelity surfaces**

- Fonts and typography: the existing application family and weight scale are preserved. Long list titles and modal titles truncate with ellipses; the close control remains visible.
- Spacing and layout rhythm: the wide dialog is `880px` on desktop and `430px` at the tested narrow viewport. Metadata wraps, conversation bubbles remain readable, and neither viewport has horizontal document overflow.
- Colors and visual tokens: existing neutral surfaces and semantic status colors are preserved. A successful job with no error no longer renders a red error container.
- Image and icon fidelity: no imagery is required. Provider identity uses the repository's existing monogram-glyph pattern with provider-specific color treatments; standard controls continue to use the installed Lucide icon family.
- Copy and content: Chat history, Browser/Direct, estimated total tokens, conversation roles, provider-chat link, and technical-details copy are localized in English and Simplified Chinese.

**Interaction verification**

- Opened both seeded chat rows and closed/reopened the modal.
- Mixed-provider detail rendered `ChatGPT` and `Gemini` identities in attempt order and showed `Browser`.
- Direct detail showed `Gemini` and `Direct`.
- User and assistant transcript messages matched the stored prompt and visible provider response.
- Successful details rendered zero `job-error-summary` elements.
- Desktop and narrow detail views had no document overflow; the modal close control remained inside the viewport.
- Long modal title overflowed only its own ellipsis box, not the header or document.
- Browser event inspection reported zero `Runtime.exceptionThrown` events and zero error-level `Log.entryAdded` events.

**Findings**

- No actionable P0, P1, or P2 visual differences remain.

**Comparison history**

- First pass found a P1 stale-daemon compatibility failure: missing new fields rendered untitled rows and `NaN` token values. The list now accepts only real prompt-backed chat jobs and guards absent numeric/provider fields; the current daemon capture has no `NaN` or false rows.
- First pass also found a P2 transcript-label mismatch: the User bubble included flattened System content. Public transcript extraction now selects the final user turn, and the final routed-detail capture shows only the user prompt.
- Post-fix desktop and narrow captures passed with no remaining P0/P1/P2 findings.

**Follow-up polish**

- Provider monograms can be replaced with packaged official brand assets in a separate brand-asset slice if trademark-ready source files are supplied.

final result: passed
