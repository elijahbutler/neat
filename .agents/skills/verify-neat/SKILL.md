---
name: verify-neat
description: Verify the Neat Labs local editor through its browser UI, including selection, edits, shared confirmation, saved passes, recovery, and local delivery. Use after editor changes or when reproducing a user workflow.
---

# Verify Neat

Live browser proof on 2026-11-05 passed all 14 declared runner phases for the step 2 workspace. Cleanup completed, the input snapshots matched before and after delivery and teardown, and the evidence remained available. Proof includes native Reload preserving the query and fragment in a fresh document, actual preview process failure logs, and Try again restoring the same kept pass in a new session. Each feature recipe distinguishes these proved paths from unverified supplemental checks.

The final 14-phase run also proved route-bound late Keep. It held the actual About navigation and Keep responses, waited for the destination document and native bridge readiness, then released Keep. The inspector stayed at `Nothing selected` with no home-page property controls. Navigation back home and further editing succeeded. This case is included in `coverage.text`; it adds no coverage phase. Route changes during other mutation types remain supplemental.

Read [the feature map](features/README.md) before choosing coverage. The editor is the primary user path. API reads and Git inspection provide a second view of its results. Direct API mutations, injected selection messages, and internal state setters do not prove browser behavior.

## Launch

Run commands from the repository root. Requirements are Node.js 22.12 or newer, stable Bun 1.3.13 or newer, Git, installed project and fixture dependencies, and an externally supplied Playwright module exporting `chromium`. Reuse installed dependencies. If dependencies are absent, report the missing preparation. The documented preparation commands are `bun install` and `bun run fixtures:install`. Do not install browser tooling into this repository or run a production build.

Inspect existing listeners and processes first. Port 4400 is reserved for the user's pilot. Never connect the runner to that instance, stop it, or reuse its saved data. Use the runner's disposable Git application and fresh `NEAT_HOME`. Two workers must never share a saved pass.

When a verification launch is authorized, run:

```sh
NEAT_BROWSER_DRIVER=/path/to/playwright/index.mjs bun scripts/verify-editor.mjs --port 4460 --provider-port 4462 --evidence /path/to/neat-evidence
```

The configurable paths identify an existing Playwright module and an external evidence directory. Use a new evidence directory for each run. Ports 4460 and 4462 are the coordinated editor and scripted-provider defaults. The preview uses the real automatic allocator, starting at 4100 and choosing a free loopback port. There is no `--preview-port` option. Inspect the actual editor and preview URLs rather than assuming a fallback port.

The runner owns launch, readiness polling, browser actions, worker restart, and teardown. It has no attach mode. It creates a synthetic Next.js app in a temporary Git repository and uses prepared fixture dependencies. It supplies fake credentials to a local provider through `OPENAI_BASE_URL`. This exercises Ask through the production HTTP adapter without a live model account. Keep real credentials out of that environment. Confirm the provider URL is loopback in the run record.

The browser defaults to Playwright's executable lookup. Supply `--browser-executable /path/to/chromium` when an existing browser needs an explicit path. Add `--headed` only when a display is available. Read `bun scripts/verify-editor.mjs --help` for the final runner contract. Do not invent flags or silently substitute another fixture when preparation fails.

For a separately authorized manual reproduction using the bundled fixture, the exact launch is:

```sh
NEAT_VERIFY_HOME="$(mktemp -d /tmp/neat-verify-home.XXXXXX)"
NEAT_HOME="$NEAT_VERIFY_HOME" bun bin/neat.ts open fixtures/orbit-studio --port 4460
```

Record `NEAT_VERIFY_HOME` before restarting and reuse it instead of running `mktemp` again. The worker prints `Editor: http://127.0.0.1:<allocated-port>/editor` before preparing preview dependencies. Open that URL to follow startup. Wait for a ready session and the preview bridge before selecting elements. Use this manual path only for direct edits unless you have an explicitly configured local scripted provider. The synthetic runner fixture has its own headings and shared components. Do not use Orbit Studio text selectors against it.

## Doctor

Before driving a running instance, establish ownership from the process handle, launch arguments, temporary fixture, and `NEAT_HOME` recorded by this run. An answering port alone does not establish ownership. If those records are missing, stop driving and inspect. Never claim an unrelated listener.

Use this read-only check against the actual owned editor origin. The default origin is shown here:

```sh
curl --fail --silent --show-error http://127.0.0.1:4460/api/editor/startup
```

The startup response follows `StartupState` in `src/worker/startup.ts`. Its `phase` is `idle`, `preparing`, `dependencies`, `restoring`, `starting`, `ready`, or `failed`. Active phases include `startedAt`; failure also includes `error`. Capture a failure before retrying. A fast run can skip visible intermediate phases.

Read `GET /api/editor/sessions` until one session appears with this run's disposable repository as its `fixture`. An empty list during preparation is expected. Poll `GET /api/editor/sessions/<id>` using that returned ID until `state` is `ready`. Require a loopback `previewUrl` and `pass.durable: true`. The page automatically attaches when the session appears. Require the `Neat Labs` header and matching preview iframe. Selection also waits for the preview's native readiness handshake; startup `ready` alone is insufficient. Never inject a ready message to bypass it.

On failure, capture startup and session responses and `GET /api/editor/sessions/<id>/logs` when a session exists, then inspect the worker log. These endpoints need no sign-in. Host and Origin must match the allocated editor origin.

The API has no build-revision endpoint. Use `report.json` and `checkout.diff` to identify the launched source. The report records source HEAD and status, runtime metadata, runner arguments, and the diff's SHA-256. Runtime metadata separates `bunNodeCompatibility` from the actual `node` version and `nodeExecPath` selected by the sanitized launch PATH. `nodeProvenance` identifies this as a probe before CLI launch. Its launch records include the worker command and PID and the preview's recorded process identity. Require the SHA-256 of `checkout.diff` to match `source.diffSha256`. Do not infer the running revision from the checkout alone. GET reads provide observations; keep feature mutations in the browser.

## Drive

Run the acceptance runner above for its reported coverage. Its source covers consecutive direct edits, delayed inspection after Undo, full iframe reload before and after an Ask response, shared confirmation, history, restart, and branch and patch equivalence. Require a successful report before claiming these ran. Treat a missing assertion, skip, or failed precondition as an unverified entry.

The proved `workspaceRecovery` phase extends the earlier 13-phase runner to 14 phases. It checks native Reload with a query and fragment, displayed logs after stopping the owned Next.js preview process, and Try again restoring the same kept pass in a new session. The runner verifies the preview's recorded process identity before stopping it. This is an actual process failure. Native bridge timeout and Reconnect preview remain supplemental and unverified.

For an owned manual browser session, use standard Playwright calls. `page` is the editor page supplied by the browser session:

```js
const preview = page.frameLocator('iframe[title$=" preview"]');
const inspector = page.getByRole('complementary', { name: 'Inspector' });
const kept = page.getByRole('list', { name: 'Kept steps', exact: true });
const delivery = page.getByRole('region', { name: 'Deliver this pass' });
```

Use native `click`, `dblclick`, `fill`, `press`, and `selectOption` calls. Use `page.getByLabel('Page', { exact: true })` for route entry, then press `Enter` or choose `Go to page`. Choose exact `Interact` to follow links normally and exact `Select` to edit. Each button selects its named mode. Require the chosen button's `aria-pressed` value to be `true`. Preview width buttons have exact names `desktop`, `tablet`, and `phone`.

Open properties and Ask with `await inspector.getByRole('tab', { name: 'Edit', exact: true }).click()`. Choose `History` before querying `Kept steps` and `Deliver` before querying `Deliver this pass`. The `Inspector sections` tablist uses Left and Right arrows to move and select, Home for Edit, and End for Deliver. Inactive tabpanels are hidden. The selected-element summary, shared confirmation, and pending Keep and Undo remain outside the tabpanels. Verify their behavior while switching tabs.

The [five feature recipes](features/README.md) name the remaining controls and expected results. Wait for visible state and real API responses, then verify the preview's content or computed style. A successful edit response alone does not prove that HMR rendered it or preserved selection. The runner explicitly orders full iframe navigation against the Ask response. Controlled HMR response ordering needs separate evidence that delays the actual hot-update responses. Record every route delay and release it during failure cleanup.

## Evidence

Keep proof in the external directory supplied with `--evidence`. The coordinated artifact contract is `report.json`, `checkout.diff`, `worker.log`, `browser.json`, `trace.zip`, `desktop.png`, `tablet.png`, `final.png`, `pending-phone.png`, `failed-preview.png`, `retried-preview.png`, `delivery.patch`, `passes/`, and `delivery.bundle`. Failed runs also retain `failure.png` when browser capture is available. Artifacts for steps never reached may be absent. Record that absence as a failure or skip. Verify the report and every applicable artifact still exist after teardown.

Each launch records an observed startup response in `report.launches[].startup`. When progress is visible, the runner also records `startupVisible` and captures `startup-<launch-number>.png`. These are opportunistic observations. Missing intermediate phases or an absent startup capture do not prove a failure or full startup coverage. Compare the actual phase and visible text; do not report every startup phase as tested from a successful launch.

The proved run observed `dependencies` in both launch responses. Only the first launch recorded visible dependency progress and retained `startup-1.png`. The second launch has no startup capture. Preserve that distinction when reporting startup evidence.

The controlled preview failure and retry retain `failed-preview.png` and `retried-preview.png`. Compare `report.previewRetry.sessionId`, `passId`, and `process` with the preceding launch records. Require a new session, the same kept pass, and the new preview's recorded process identity. A capture of the failure panel alone does not prove the logs or restored work. Require the UI log text to equal the real session logs response and the kept heading to return.

For each feature ID and entry point, preserve the action, expected result, observed result, and pass, fail, or skip status. Include the command, revision and working diff, owned process IDs, allocated origins, browser version, viewport, relevant response bodies, browser errors, and worker exit status. Keep accessibility or DOM snapshots before and after the action alongside the trace. Store all captures outside tracked public files.

Confirm side effects independently. Compare pending versus kept source, saved pass data, and the timeline. Before and after delivery, compare the input repository's HEAD, branch, status, and index bytes. Apply the exported patch in another disposable worktree with `git am -3` and require its tree to equal the delivered branch's tree. Preserve the patch and tree IDs before removing that worktree.

The local scripted provider is an external-model boundary stub. Capture its request count before and after `Change everywhere` to prove confirmation reuses saved operations. Do not stub editor mutations, Keep, Undo, Git delivery, or the preview bridge. A passing stubbed Ask proves integration behavior, not live model output quality. Local branch and patch delivery never authorize `Open pull request`, a push, or any other publication.

## Cleanup

The runner must close its browser, stop its provider and worker, wait for worker teardown, and remove its temporary worktrees and scratch repository after success or failure. Use only the process handles and paths it created. Never kill by process name or by an unrelated occupied port. During a manual run, use Ctrl+C in its own worker terminal, or signal its recorded PID with `SIGTERM`, and wait for shutdown. Clicking `Stop` removes a preview session but leaves the worker running.

Copy required pass records, logs, patches, Git comparisons, and the cleanup result into the external evidence directory before deleting scratch state. Keep the same `NEAT_HOME` through a restart test. Delete only this run's temporary data after proof collection. Keep all evidence after teardown, including failure artifacts.

Check the recorded worker, provider, and preview PIDs directly for exit. Verify the recorded session worktree is gone, then list and open the report, trace, and patch from the evidence directory. If cleanup fails, report the owned resources still present and preserve their identities. A run that deletes its evidence has not completed verification.

## Helpers

`scripts/verify-editor.mjs` is the acceptance runner owned by the implementation task. Invoke it with Bun as shown under Launch. The configured `NEAT_BROWSER_DRIVER` is an existing module with the standard Playwright `chromium` API. No helper or dependency is installed by this skill. Read the runner's help and report when interpreting a new run.

Use `/maintain-verification-skill` when workflows or controls change. Update the map, runner coverage, and proof status together. A new run verifies only the entries it actually exercises.
