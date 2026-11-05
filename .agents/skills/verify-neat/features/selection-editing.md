# Selection and editing

Select a rendered element, edit its text or supported properties, review the result, and keep or undo it. The runner paths passed live proof. Supplemental paths below require separate evidence.

## Sub-features

- `select-lock` keeps the clicked outline on its element while the pointer moves elsewhere.
- `select-switch-clear` switches selection on click and clears it with Escape in the preview.
- `text-inline` edits plain text by double-click, then commits with Enter or blur and cancels with Escape.
- `property-consecutive` edits the same selected element repeatedly across Keep, pending Undo, and HMR.
- `property-override` makes the explicit stylesheet override visible and reversible.
- `ask-insert` applies a scripted Ask and follows the heading after source lines move.
- `edit-ordering` preserves selection when a full iframe reload happens before or after the edit response.

## How to get to it (user POV)

- Open the preview at `/` with `Select` pressed, then click an element to populate the inspector.
- Double-click a plain-text heading in the preview to edit it in place.
- Choose a property in the inspector, then choose `Keep` or the pending change's `Undo`.
- Type into the selected element's Ask field and choose `Ask`, or press Enter. Shift+Enter inserts a line break.

## Driving it with Playwright

Preconditions:

- Launch the isolated acceptance runner from the skill. Its initial `main h1` reads `A page for browser acceptance`.
- Define `preview` and `inspector` as in the skill. Require no pending change or shared proposal.
- Require the owned scripted provider for Ask. Direct edits require no model key.

- Select the heading with `await preview.getByRole('heading', { level: 1, name: 'A page for browser acceptance', exact: true }).click()`. Require the inspector heading `<h1>` and the selected outline. Hover `preview.getByText('Hover here while the heading stays selected.', { exact: true })`. Require `[data-neat-overlay]` in the preview to retain the heading's bounding rectangle, allowing the overlay transition to settle.
- Switch selection and focus the preview with `await preview.getByText('Hover here while the heading stays selected.', { exact: true }).click()`. Then run `await page.keyboard.press('Escape')`. Await deselection with `await inspector.getByText('Click anything on the page to see which component and line it comes from. Double-click text to edit it.', { exact: true }).waitFor({ state: 'visible' })`. Reselect the heading before editing.
- Edit with `await preview.getByRole('heading', { level: 1, name: 'A page for browser acceptance', exact: true }).dblclick()`. Wait for `preview.locator('[contenteditable]')`, fill it with `A kept browser edit`, and press `Enter`. Require `Source updated. Review the preview`, the new visible heading, and an enabled `Keep` button. Choose `page.getByRole('button', { name: 'Keep', exact: true }).click()`. Require a kept timeline entry and the same selected heading.
- Exercise the other text exits on a fresh draft. Press `Escape` in the contenteditable element to restore its previous text without a pending change. Repeat using blur to submit, then choose `page.getByRole('button', { name: 'Undo', exact: true }).click()` to discard the pending edit. Require the kept text to return. This exact `Undo` name excludes the timeline buttons.
- Verify the stylesheet baseline using `getComputedStyle` on the selected heading. The synthetic fixture sets its padding to `17px`. Check `inspector.getByRole('checkbox', { name: 'Override app styles for new changes', exact: true })`, then use `inspector.getByRole('combobox', { name: 'Padding, all sides', exact: true }).selectOption('6')`. Require visible `24px` padding, a pending diff, and the disabled inspector remaining visible. Keep it. Select value `8` without clicking the preview again. Require `32px`, then pending Undo restoring `24px` with selection still on the heading.
- For Ask, fill `page.getByRole('textbox', { name: 'Change this h1', exact: true })` with `acceptance insert before heading`, then click the exact `Ask` button. Require `Inserted by scripted Ask` before the heading, a pending diff, and preserved selection. Keep or undo before the next edit. The local provider accepts this exact instruction.
- Run `NEAT_BROWSER_DRIVER=/path/to/playwright/index.mjs bun scripts/verify-editor.mjs --evidence /path/to/neat-evidence` for a full iframe reload before and after a delayed Ask response. Require separate checkpoints for both orders in `report.json`, plus subsequent property editing without reselection. Capture browser errors and the trace. Controlled HMR ordering requires separate hot-update delays and evidence. Full navigation alone does not prove that race.
- For the separate bundled manual fixture, use the exact launch in the skill and heading `We design brands that people remember`. Its text and stylesheet differ from the synthetic fixture. Record that entry point separately and do not apply the synthetic `17px` baseline to it.

## Gotchas

- `Select` blocks ordinary preview link navigation. Use the editor's `Page` field, or turn selection off before following a link.
- Wait for the contenteditable element before filling it. Filling the preview's DOM without native double-click does not test inline editing.
- Plain-text editing refuses mixed children, empty text, and whitespace-preserving content. These refusal paths need their own prepared fixture and proof.
- Utility controls display classes, not computed values. The synthetic stylesheet override check depends on its `acceptance-heading` rule.
- Overlapping mutations must remain disabled. Record errors and focus behavior instead of retrying blindly.
- Selection switching and clearing, text cancellation, blur submission, refusal states, and the bundled manual fixture remain supplemental until the report explicitly covers them.
