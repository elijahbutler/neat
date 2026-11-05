# Editor design

The editor preserves its existing warm paper palette, thin ink borders, pill controls, and cobalt actions. This document describes the current interface rather than introducing a new theme.

| Token | Value | Use |
| --- | --- | --- |
| Ink | `#14130f` | Text and primary borders |
| Page | `#fbfaf6` | Main surface |
| Wash | `#efece3` | Quiet controls and secondary surfaces |
| Rule | `#cfcabc` | Dividers and control borders |
| Quiet | `#6b665c` | Secondary text |
| Cobalt | `#2f4bff` | Primary actions |
| Tint | `#dde2ff` | Selection and context |
| Mint | `#cff3df` | Added code |

Use the existing sans stack for controls, the display stack for the product name, and monospace for source locations and code. The existing theme defines these stacks in `src/app/globals.css`.

On desktop, the preview fills the available area beside a 380-pixel inspector. On small screens, the toolbar wraps, the preview occupies part of the viewport, and the inspector follows in one scrollable column. Repository labels show the directory name, with the full path in a tooltip.

Use native inputs, selects, buttons, and details elements for the current controls. The confirmation panel receives focus, exposes routes and call sites, and supports Escape to cancel. Delivery explains its base commit and shows branch and download results. Loading indicators always have action text; reduced motion disables their spin.

Keep keyboard focus visible with the existing cobalt outline. Use explicit labels and alert or status roles for failures and recovery. Preserve empty, loading, blocked, and completed states. Do not add decorative animation or another component dependency for these surfaces.
