# MVP verification

The default worktree provider completed the edit, keep, restart, and branch workflow in Chromium on Linux. The original checkout's HEAD, status, and index hash stayed unchanged in every acceptance run. Each exported patch also applied with `git am -3` in an independent worktree and produced the same tree as the delivered branch.

## Repositories and setup

| Target | Revision and preparation | Launch command |
| --- | --- | --- |
| Orbit Studio | Bundled fixture; dependencies installed with `bun run fixtures:install` | `bun bin/neat.ts open fixtures/orbit-studio --port 4460` |
| Acme Analytics | Bundled fixture; same preparation | `bun bin/neat.ts open fixtures/acme-analytics --port 4460` |
| Messy Market | Bundled fixture; same preparation | `bun bin/neat.ts open fixtures/messy-market --port 4460` |
| `vercel/next.js` blog starter | `b27317dda6173586a5fb9c979f7159fa12cfabac`; sparse checkout; `bun install` in `examples/blog-starter`; installed Next 16.4.5 | `bun bin/neat.ts open /path/to/nextjs --app examples/blog-starter --port 4460` |
| `shadcn-ui/ui` Next monorepo template | `460ad60d84617836762a8800755fafef37f662df`; sparse checkout; template setup below; Next 16.2.6 | `bun bin/neat.ts open /path/to/ui/templates/next-monorepo --app apps/web --port 4460` |

The monorepo template imports a Button that its generator normally supplies. In the scratch checkout, setup ran these commands from the template root:

```sh
bunx pnpm@10.33.4 install
bunx shadcn@latest add button --yes --cwd apps/web
bunx pnpm@10.33.4 --filter @workspace/ui add class-variance-authority@0.7.1 radix-ui@1.4.3
```

The generated component, dependencies, and lockfile were committed locally before opening the editor. That setup commit was `a2037277e463bd7b4940696e8da1f7fefb05ab89`. It was never pushed. This acceptance run used a prepared template, not an untouched upstream checkout.

Every command used an isolated `NEAT_HOME` that stayed the same across its worker restart. Workers ran one at a time on port 4460. The runtime was Bun 1.3.13 with Node.js 24.22.2. Verification used Playwright installed outside this repository and an existing Chromium headless shell. No browser-test dependency was added to the project.

## Browser actions and observed results

All five targets passed native click-to-select, double-click text editing, a property-panel padding edit, Keep, timeline display, latest-step Undo, browser reload, worker restart, Create branch, and Export patch. The restarted worker restored the same pass in a new worktree. A scripted Ask inserted JSX before the selected heading; a subsequent property edit worked without selecting it again. The delivery panel fit a 390-by-844 viewport, and its Create branch button accepted keyboard focus.

Shared-component confirmation displayed routes and source call sites for Button in Orbit Studio, Badge in Acme Analytics, LegacyBanner in Messy Market, and Avatar in the blog starter. Confirming applied the saved operations with no additional provider call. The blog starter listed `/` and `/posts/[slug]` as affected routes.

The monorepo template had no reachable shared component owned by the selected app in the tested page. Its Button definition lives in a sibling workspace package. Shared confirmation was not verified there. App-owned text and spacing edits, restart, and delivery passed. Broader workspace source selection remains a roadmap item.

A separate browser regression opened a shared proposal, stopped the preview, and opened it again. The old confirmation disappeared and property editing was enabled in the new session.

No model API key was available. Ask used the real HTTP provider adapter against a local scripted provider with fake credentials. These runs verify request handling, operation checks, confirmation, selection updates, and delivery. They do not measure model output quality or verify a live model service.

## Additional local pilot

A locally owned Next.js 15.5.14 App Router project completed the workflow in an isolated worktree. Its original checkout's HEAD, status, and index stayed unchanged. The pilot used Bun 1.4.4 and a local scripted model provider.

Native browser checks covered mixed-content text refusal, editing a plain-text child, visible padding changes, timeline diffs and honest check labels, and browser reload. Shared-component confirmation listed four routes and four source call sites. Escape cancelled without writing. A new untracked consumer invalidated an existing proposal. A valid proposal survived reload and applied without another provider call.

The worker restored the same pass, Git tree, and edit statuses after a restart, including earlier-step undo records. An external sandbox file change produced a refusal and a recovery notice without overwriting those bytes. Undoing an earlier edit preserved a later change in another file. Redo of an undo is unsupported.

Hot-reload checks delayed the API response and hot-update responses separately. Both event orders preserved the selected heading after Ask and pending Undo. Separate Chromium checks exercised native mutation observers with tag changes, replacement nodes, and explicit selection clearing.

Delivery through the browser preserved an advanced, detached, dirty input checkout and its index bytes. Reusing a branch name added a numeric suffix. The downloaded patch applied with `git am -3` in another worktree and produced the delivered branch's exact tree. Preview injection files stayed out of the result. Pending edits disabled delivery, and keeping another edit disabled the stale branch's PR action. No PR action was invoked. The delivery panel fit a 390-by-844 viewport and supported keyboard focus. Live requests also confirmed the Host and Origin guards.

Independent reviews found diagnostic path exposure, an undo staging race, and selection timing issues. Regression tests reproduced those failures before their fixes. Fault-injection tests also verified undo recovery when a save fails after renaming the pass file. The subsequent suite passed with `bun --smol test --timeout 30000`: 442 passed, 11 Docker tests skipped, and none failed. Typecheck passed.

## Selection and stylesheet regression checks

A follow-up Chromium run on the same Next.js 15.5.14 project reproduced a clicked outline following hover, the inspector disappearing during pending review, and a utility class losing to an app stylesheet rule. The fixes keep the clicked outline locked, keep the disabled inspector visible, and provide an explicit app-style override.

The browser verified computed padding changing from 17px to 24px and then 32px, followed by Undo restoring 24px. The second edit required no new selection. Text editing and Keep retained the selected element. Replacing its DOM node after the response preserved its outline. A separate before-and-after browser check reproduced selection loss during a full iframe reload with the previous client. The fixed client restored selection when the reload happened before or after the edit response. Escape in the preview released selection and restored hover targeting.

Delayed inspection responses could not replace a newer selection. Delaying an edit response kept selection locked until completion. A scripted Ask failure disabled competing property edits and preserved selection after the failure. That browser request was stubbed; no live model service was used. These checks recorded no browser exceptions. Browser tooling and its runtime libraries stayed outside the repository.

Independent review found overlapping-request and delayed-text-approval races. Both were fixed, with regression coverage. Typecheck passed, and the subsequent full suite passed with 446 tests, 11 Docker tests skipped, and none failed.

## Automated checks

Before publishing each slice, validation ran:

```sh
bunx tsc --noEmit
bun test
```

The final integration run used Bun 1.3.13 with `bun --smol test --timeout 30000`: 430 passed, 11 Docker tests skipped, and none failed. Default-deadline runs hit timeouts under host contention. A longer deadline alone also timed out; low-memory mode completed the suite. These local flags changed no assertions, and CI keeps its default test command. Typecheck passed.

Regression tests use temporary Git repositories without network access. They cover durable recovery, corrupt pass files, file hashes, shifted selections, shared scope, repeated component instances, transitive consumers, stale proposals, dirty and detached checkouts, advanced HEAD, branch collisions, conflicts, hooks, patch application, symlink races, and explicit PR guards. Delivery tests stub the GitHub CLI and push only to local bare remotes. Repository-binding tests cover SSH alias normalization and a GitHub default repository that differs from the push destination.

Export tests exercise both the Linux directory-descriptor path and the portable process path while swapping the export directory for a symlink. A separate regression swaps the directory before the child starts and verifies that its Bun preload does not run. The helper starts from Neat's own directory with an explicit configuration, then changes directory and checks its identity before file operations. The process path was forced on Linux. A native macOS run remains unverified.

## Limits of this verification

No production build ran. Docker integration tests were skipped. The real Open pull request button was not used, and no acceptance branch was pushed. Live model services, native macOS, Windows, and concurrent workers remain unverified.

The blog starter's Tailwind v3 color configuration and the monorepo's workspace stylesheet tokens do not fully populate property controls. The documentation app in `shadcn-ui/ui` also needs generated registry assets before startup. These limits are recorded in the [roadmap](../ROADMAP.md); this work did not implement the M3 token system.

## Repeatable browser acceptance

The repository now retains `scripts/verify-editor.mjs` and a maintained verification skill and feature map. Two consecutive isolated Chromium runs passed all 13 reported coverage phases. They exercised native selection and text editing, visible stylesheet overrides, consecutive property edits, pending and latest kept Undo, delayed inspection, full iframe reloads in both response orders, scripted Ask, shared confirmation and cancellation, route navigation, browser reload, worker restart, branch creation, patch download, mobile delivery layout, and keyboard navigation.

The delayed-inspection case also reloaded the iframe before releasing the inspection response, then verified the outline and another edit. A separate API regression restored the exact pending bytes after an external-file refusal and successfully retried Undo. The staging-race regression uses a temporary Git executable to rewrite the file immediately before staging, removing dependence on filesystem event timing.

The runner applied each downloaded patch in another worktree and required exact tree equality with the delivered branch. Before and after teardown it compared input HEAD, active branch, index hash, staged and unstaged diffs, and untracked file hashes. Cleanup removed only owned processes and temporary worktrees. Reports, source provenance, traces, screenshots, passes, patches, and branch bundles remained outside the repository.

The model adapter used a local scripted HTTP provider with fake credentials. No live model service or publication action ran. Console records include the expected shared-confirmation refusal responses and connection failures during the intentional worker restart. Neither passing run recorded uncaught browser exceptions. Full iframe reload ordering was exercised; separately controlling hot-update response ordering remains supplemental.

See [browser acceptance](local-development.md#browser-acceptance) for the command and [the feature map](../.agents/skills/verify-neat/features/README.md) for remaining entry points and gaps.
