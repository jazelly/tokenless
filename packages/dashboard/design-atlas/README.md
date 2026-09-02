# Tokenless API Design Atlas

This Storybook is the code-owned design source for the current Dashboard. It mirrors the production screen hierarchy without importing production views, styles, clients, or runtime data.

## Open the atlas

```bash
npm run design:dev
```

Open `http://localhost:6007/`. Use the sidebar to choose a screen and the Controls panel to change locale, viewport, colors, radius, density, profile, provider, and illustrative state.

Build the static Storybook with:

```bash
npm run design:build
```

## Boundaries

- Atlas data and provider states are illustrative, not telemetry or capability evidence.
- Controls update the rendered Storybook canvas; they do not call the Tokenless API daemon.
- Storybook is a coded design workbench, not a freeform Figma canvas. Persistent design changes belong in `DesignAtlas.svelte`, `design-atlas.css`, or the relevant story, then must be implemented separately in the production Dashboard.
