# Startup and workspace

Open the editor while its preview starts, choose how to use the preview, and move between editing, history, and delivery. Step 2 proof passed the runner's Select and Interact paths, ArrowRight, End, Home, initial tab empty states, full URL Reload in a fresh document, actual preview failure logs, and Try again restoring the same kept pass. Startup observations cover dependency preparation only. Supplemental paths below remain unverified.

## Sub-features

- `workspace-startup` shows preparation and automatically attaches the session when it appears.
- `workspace-ready` enables selection only after the preview's native readiness handshake.
- `workspace-modes` separates selecting elements from ordinary app interaction.
- `workspace-tabs` exposes Edit, History, and Deliver with mouse and keyboard navigation.
- `workspace-global-review` keeps pending review and shared confirmation reachable across tabs.
- `workspace-reload` reloads a fresh preview document while preserving the pathname, query, and fragment.
- `workspace-reconnect` reports a bridge timeout and retries its connection. This path remains unverified.
- `workspace-retry` displays actual logs after the owned preview process fails and restores kept work through Try again.

## How to get to it (user POV)

- Open the URL printed by `neat open` while the app prepares. The workspace attaches to the preview automatically.
- Choose `Select` to inspect and edit elements or `Interact` to use links and other app controls.
- Choose `Edit`, `History`, or `Deliver` in the inspector, or move between those tabs with the keyboard.
- Use the `Page` field and `Go to page` to change routes. Use `Reload preview`, or `Reconnect preview` after a connection timeout.
- If the preview fails, expand `Startup logs`, then use `Try again` to reopen it.

## Driving it with Playwright

Preconditions:

- Use the owned isolated run described in the skill. Do not attach to the pilot or an unrelated session.
- Define `preview` and `inspector` as in the skill. Use the synthetic fixture for the exact route and heading checks below.
- Preserve startup responses and browser traces. A fast startup can finish before every intermediate state becomes visible.

- Navigate to the printed `/editor` URL before the session is ready. Read `GET /api/editor/startup` and require a valid `phase` from `StartupState`. While preparation is active, require a visible startup status. An empty sessions list is expected until preparation finishes. Wait for the iframe and enabled mode controls without another `Open preview` click. Require one owned session and the matching fixture.
- Before the native bridge connects, require `page.getByRole('button', { name: 'Select', exact: true })` to be disabled and the preview to report `Connecting to your preview`. After it connects, require the button enabled. Observe the native `neat:hello` and `neat:ready` exchange with the correct frame and origin; never send a fabricated ready message. A ready session response alone does not prove this gate.
- Run `await page.getByRole('button', { name: 'Select', exact: true }).click()`. Require its `aria-pressed` value to be `true`. Select `preview.locator('main h1')` with a native click and require the inspector heading `<h1>`. Click exact `Interact` and require its `aria-pressed` value to be `true` and Select's to be `false`. Follow `preview.getByRole('link', { name: 'About', exact: true })`; require the iframe route `/about` and its shared heading. Navigate back with the exact `Page` field, then choose Select again before editing.
- Use `inspector.getByRole('tablist', { name: 'Inspector sections', exact: true })` to locate the tabs. Click exact `History` and require its `aria-selected` value to be `true` and the named History tabpanel visible. Require Edit's tabpanel hidden. On a fresh pass, require `No kept steps yet`. Click Deliver and require `Keep a change to deliver` before any step is kept. Return to Edit for properties and Ask.
- Focus exact Edit with `await inspector.getByRole('tab', { name: 'Edit', exact: true }).focus()`. Run `await page.keyboard.press('ArrowRight')`; require History focused and selected. Repeat for Deliver, then once more for wrapping to Edit. Test ArrowLeft in reverse. End must focus and select Deliver; Home must focus and select Edit. Require one tab with `tabIndex` zero and the other two with minus one. ArrowRight from Edit, End, and Home were exercised. ArrowLeft, wrapping, and explicit roving-focus assertions remain supplemental.
- Keep one edit, then make another pending direct edit using the editing recipe. Switch between all three tabs and require exact `Keep` and pending `Undo` to remain visible. On Deliver, require local delivery disabled. Settle through those global controls. Repeat with a shared proposal and require `Change everywhere` and `Cancel` to stay reachable while changing tabs. Cancel without a write. Record pending and shared cases separately.
- With a kept change and then a pending edit, click `page.getByRole('button', { name: 'Reload preview', exact: true })`. Require a fresh preview document, a renewed native readiness handshake, the same session and pending source, and enabled review controls after reconnecting. If a controlled connection timeout occurs, require `The preview has not connected` and `Reconnect preview`. Clicking it must retry the current route without discarding pending work. Capture a failure or skip when the timeout setup is unavailable.
- For the extended runner's URL check, fill `page.getByLabel('Page', { exact: true })` with `/?view=compact#team` and press Enter. Wait for exact Select to enable, then click exact Reload preview. Require a fresh iframe document, a renewed native readiness handshake, and the exact iframe URL suffix `/?view=compact#team`. Compare pathname, search, and hash separately.
- Run the acceptance runner's `workspaceRecovery` phase for the controlled failure. It checks the recorded preview PID and start identity before stopping only that run's actual Next.js process. After the worker reports `failed`, the runner reloads the editor. Require `page.getByRole('heading', { name: "The preview didn't start.", exact: true })`. Expand `page.getByText('Startup logs', { exact: true })` and require `.preview-startup pre` to equal the real `GET /api/editor/sessions/<id>/logs` response. Retain `failed-preview.png` and both log observations.
- Choose `page.getByRole('button', { name: 'Try again', exact: true })`. Require one ready session replacing the failed session, the same kept pass, and `A kept browser edit` restored in the preview. Require the native readiness handshake before selecting again. Retain `retried-preview.png` and `report.previewRetry`, including the replacement session, pass, and preview process identity. The proved fourteenth phase covers this actual process failure and retry.
- Preserve startup, mode, tab, focus, reconnect, and global-review evidence alongside the feature IDs. Inspect the report's coverage flags together with the source assertions and trace. The runner checks ArrowRight, End, Home, and the initial History and Deliver empty states within its selection path. Other keyboard paths need separate evidence. `report.launches[].startup`, optional `startupVisible`, and optional `startup-<launch-number>.png` record observed startup state only. They do not assert every phase.

## Gotchas

- The early editor URL means the worker is listening. It does not mean dependency preparation or preview startup has finished.
- A startup `failed` response includes an error and `startedAt`. Preserve it and the terminal log before retrying. Session logs exist only after a session is created.
- A full iframe navigation reconnects the bridge. Wait for mode controls to enable instead of relying on a fixed delay.
- Inactive panels are hidden. Select their tab before using Playwright role queries for history or delivery.
- Arrow keys select and focus a tab immediately. Enter is not needed after moving between tabs.
- Pending Keep and Undo disable during a mutation, opening, or closing. Bridge disconnection alone leaves recovery and delivery available. History and delivery also respect pending changes and shared confirmation. Cross-tab recovery and delivery during disconnection remain supplemental until separately exercised.
- The controlled actual-process failure and Try again are part of `workspaceRecovery`. Missing dependencies, damaged preparation, bridge timeout, full keyboard navigation, pending reload, and global review across tabs remain supplemental until separately exercised.
- The fourteenth phase is proved through the owned preview's actual failure and retry. Native Reconnect preview after a bridge timeout remains unverified.
