# Shared confirmation

Review the routes and source call sites affected by a shared-component edit before applying it. Cancel leaves the source unchanged. The runner paths passed live proof. Supplemental paths below require separate evidence.

## Sub-features

- `shared-impact` identifies the shared component, routes, and render sites before writing.
- `shared-cancel` cancels with the button or Escape while focus is in the confirmation.
- `shared-reload` retains an unexpired proposal across browser reload.
- `shared-confirm` applies saved operations without another model request, then requires Keep or Undo.
- `shared-stale` refuses proposals whose source or configuration changed, or whose lifetime expired.

## How to get to it (user POV)

- Select a rendered element, then use Ask to request a change to its shared component definition.
- A direct property edit inside a shared definition can also require confirmation. Editing a single component instance does not necessarily change the definition.
- In the impact panel, choose `Change everywhere`, `Cancel`, or press Escape while the confirmation has focus.

## Driving it with Playwright

Preconditions:

- Use the isolated synthetic fixture and its local provider. `components/AcceptanceBadge.tsx` renders `Shared acceptance label` on `/` and `/about`.
- Require no pending change. Select `preview.getByRole('heading', { level: 2, name: 'Shared acceptance label', exact: true })` with a native click before the deterministic scripted Ask.
- Save the shared source bytes, worktree tree, and provider call count before opening a proposal.

- Fill `page.locator('#ask')` with `acceptance shared label`, then click `page.getByRole('button', { name: 'Ask', exact: true })`. The Ask label names the selected element or component. Require the heading `Change AcceptanceBadge everywhere it is used?`. Require source `components/AcceptanceBadge.tsx`, routes `/` and `/about`, and `page.getByRole('list', { name: 'Places AcceptanceBadge is rendered', exact: true })` with both render sites. Require the shared source bytes and both rendered labels to remain unchanged.
- Click `page.getByRole('button', { name: 'Cancel', exact: true })`. Require the confirmation to disappear, no pending change, and unchanged source, tree, and timeline. Open another proposal, focus its heading with `page.getByRole('heading', { name: 'Change AcceptanceBadge everywhere it is used?', exact: true }).focus()`, and press `Escape`. Require the same no-write result. Escape in the preview is a different entry point and does not prove confirmation cancellation.
- Open a fresh proposal and run `await page.reload()`. Require the same proposal ID in the read-only session response and the same impact panel. This proves browser reload persistence only. Record the local provider count after proposal creation.
- Choose `page.getByRole('button', { name: 'Change everywhere', exact: true }).click()`. Require the proposal to close, the visible `Confirmed shared label`, a pending diff for `components/AcceptanceBadge.tsx`, and an unchanged provider count. Choose exact `Keep`. Require the kept shared-source diff in the timeline.
- Navigate using `await page.getByLabel('Page', { exact: true }).fill('/about')` followed by `.press('Enter')`. Require `preview.getByRole('heading', { level: 2, name: 'Confirmed shared label', exact: true })`. Navigate back to `/` the same way and require that label there too. Compare the saved shared source with the pending and kept diffs.
- For a supplemental stale-source check, open a proposal in a fresh isolated run and change only a recorded source file in that run's worktree. Click exact `Change everywhere`. Require an alert, no applied proposal, and preservation of the external bytes. Preserve the failed response and source comparison. Configuration changes and a newly added consumer require separate checks. Do not mutate a user's checkout to create this condition.
- Capture the proposal, each cancellation path, reload, confirmation response, provider count, source diff, and both routes in the external evidence directory. Mark a direct-edit entry or stale-proposal entry skipped when the runner does not exercise it.

## Gotchas

- The synthetic provider accepts `acceptance shared label` exactly and targets the shared definition. Changing the Ask wording does not create an equivalent fixture.
- Confirmation is a named section, not a modal dialog. Use its heading, list, and exact button names.
- Proposals expire after ten minutes and reject changed source or configuration. Browser reload preserves only a proposal that remains valid.
- The worker keeps proposals in memory. A worker restart must discard an unconfirmed proposal.
- Keep and Undo are separate from confirmation. A confirmed shared change is still pending until kept.
- Direct shared property edits, expiry, source drift, and configuration drift remain supplemental until their own actions and results appear in evidence.
