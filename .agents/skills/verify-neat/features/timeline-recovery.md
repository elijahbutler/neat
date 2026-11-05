# Timeline and recovery

Inspect kept edits, undo them with revision checks, and resume a saved pass after restarting the worker. Step 2 proof passed timeline diffs and check labels, newest Undo with a retained Undone row, browser reload of kept work, and worker restart. Supplemental paths below remain unverified.

## Sub-features

- `timeline-details` shows each kept diff, commit, and honest check results.
- `timeline-latest-undo` reverses the newest kept step and marks its row Undone.
- `timeline-earlier-undo` reverses an earlier step while preserving later independent work, and refuses dependent work.
- `recovery-reload` preserves pending work and unconfirmed proposals during browser reload.
- `recovery-restart` restores kept steps in a new worktree from the same pass base.
- `recovery-refusal` preserves external edits and reports incomplete or unreadable saved data.

## How to get to it (user POV)

- Keep a pending edit, then open `History` to see it in `Kept steps`.
- Expand `Code and checks` for a step or choose that step's `Undo` action.
- Reload the browser to revisit the active session.
- Stop the worker, then relaunch the same repository and app with the same `NEAT_HOME` to resume its saved pass.

## Driving it with Playwright

Preconditions:

- Use an owned durable session from the skill with the synthetic heading changed to `A kept browser edit` and at least one kept property edit.
- Define `kept` as `page.getByRole('list', { name: 'Kept steps', exact: true })`.
- Open `inspector.getByRole('tab', { name: 'History', exact: true })` before querying timeline rows. Return to Edit before checking property controls.
- Record the pass ID, base, timeline IDs, current source tree, and saved pass file before restart or Undo.

- Expand each relevant step with `kept.getByRole('listitem').filter({ hasText: 'A kept browser edit' }).locator('summary').click()` when its summary contains that text. Otherwise match the exact step summary returned by the session, then click its `summary`. Require `Code and checks`, the expected added and removed lines, the commit, and `Checked: syntax, typecheck, imports, variants.` with `Not run yet: lint, render.` where those check results apply. Save the actual labels. Existing app diagnostics are a baseline, not evidence that a full suite ran.
- Read the newest step's exact summary and number from the session. Locate its button by the full accessible name `Undo step <number>: <summary>`, substituting those returned values, and click it. Require its row to show `Undone`, its Undo action to disappear, its source change to reverse, and the other kept work to remain. Return to exact Edit and require the selected element's controls to become enabled after inspection refreshes.
- Before an earlier independent Undo check, keep an edit to the home heading and then keep the shared-label change in `components/AcceptanceBadge.tsx`. Undo the home-heading step using its full accessible name. Require the original heading to return, `Confirmed shared label` to remain on both routes, and the earlier entry to show `Undone`. Require a recorded reversal in delivered history. This supplemental setup must avoid later changes that depend on the heading edit.
- For a dependent Undo check, make and keep two edits to the same selected text, then attempt the earlier step's Undo. Require an explanation, unchanged source bytes, and an unchanged timeline. Record this as supplemental unless the runner reports a dedicated assertion.
- In Edit, make a pending edit and run `await page.reload()`. Wait for the native readiness handshake. Require the same session and pending diff with exact `Keep` and `Undo` buttons. Switch to History and Deliver and require those global review controls to remain available. Undo the pending change before continuing. Follow the shared-confirmation recipe separately to prove reload with a proposal.
- Let the runner stop its owned worker and relaunch the same fixture and `NEAT_HOME`. Wait for automatic session attachment and native preview readiness. Require the same pass ID and base, restored kept text and properties, equal restored tree, and `Restored your saved pass.` in a status message. Open History to compare the timeline. Require a fresh session and worktree. Capture source and saved-pass comparisons. Session IDs are temporary and may change.
- Before a supplemental restart with unfinished work, record a pending edit or proposal. After restart require it to be absent and only kept changes to return. Do not expect a browser reload to have the same result.
- For supplemental recovery refusal, modify a recorded sandbox file in an isolated run, then attempt Keep or Undo. Require a refusal and unchanged external bytes. Restart to reconstruct the pass from kept history. For damaged saved data, preserve the original and damaged records outside scratch state before startup. Require a recovery status explaining the skipped file or incomplete restoration. Never treat a newly empty timeline as successful restoration.
- Preserve the before and after session responses, saved pass records in `passes/`, source trees, visible timeline, and worker restart log in the external evidence directory. Read the retained records after cleanup.

## Gotchas

- Pending Undo has the exact accessible name `Undo`. Timeline buttons include the step number and summary.
- The newest kept Undo removes its commit. Earlier Undo records a reversal and can refuse overlap or dependency. Redo is unsupported.
- Check results cover changed files and known consumers. `lint` and `render` marked `not-run` must remain visible as skipped checks.
- Worker restart recovers kept steps only. Preserve the same `NEAT_HOME` through the restart test.
- Saved pass files use atomic replacement. Preserve the exact records and comparisons rather than relying on their timestamps.
- Earlier independent and dependent Undo, pending or proposal browser reload, external-file conflicts, damaged-pass recovery, and unfinished-work restart remain supplemental until exercised. A successful normal restart does not prove refusal or damaged-data handling.
