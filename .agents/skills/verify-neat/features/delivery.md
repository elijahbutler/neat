# Delivery

Create a local branch or download a patch from kept steps while preserving the input checkout and index. The runner paths passed live proof. Supplemental paths below require separate evidence.

## Sub-features

- `delivery-branch` creates a branch from the pass base without checking it out in the input repository.
- `delivery-collision` keeps the original branch and assigns a numeric suffix to a repeated name.
- `delivery-patch` downloads a mailbox patch whose applied tree equals the delivered branch.
- `delivery-blocked` disables delivery during pending work or confirmation and invalidates stale branch publication.
- `delivery-reload` restores the delivery panel through browser reload while distinguishing worker restart.
- `delivery-layout` keeps controls usable at desktop and 390-by-844 sizes, including keyboard focus.

## How to get to it (user POV)

- Keep an edit in a durable pass to show `Deliver` inside the inspector.
- Set `Branch name` and `Start from`, then choose `Create branch` or `Export patch`.
- Follow the resulting `Download` link to save the patch.
- After another kept edit, create a branch again to deliver the current steps.

## Driving it with Playwright

Preconditions:

- Use only the runner's disposable Git repository and isolated `NEAT_HOME`. Keep at least one edit and settle any pending change or proposal.
- Define `delivery` as `page.getByRole('region', { name: 'Deliver this pass', exact: true })`.
- Record input HEAD, symbolic branch, porcelain status, staged and unstaged diffs, and SHA-256 of the index bytes before delivery. The synthetic fixture deliberately contains staged, unstaged, and untracked input.

- Set `await delivery.getByRole('textbox', { name: 'Branch name', exact: true }).fill('browser-acceptance')` and `await delivery.getByRole('combobox', { name: 'Start from', exact: true }).selectOption('pass')`. Click `delivery.getByRole('button', { name: 'Create branch', exact: true })`. Require a created `neat/browser-acceptance` branch and an unchanged input snapshot. Read the actual returned branch name and tree from the disposable repository.
- Click `Create branch` again with the same name. Require a different branch with the numeric collision suffix, the first branch's unchanged commit, and the same delivered tree. Keep both refs in the retained `delivery.bundle` before deleting the scratch repository.
- Click `delivery.getByRole('button', { name: 'Export patch', exact: true })`. Require a link whose accessible name starts with `Download `. Download that actual link through Playwright's download event into external evidence as `delivery.patch`. Record its response and bytes. Do not construct a filename by guessing the export timestamp.
- Apply `delivery.patch` with `git am -3` in another disposable worktree based on the branch's selected delivery root. Require exit code zero and exact equality between `git rev-parse HEAD^{tree}` in the applied worktree and the delivered branch's tree. Also require no preview injection files in the delivered diff. Save the patch, tree IDs, comparison, and bundle before worktree cleanup.
- Start another direct edit without keeping it. Require exact `Create branch` and `Export patch` buttons to be disabled and `Keep or undo the change in progress before delivering.` to appear. Pending Undo must enable delivery again. Repeat for a shared proposal when that entry is covered. After keeping another step, require the previous branch to show the stale-delivery message. If `Open pull request` is present, require it to be disabled. Never click it during local verification.
- Run `await page.reload()` after branch and patch creation. Require the same delivery names and download link in the active session. After a worker restart, require the old branches and exported files to remain on disk. The in-memory delivery panel record does not survive that restart. Create a branch again only when this run needs a new record.
- Run `await page.setViewportSize({ width: 390, height: 844 })`. Require the delivery region and its controls to fit without horizontal page overflow. Focus the exact `Create branch` button and use keyboard navigation between the controls. Capture focus and responsive state. Test the default desktop viewport separately.
- Save the before and after input snapshots and require equality for HEAD, branch, status, staged diff, working diff, and index hash. Preserve `delivery.patch`, `delivery.bundle`, trace, and report after cleanup. These comparisons prove source preservation separately from successful branch creation.

## Gotchas

- `Open pull request` explicitly pushes. This skill's local delivery workflow never authorizes it.
- The `Start from` current-commit option appears only when the input checkout advanced. Testing that alternate base, detached input, and delivery conflicts requires separate disposable setups.
- Branch names can receive collision suffixes. Assert the returned name and tree, not only a success message.
- A downloaded patch is not proof until it applies independently and produces the exact expected tree.
- Browser reload preserves the delivery record. Worker restart preserves branches and patch files, but clears the in-memory record.
- Keep proof artifacts outside the temporary repository and `NEAT_HOME`. Removing scratch state must preserve the exported patch and branch bundle.
- Alternate bases, conflict refusal, stale publication, shared-proposal blocking, and keyboard order remain supplemental until their own assertions appear in evidence.
