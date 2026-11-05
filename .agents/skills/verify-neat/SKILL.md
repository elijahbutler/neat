---
name: verify-neat
description: Verify the Neat Labs local editor through its browser UI, including selection, edits, shared confirmation, saved passes, recovery, and local delivery. Use after editor changes or when reproducing a user workflow.
---

# Verify Neat

Live proof completed on the step 1 implementation using the runner's isolated fixture. The report passed every declared coverage phase, cleanup completed, and the input snapshot stayed unchanged. Trace, screenshots, source provenance, saved passes, patch, and branch bundle remained after teardown. Supplemental feature-map paths remain unverified until exercised separately.

Read [the feature map](features/README.md) before choosing coverage. The editor is the primary user path. API reads and Git inspection provide a second view of its results. Direct API mutations, injected selection messages, and internal state setters do not prove browser behavior.

## Launch

Run commands from the repository root. Requirements are Node.js 22.12 or newer, Bun, Git, installed project and fixture dependencies, and an externally supplied Playwright module exporting `chromium`. Reuse installed dependencies. If dependencies are absent, report the missing preparation. The documented preparation commands are `bun install` and `bun run fixtures:install`. Do not install browser tooling into this repository or run a production build.

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

Record `NEAT_VERIFY_HOME` before restarting and reuse it instead of running `mktemp` again. The worker prints `Editor: http://127.0.0.1:<allocated-port>/editor`. That line identifies the worker URL, not a ready preview. Wait for the session's `state` to become `ready` and the preview to render. Use this manual path only for direct edits unless you have an explicitly configured local scripted provider. The synthetic runner fixture has its own headings and shared components. Do not use Orbit Studio text selectors against it.

## Doctor

Before driving a running instance, establish ownership from the process handle, launch arguments, temporary fixture, and `NEAT_HOME` recorded by this run. An answering port alone does not establish ownership. If those records are missing, stop driving and inspect. Never claim an unrelated listener.

Use this read-only check against the actual owned editor origin. The default origin is shown here:

```sh
curl --fail --silent --show-error http://127.0.0.1:4460/api/editor/sessions
```

Require one session whose `fixture` matches this run's disposable repository. Read `GET /api/editor/sessions/<id>` using that returned session ID until `state` is `ready`. Require a loopback `previewUrl` and `pass.durable: true`. Open `/editor` only after ownership is established. Require the `Neat Labs` header and the matching preview iframe. On failure, capture the response and `GET /api/editor/sessions/<id>/logs`, then inspect the worker log. These endpoints need no sign-in. Host and Origin must match the allocated editor origin.

The API has no build-revision endpoint. Use `report.json` and `checkout.diff` to identify the launched source. The report records source HEAD and status, reported Bun and Node versions, runner arguments, and the diff's SHA-256. Its launch records include the worker command and PID and the preview's recorded process identity. Require the SHA-256 of `checkout.diff` to match `source.diffSha256`. Do not infer the running revision from the checkout alone. GET reads provide observations; keep feature mutations in the browser.

## Drive

Run the acceptance runner above for its reported coverage. Its source covers consecutive direct edits, delayed inspection after Undo, full iframe reload before and after an Ask response, shared confirmation, history, restart, and branch and patch equivalence. Require a successful report before claiming these ran. Treat a missing assertion, skip, or failed precondition as an unverified entry.

For an owned manual browser session, use standard Playwright calls. `page` is the editor page supplied by the browser session:

```js
const preview = page.frameLocator('iframe[title$=" preview"]');
const inspector = page.getByRole('complementary', { name: 'Inspector' });
const kept = page.getByRole('list', { name: 'Kept steps', exact: true });
const delivery = page.getByRole('region', { name: 'Deliver this pass' });
```

Use native `click`, `dblclick`, `fill`, `press`, and `selectOption` calls. Use `page.getByLabel('Page', { exact: true })` for route entry and press `Enter` to navigate the preview. `Select` intercepts preview navigation when pressed. Turn it off to follow a preview link normally, then turn it on to edit. Preview width buttons have exact names `desktop`, `tablet`, and `phone`.

The [four feature recipes](features/README.md) name the remaining controls and expected results. Wait for visible state and real API responses, then verify the preview's content or computed style. A successful edit response alone does not prove that HMR rendered it or preserved selection. The runner explicitly orders full iframe navigation against the Ask response. Controlled HMR response ordering needs separate evidence that delays the actual hot-update responses. Record every route delay and release it during failure cleanup.

## Evidence

Keep proof in the external directory supplied with `--evidence`. The coordinated artifact contract is `report.json`, `checkout.diff`, `worker.log`, `browser.json`, `trace.zip`, `final.png`, `delivery.patch`, `passes/`, and `delivery.bundle`. Failed runs also retain `failure.png` when browser capture is available. Artifacts for steps never reached may be absent. Record that absence as a failure or skip. Verify the report and every applicable artifact still exist after teardown.

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
