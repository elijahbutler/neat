# Neat verification map

This directory is the maintained source for checking the local editor's user workflows. Read [the verification skill](../SKILL.md) for launch, doctor, evidence, and cleanup.

The isolated browser runner passed all 14 declared phases for the step 2 workspace on 2026-11-05. Cleanup completed, evidence remained available, and the input snapshots stayed unchanged through teardown. The proved `workspaceRecovery` phase covers native query and fragment Reload in a fresh document, actual preview process failure logs, and Try again restoring the same kept pass. Each file separately lists unverified supplemental paths. The synthetic fixture uses heading `A page for browser acceptance` and shared heading `Shared acceptance label`.

The final 14-phase run also proved late Keep after navigation to About. It required the actual destination document and ready bridge before releasing Keep, then checked `Nothing selected`, no old property controls, and continued editing after returning home. This case is part of the existing `text` coverage flag.

## Baseline preconditions

- Use the acceptance runner's disposable Git app, isolated `NEAT_HOME`, and local provider stub. The exact invocation is in the skill.
- Reserve port 4400 for the user's pilot. Do not drive it or share its saved pass.
- Require an owned, ready session, a rendered preview with its native readiness handshake, and `pass.durable: true` before editing.
- Read the runner's help and coverage report before interpreting results. Use the synthetic fixture selectors in these recipes for automated runs.
- Start each independent recipe from a fresh fixture unless its preconditions require earlier kept edits.

## Driving conventions

- Use native Playwright browser actions and the exact accessible names in each recipe. API reads can confirm results.
- Scope preview content through `page.frameLocator('iframe[title$=" preview"]')`. Scope property controls through the `Inspector` complementary role.
- Choose the `Edit`, `History`, or `Deliver` tab before querying its controls. Pending review and shared confirmation remain outside those panels.
- Preserve the action and result for every entry point. Mark skipped paths separately. One successful path does not prove the others.
- Keep traces, browser captures, response bodies, pass records, logs, and exported patches in the external evidence directory through cleanup.
- Record viewport, focus, loading, and error behavior when that behavior is part of a recipe. Test desktop and 390-by-844 delivery layout separately.

## Feature entry contract

Each feature file has exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright`, and `Gotchas`. Each driving section starts with `Preconditions:`. Pair each user action with a literal selector or command and an observable result.

## Features

| File | Scope | Proof status |
| --- | --- | --- |
| [Startup and workspace](workspace.md) | Startup progress, preview modes, inspector tabs, full URL reload, and actual preview failure and retry | Runner paths proved; bridge timeout and supplemental paths unverified |
| [Selection and editing](selection-editing.md) | Native selection, inline text, properties, Keep, pending Undo, and selection across reload or route changes | Runner paths and route-bound late Keep proved; supplemental paths unverified |
| [Shared confirmation](shared-confirmation.md) | Impact review, Cancel, Escape, reload, confirmation, and stale proposals | Impact, Cancel, confirmation, and About route proved; supplemental paths unverified |
| [Timeline and recovery](timeline-recovery.md) | Diffs, checks, newest and earlier Undo, reload, worker restart, and recovery refusal | Details, newest Undo, kept reload, and restart proved; supplemental paths unverified |
| [Delivery](delivery.md) | Local branches, collisions, patch download, tree equivalence, input preservation, and responsive controls | Branch, patch, tree equivalence, input preservation, and responsive checks proved; supplemental paths unverified |

The runner's report must identify which of these entries ran. Live model quality, publication, optional container previews, and extraction CLI behavior are outside this first editor map. Add a recipe before claiming coverage for another user path.
