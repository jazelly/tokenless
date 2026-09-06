# Tokenless API Design Atlas

Storybook renders the production Dashboard components and stylesheet with illustrative local data. The application and Atlas both use `src/Dashboard.svelte`; neither maintains a second page implementation.

## Open the atlas

```bash
npm run design:dev
```

Open `http://localhost:6007/`. Choose a page, component, or interaction in the sidebar. Controls switch language, profile, loading/error state, and preview values for the production CSS variables. The viewport toolbar provides desktop and mobile layouts.

```bash
npm run design:build
```

This builds a standalone Storybook in `design-atlas-static/`.

## Where to change a design

| Change | Source of truth |
| --- | --- |
| Navigation, header composition, loading/offline/fatal layout | `src/Dashboard.svelte` |
| Page layout and interactions | `src/views/*.svelte` |
| Shared components, including the profile picker and metric card | `src/components/*.svelte` |
| Palette and semantic color roles | `src/palette.css` → Foundations / Color & units |
| Token unit icon and accessible help | `src/components/TokenIcon.svelte` and `TokenUnit.svelte` |
| Typography, spacing, and responsive rules | `src/styles.css` and component-local styles |
| Product copy | `src/i18n/index.ts` |
| Example data, initial state, and review scenarios | `design-atlas/preview-data.ts`, `preview-state.svelte.ts`, and `*.stories.ts` |

A change to shared UI appears in Storybook and in the next Dashboard build. Controls only change the current preview; save an accepted design in the shared source. Keep wrappers limited to arranging examples, without overriding component typography or colors.

## Boundaries

- `src/App.svelte` owns authentication, polling, real API actions, and application navigation. It passes data and actions to the shared Dashboard.
- Atlas imports the production UI, styles, translations, and display types. Production must never import Atlas data or Storybook code.
- Atlas data is illustrative, not telemetry, provider capability evidence, or benchmark evidence.
- Profile/configuration edits and conversation cancellation affect only the current preview. Changing scenario or reloading resets the example data.
- Browser, provider, harness, and tokenizer operations display an explanatory error instead of contacting real services. Semantic routing remains disabled in the preview.
- Detail and modal stories open the actual product controls. Atlas-only command palettes, cards, badges, and other unimplemented product designs have been removed from the current design catalog.
- Storybook is a coded workbench. Add new product designs in shared UI; use stories to review their states and interactions.

## Verification

`npm run lint --workspace packages/dashboard` checks the application, Atlas, and Storybook configuration together. Verify visible changes in Storybook and the built Dashboard; local example data does not prove backend behavior.

## Color and unit rules

- Base the interface on graphite `#171715` and warm paper `#F6F5F2`; reuse `src/palette.css` instead of introducing chart hex values. Foundations / Color & units displays the actual shared values.
- Category charts use the first seven Tableau 10 colors in published order: blue `#4E79A7`, orange `#F28E2C`, red `#E15759`, teal `#76B7B2`, green `#59A14F`, yellow `#EDC949`, and purple `#AF7AA1`. Keep the fixed family mapping; use Tableau blue for the main series and ColorBrewer Blues[5] for heatmap quantities. Reuse paired heatmap text tokens: level 4 needs pure black to meet 4.5:1 contrast.
- The status palette uses sage, ochre, and clay for success, warning, and failure; these status tokens are separate from category colors. Use their paired surface and border colors, and retain a status label or icon. Provider brand artwork keeps its own identity.
- The circled T with a short crossbar is a product-specific **tokens** unit, not a standardized currency sign. Use `TokenUnit` beside token quantities and `TokenIcon` inside already-labeled controls; preserve full units in accessible labels and help.
- Capability demand uses **requirement counts**, never the token icon. Each distinct capability counts once per finished job, including failed and canceled jobs; a job can count more than once in a family. Zero means connected with no recorded demand; a dash means no demand or connected route.

Data-color roles follow the [Carbon distinction between categorical, sequential, and alert palettes](https://carbondesignsystem.com/data-visualization/color-palettes/); exact category values come from [D3 schemeTableau10](https://d3js.org/d3-scale-chromatic/categorical), and quantity values from [D3 schemeBlues[5] / ColorBrewer](https://d3js.org/d3-scale-chromatic/sequential).
