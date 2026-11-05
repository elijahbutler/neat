# Editor design

The editor is an Operate surface. Preserve the warm paper palette, thin ink borders, pill controls, and cobalt actions. The preview is the main work area. The inspector keeps selection, pending review, saved history, and delivery distinct.

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

At 1200 pixels and above, the preview fills the available area beside a 392-pixel inspector. Between 900 and 1199 pixels, the inspector is 340 pixels wide and the page control gets its own toolbar row. Below 900 pixels, the preview and inspector form one scrollable column. The preview is at least 360 pixels tall. Fixed preview widths scroll inside the preview area rather than widening the editor. Repository labels show only the directory name.

Select mode captures element clicks and plain-text double-clicks. Interact mode lets the app handle its own links and inputs. Both choices stay visible, with an explicit pressed state. The selection summary names the selected JSX element, source location, and scope. An instance edit and an edit to shared source have different scope text.

The inspector has Edit, History, and Deliver tabs. Edit groups component options, spacing, type, and color and shape controls, followed by stylesheet precedence and optional source details. Ask stays with editing, with compact model setup help. Property and direct text edits work without a model. History contains kept steps and their checks. Deliver contains branch and patch controls, with a clear empty state until the pass has kept work. Switching tabs preserves form values.

Pending changes have a separate review area visible across every tab. Keep and Undo precede expandable code details, whose height is bounded. The pending area stays below the scrolling inspector on desktop and sticks to the bottom while scrolling the inspector on small screens. It states that the change is not committed until kept. The footer distinguishes saved steps from a pending change. Keep, Undo, history undo, and delivery remain available when the preview bridge cannot connect, so a broken preview does not block recovery. Selection edits wait for bridge readiness.

Startup progress uses the worker's actual preparation phase, without a percentage or time estimate. The editor polls startup and sessions before an automatic session appears, then attaches to it. A loaded iframe remains covered and inert until its bridge answers `neat:hello` with `neat:ready`. Hello retries every 500 milliseconds for up to 20 seconds. A timeout offers a reconnect action. Requested navigation waits for the iframe load before accepting another readiness message. Reload preserves the path, query, and fragment; inspection scope uses the pathname. Full iframe loads retain the pending session and selection, but unlock selection only after another handshake. Replay uses worker-confirmed source tags after inspection and mutation completion. A session change or route scope change clears the selected target.

Use native inputs, selects, buttons, and details elements for the current controls. The confirmation panel receives focus, exposes routes and call sites, and supports Escape to cancel. Delivery explains its base commit and shows branch and download results. Loading indicators always have action text; reduced motion disables their spin.

Keep keyboard focus visible with the existing cobalt outline. Tab enters the active inspector tab, Left and Right change tabs, and Home and End choose the first and last tab. Each tab names its associated panel. A skip link reaches the inspector. Native radio inputs support project selection. Use explicit labels and alert or status roles for failures and recovery. Preserve empty, loading, blocked, and completed states. Do not add decorative animation or another component dependency for these surfaces.

A clicked preview outline stays on that element while the pointer moves. Clicking another element switches selection; Escape releases it. Saving freezes selection until the response arrives. A late mutation response restores selection only within the route where it began. Keep the inspector visible, with disabled controls, beside the pending change actions. Property controls explain stylesheet precedence and offer an explicit override rather than silently changing CSS priority.

Verification targets are 1440 by 1000, 834 by 1112, and 390 by 844 pixels, with keyboard navigation and reduced motion. Budgets for this change are zero added dependencies, zero decorative animation loops, one startup poll at a time per endpoint, and no editor-wide horizontal overflow. Browser acceptance must check pending actions, native navigation in Interact mode, consecutive edits, full iframe reload, and history and delivery tab state. These are acceptance targets, not measured performance claims.
