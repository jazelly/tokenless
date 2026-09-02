# Tokenless API Design Atlas

This Storybook is the code-owned design source for the current Dashboard. It mirrors the production screen hierarchy without importing production views, styles, clients, or runtime data.

## Open the atlas

```bash
npm run design:dev
```

Open `http://localhost:6007/`. Use the sidebar to choose a screen or an isolated component. The Controls panel changes locale, viewport, colors, radius, density, profile, provider, and UI state.

Build the static Storybook with:

```bash
npm run design:build
```

## Boundaries

- Atlas data and provider states are illustrative, not telemetry or capability evidence.
- Page stories render only Dashboard UI. Storybook or design-workbench labels belong in the manager and documentation, never inside the page canvas.
- The Components group owns the reusable profile switcher, buttons, badges, metrics, provider card, and navigation states.
- Profile choices use distinct local Dashboard data so selecting `design`, `studio`, `research`, or `personal` changes the visible page rather than only changing a label.
- Controls update the rendered Storybook canvas; they do not call the Tokenless API daemon.
- Storybook is a coded design workbench, not a freeform Figma canvas. Persistent design changes belong in `DesignAtlas.svelte`, `design-atlas.css`, or the relevant story, then must be implemented separately in the production Dashboard.
