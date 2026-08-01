# Tokenless Local UI v0

Status: design review complete; implementation pending approval

## Product position

Tokenless is a localhost operational control center, not a marketing dashboard. The interface optimizes for fast recognition and safe configuration with minimal reading.

- Narrative role: configure one managed profile and understand local runtime state.
- Viewing distance: laptop-first, with a 390px mobile layout.
- Visual temperature: quiet, precise, and authoritative.
- Capacity: five primary operational areas plus System in desktop navigation and mobile overflow.

## Reference synthesis

The design combines interaction patterns rather than reproducing one product:

- [Linear display options](https://linear.app/docs/display-options): compact icon actions, keyboard-oriented interaction, and controls revealed in context.
- [Vercel project settings](https://vercel.com/docs/project-configuration/project-settings): stable settings hierarchy and focused editing surfaces.
- [Tailscale local web interface](https://tailscale.com/kb/1325/device-web-interface): a browser-based local configuration surface backed by a local runtime.
- [Tailscale device filters](https://tailscale.com/docs/features/access-control/device-management/how-to/filter): concise operational state, search, and progressive filtering.

## Brand assets

- Mark: `assets/tokenless-mark.png`
- Desktop design: `design/assets/tokenless-local-ui-v0-desktop.png`
- Full HD desktop design: `design/assets/tokenless-local-ui-v1-desktop-1080p.png` (`1920×1080`, 16:9)
- Mobile design: `design/assets/tokenless-local-ui-v0-mobile.png`

## Design system

- Palette: warm off-white `#F7F6F2`, white surface, graphite `#171716`, muted `#74736D`, hairline `#E5E3DD`, black primary action, green only for healthy/connected state.
- Typography: compact neutral grotesk; restrained weights; no remote font dependency.
- Spacing: 4px base with 8px primary rhythm.
- Radius: 6px controls, 8px maximum surface radius.
- Elevation: no routine shadows; hierarchy comes from spacing, surface tone, and hairlines.
- Motion: 160–200ms state transitions; no decorative motion; honor reduced motion.
- Targets: minimum 44px interactive area.

## Information architecture

Desktop uses a 60px icon rail:

1. Overview
2. Profiles
3. Providers
4. Capabilities
5. Jobs
6. System

Mobile keeps the five operational destinations in a bottom icon bar and moves System into the top overflow menu. Profile selection becomes a compact top switcher. The content model remains identical across breakpoints.

The Profiles screen uses master–detail:

- profile list;
- selected profile inspector;
- configuration rows for identity, browser, visibility, providers, and proxy;
- one save action that appears enabled only when the form is dirty.

## Progressive disclosure rules

- Icon-only navigation always has an accessible name; desktop shows a tooltip on hover and keyboard focus.
- Keep field labels visible. Icons do not replace labels when the value would become ambiguous.
- Put explanations, timestamps, evidence, and repair details in popovers, drawers, or dialogs.
- Use a drawer for Proxy details and provider observations.
- Use dialogs only for destructive confirmation, user handoff, or a blocking error.
- Do not show helper paragraphs when a label, value, state, or tooltip is sufficient.
- Do not rely on color alone for status; pair it with an accessible label or icon shape.
- Provider chips show enabled state with both a quiet fill and a check mark.

## Interaction model

- Navigation: icon rail or mobile bottom bar.
- Profile switch: list on desktop, drawer-triggering switcher on mobile.
- Editing: row click opens an inline control or focused drawer.
- Save: disabled when clean, black when dirty, busy state while persisting, then a short success toast.
- More actions: three-dot menu for open browser, make default, and remove.
- Dangerous actions: never appear as a primary inline action.
- Errors: attach to the affected row first; use a toast only for request-level failure.

## Design critique

Overall: 8.8 / 10

- Philosophy alignment: 9.3 — operational, minimal, and free of dashboard decoration.
- Visual hierarchy: 9.1 — profile selection, editable values, and save action scan immediately.
- Craft quality: 8.8 — disciplined spacing and hairlines; real implementation must preserve exact alignment.
- Functionality: 8.7 — edit and enabled-state affordances are now explicit without adding copy.
- Originality: 8.0 — intentionally familiar tool UI, differentiated through Tokenless's warm monochrome system.

Implementation checks:

- Provider chips must wrap rather than shrink below touch-target size.
- Tooltips must work for pointer and keyboard users.
- Mobile connected state needs an accessible text alternative even when only the dot is visible.
- The Save button must not imply unsaved changes when the form is clean.
- Empty, offline, expired-session, loading, error, and disabled states must preserve the same sparse composition.

## Image-generation prompt set

Both designs were generated with the built-in ChatGPT image tool using `assets/tokenless-mark.png` as the brand reference.

Desktop prompt:

> Create a high-fidelity, shippable Tokenless localhost control center focused on editing one managed browser profile. Use a 60px icon-only rail, a compact profile list, and one calm inspector pane. Show only Identity, Browser, Visibility, Providers, Proxy, connection state, and Save changes. Use the Tokenless mark faithfully. Follow a warm off-white monochrome system with hairline separators, compact controls, tooltip-based icon labels, no card wall, no gradients, no charts, no illustrations, no marketing copy, and no remote-brand logos.

Refinement prompt:

> Preserve the desktop design and change only two affordances: add a pencil icon to Identity and show enabled Provider chips with a quiet selected fill plus check marks.

Mobile prompt:

> Translate the approved desktop design into a practical 390×844 mobile web layout. Use a compact top bar, profile switcher, single-column configuration rows, full-width dirty Save action, and a five-icon bottom navigation. Preserve the exact warm monochrome system and add no explanatory copy or new sections.
