# MVP verification

The default worktree provider completed the edit, keep, restart, and branch workflow in Chromium on Linux. The original checkout's HEAD, status, and index hash stayed unchanged in every acceptance run. Each exported patch also applied with `git am -3` in an independent worktree and produced the same tree as the delivered branch.

## Current workspace acceptance

The workspace at `11954223e58088d93ed58e0b5ce362d0ec4ff045`, or its recorded working diff before commit, completed fresh Chromium runs on all three fixtures and two public repositories. A third public repository exercised the subsequent CommonJS and preview-framing fixes. Each report records source HEAD and a SHA-256 of the working diff.

| Target | Revision and runtime | Observed result |
| --- | --- | --- |
| Orbit Studio, Acme Analytics, and Messy Market | Bundled fixtures, Next 16.3.5 | Each passed all ten workflow checks and cleanup |
| `vercel/next.js`, `examples/blog-starter` | `409e64fc0687aada39dbab193d37452792246785`, Next 16.4.5 | All ten checks and cleanup passed; Avatar confirmation covered two routes |
| `shadcn-ui/ui`, `templates/next-monorepo`, app `apps/web` | Upstream `8a3536678a528cc012b9e62484290e79d0be410f`; prepared `2f39aed915562a34c4d772454e3355a600ff7b72`; Next 16.4.3 | Nine checks and cleanup passed; sibling-package shared editing was skipped |
| `timlrx/tailwind-nextjs-starter-blog` | `b45bef66b40c63b6f57c15ee8cd090682238df4c`, Next 15.5.12 | Ten workflow checks and framing isolation passed; the strict browser-error gate failed on two reproduced upstream hydration errors |

These runs used Bun 1.4.4 and Chromium 156.0.8078.4. The commands below ran with separate saved-pass directories and a local scripted provider. Paths are placeholders for the owned scratch clones:

```sh
bun --no-env-file bin/neat.ts open /path/to/orbit-studio-copy --port 4480
bun --no-env-file bin/neat.ts open /path/to/acme-analytics-copy --port 4480
bun --no-env-file bin/neat.ts open /path/to/messy-market-copy --port 4480
bun --no-env-file bin/neat.ts open /path/to/nextjs/examples/blog-starter --port 4480
bun --no-env-file bin/neat.ts open /path/to/ui/templates/next-monorepo --app apps/web --port 4480
bun --no-env-file bin/neat.ts open /path/to/tailwind-nextjs-starter-blog --port 4480
```

The blog starter used `bun install` in its app directory. The monorepo used `bunx pnpm@11.25.0 install`, the normal Button generator, and the runtime dependency additions shown in the earlier setup below, with pnpm 11.25.0. Its template stylesheet supplies no finished color theme. The third repository used Bun install and Contentlayer generation before opening. Contentlayer also regenerated its thirteen documents during normal preview startup. No production build ran.

All workflow checks used native selection, inline text edits, visible consecutive padding changes, scripted Ask, pending and latest kept Undo, timeline diffs, browser reload, worker restart, and local branch and patch delivery. Shared confirmation passed on every fixture, the blog starter, and SectionContainer in the third repository. SectionContainer's impact listed nine routes and five call sites. Cancel wrote nothing, and confirmation required no additional provider call. The monorepo's Button lives outside the selected app and remains outside that verified scope.

Every completed workflow produced equal branch and independently applied patch trees. Input HEAD, branch, index, staged and unstaged changes, and untracked bytes matched after cleanup. Preview configuration changes stayed out of delivery.

The additional starter first reproduced a CommonJS configuration import failure, then Chromium's rejection of its original `X-Frame-Options: DENY`. After the bounded fixes, the editor connected while an unrelated parent origin received a CSP framing refusal. The response retained `X-Frame-Options` and every original non-ancestor CSP directive. Its two Headless UI portal hydration errors also reproduced in an uninstrumented worktree with the same dependencies and byte-identical upstream configuration. The strict acceptance report remains failed; its eleven successful checks are recorded separately.

Early runtime records contained Bun's Node-compatibility value. Their correction records distinguish it from a post-run Node 24.22.2 probe. The retained runner now records the actual PATH-selected Node version and executable before CLI launch, separately from Bun's compatibility version.

The final retained runner also passed all fourteen phases with PATH-selected Node 22.12.0, including the preview-framing configuration and corrected runtime metadata. Its report recorded no uncaught browser exception, completed cleanup, and unchanged input snapshots. Real-bundle config-loading tests passed on Node 22.12.0 for CommonJS, native TypeScript, and Next's TypeScript compiler.

Typecheck and the subsequent `bun --smol test --timeout 30000` run passed with 473 tests, 11 Docker skips, and no failures. Regression coverage includes real Node module interop, preserved CSP directives and header precedence, development-only framing, invalid editor origins, and runtime-probe environment isolation.

## Earlier repositories and setup

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

## Editor workspace acceptance

The workspace revision passed all 14 reported browser phases on the isolated fixture. The run observed dependency preparation before automatic session attachment, tested the new inspector tabs with ArrowRight, End, and Home, and exercised native navigation in Interact mode. Desktop, tablet, and phone captures cover selection, pending review, and delivery. The selected outline also matched its element after the phone viewport changed. A delayed Keep response preserved the cleared selection after navigation to another page, and editing continued after returning home.

The extended recovery check reloaded a URL with a query string and fragment and required a fresh preview document with the same URL. It then stopped only the recorded preview process after verifying its identity. The failed-preview panel displayed the actual captured logs. Try again created a new session and restored the same saved pass. Cleanup completed, the original fixture snapshot stayed unchanged, and no uncaught browser exception occurred. Expected console entries include shared-confirmation responses and connection failures during deliberate process stops.

Independent reviews found stale startup responses, delayed cancellation, missing failed-preview logs, and URL loss during reload. Focused regressions and browser checks reproduced those failures before the fixes. The final local run passed typecheck and `bun --smol test --timeout 30000`: 461 passed, 11 Docker tests skipped, and none failed. No dependencies or production build were added. These workspace checks use a synthetic app and scripted model provider; they do not replace the real-repository evidence or establish live model quality.
