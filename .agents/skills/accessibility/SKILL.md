---
name: accessibility
description: Keep the TS Inspector page usable with a keyboard and a screen reader, to WCAG 2.2 AA. Use when you add or change a control, tab, table, chart, dialog, or colour in src/ui.
license: MIT
metadata:
  origin: adapted from ECC skills/accessibility
---

# Accessibility

## Controls

- Use `<button>` for actions and `<a>` for links. Never a clickable `<div>`.
- Icon-only buttons (the theme switch) need an `aria-label`.
- The import control works with the keyboard and announces the chosen file. The drop zone is not the only way in.
- Visible focus on every control. Do not remove the outline without a replacement.

## Tabs

- Use `role="tablist"`, `role="tab"`, and `role="tabpanel"`, with `aria-selected` and `aria-controls`.
- Arrow keys move between tabs. Tab moves into the panel.

## Tables

- Real `<table>` with `<th scope="col">`. The PID table, check list, and EPG are data tables.
- A clickable error row is reachable by keyboard and says where it goes ("Go to packet 1234").

## Charts

- Each chart has a text equivalent: a caption with the key numbers, or a table toggle.
- Do not rely on colour alone. Errors need a label or icon as well as red.
- Series colours meet 3:1 contrast against the background, in both themes.

## Text and colour

- Body text contrast 4.5:1, large text 3:1, in Light and Dark.
- Status changes (analysis done, error found) go to an `aria-live="polite"` region.
- Respect `prefers-reduced-motion` for the progress bar and transitions.

## Check

- Walk the page with the keyboard only: import a file, open each tab, open an error row, export.
- Run an automated checker (axe or the browser's Lighthouse) on the built page with a fixture loaded. Fix every serious or critical finding.
- Target size at least 24 by 24 CSS px for every control.
