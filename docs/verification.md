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
