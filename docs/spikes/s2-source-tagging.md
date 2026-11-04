# S2: source tagging on Next 16

September 22, 2026. Next.js 16.3.5, React 19.3.0, Node 24.16.0, Bun 1.3.13, macOS. Raw numbers are in [s2-results.json](s2-results.json).

## Question

Can we tag every rendered element with the file and line that produced it, in a Next 16 dev build, without changing the customer's source files, and keep hot reload working?

## Answer

Yes. The loader approach works under both Turbopack and webpack. Across seven routes on the three fixtures, every rendered element resolves to a source location, no tag points at the wrong line, and an edit shows up with a correct tag within about 100 ms under Turbopack and 300 ms under webpack. The loader adds no measurable startup time. We'll use the Babel-based loader. The SWC-plugin option isn't viable today.

## What we built

- `src/tagging/tag-source.ts` parses a `.tsx`, `.jsx`, or `.js` file with `@babel/parser` (TypeScript syntax only for `.tsx`) and inserts `data-nl-src="path:line:col"` on host elements and `data-nl-inst="path:line:col"` on component elements. It only inserts text, so line numbers don't move, and it returns a source map. A file that doesn't parse, such as one mid-edit, passes through unchanged so Next shows its own error.
- `src/tagging/loader.ts` wraps the transform as a webpack-style loader. Turbopack and webpack both run it. It skips `node_modules` and anything outside the project root.
- `src/tagging/with-tagging.ts` adds a development-only Turbopack rule for `*.tsx`, `*.jsx`, and `*.js` (`create-next-app --js` puts JSX in `.js` files), and the equivalent webpack rule. It keeps any rules and `webpack()` function the customer already has.
- `src/tagging/inject.ts` rewrites a copy's `next.config.*` so its original export is wrapped by `withNeatTagging`. It handles `export default` (objects and functions) and `module.exports`, wrapping the last `module.exports` assignment so plugins that re-wrap it (Sentry, next-intl) survive, in `.ts`, `.mts`, `.mjs`, `.js`, and `.cjs` configs, and writes `next.config.mjs` when there's none.
- `src/tagging/bundle.ts` builds the loader (CommonJS) and wrapper (ESM) into `.neat/`, which is what a sandbox would drop in.
- `scripts/spikes/s2-source-tagging.ts` copies each fixture to a temp directory, installs, injects, runs `next dev`, fetches every static route, checks each element's tag against the source line, then edits a heading and polls every 50 ms until it reappears with the right tag. `--no-tagging` runs the same startup without the loader, as a baseline.

## Results

Coverage was identical under both bundlers. Hot reload was faster under Turbopack.

| Fixture | Config | Route | Elements | Tagged directly | Inherited | Untagged | Wrong location | Component tags |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| acme-analytics | `next.config.ts` (object) | `/` | 35 | 94% | 2 | 0 | 0 | 25 |
| | | `/pricing` | 62 | 97% | 2 | 0 | 0 | 25 |
| orbit-studio | `next.config.ts` (function) | `/` | 40 | 75% | 10 | 0 | 0 | 9 |
| | | `/about` | 17 | 71% | 5 | 0 | 0 | 4 |
| | | `/work/harbor-coffee` | 16 | 69% | 5 | 0 | 0 | 4 |
| messy-market | `next.config.mjs` | `/` | 32 | 88% | 4 | 0 | 0 | 3 |
| | | `/cart` | 16 | 75% | 4 | 0 | 0 | 3 |

| Fixture | Ready, Turbopack (no tagging) | Ready, webpack (no tagging) | Hot reload, Turbopack | Hot reload, webpack |
| --- | --- | --- | --- | --- |
| acme-analytics | 3.4 s (3.4 s) | 5.0 s (5.2 s) | 95 ms, tag correct | 324 ms, tag correct |
| orbit-studio | 3.8 s (3.4 s) | 5.0 s (5.0 s) | 100 ms, tag correct | 301 ms, tag correct |
| messy-market | 4.0 s (3.3 s) | 5.0 s (4.8 s) | 91 ms, tag correct | 280 ms, tag correct |

"Ready" is from spawning `next dev` to the first successful response from `/`, which includes compiling it. Hot reload is from writing the edit to fetching HTML that contains it, polled every 50 ms, so it's accurate to about 50 ms. Tagged and untagged startup times overlap across repeated runs (an earlier tagged Turbopack run gave 3.3, 3.4, and 3.7 s), so at this size the loader's cost is within noise.

## Findings

- **Every "inherited" element is explained.** There's one `<div hidden>` per page that Next injects itself. All the others are `<a>` elements rendered by `next/link`. Those come from `node_modules` so they have no `data-nl-src`, but `next/link` passes our `data-nl-inst` through to the `<a>`, so a click on a link still resolves to the exact `<Link>` line. This is why orbit-studio has lower direct coverage: its cards and nav are all `next/link`.
- **Component tags reach the DOM when the component spreads props onto its root.** shadcn-style components (`{...props}`) and `next/link` do. Components that pick their props, such as orbit's `Button` and `Section`, drop `data-nl-inst`. Their inner elements are still tagged with their definition file, so selection works. What we lose is a direct link from the rendered element to the place the component is used. The editor can recover it from the component's definition plus the extracted usage sites (S4), or we could pass the instance location through context in a later version.
- **Symlinked paths broke tagging at first.** On macOS, `/tmp` and `/var/folders` are symlinks into `/private`. The bundlers pass the loader real paths, so a root given as the symlinked path made every file look outside the project and nothing was tagged. Injection and the loader now both resolve the real path. A Linux sandbox may hit the same thing with bind mounts. Tests cover both places.
- **TypeScript configs become CommonJS.** Next compiles `next.config.ts` to CommonJS, which turns the wrapper's `import()` into `require()`, and `require()` rejects `file://` URLs. The wrapper now imports by absolute path. `require()` of an ES module file works because Node 22.12 and later support it, so **the sandbox image needs Node 22.12 or newer.**
- **SWC plugin check.** The only maintained candidate, `swc-plugin-component-annotate` 1.18.0 (the one Sentry uses), adds the component name and source file name but no line or column. It's compiled against `swc_core` 77, while Next ships its own SWC build, so plugins break when Next upgrades. We found no maintained plugin that records line and column. Writing our own Rust plugin would have the same upgrade problem. Not pursued.
- **The copy-tree fallback wasn't needed.**
- **Review fixes.** An independent review of the branch found that configs assigning `module.exports` twice lost their plugins, JSX in `.js` files wasn't covered, and the first hot-reload numbers were really the 500 ms polling interval. All three are fixed and the numbers above are from the rerun.

## Decision

Use the Babel-based loader injected through a rewritten `next.config`, on both Turbopack and webpack. Keep the copy-tree approach written down as the fallback in case a future Next release stops running custom loaders on app files.

## Consequences for M2

- The rewritten `next.config.*` and the `.neat/` directory are changes inside the sandbox's working copy. Session commits must never include them. Add `.neat/` to `.git/info/exclude`, and mark the config with `git update-index --skip-worktree` before the agent starts.
- Pin Node 22.12 or newer in the sandbox image.
- This spike checked server-rendered HTML. The M2 browser check still has to confirm client-side Fast Refresh keeps tags on client components after an edit, and that tagging causes no hydration warnings. Both bundles run the same loader, so we don't expect a mismatch, but we haven't observed it in a browser.
- Measure loader overhead on a large repo (several hundred components) during S1, since the fixtures are too small to show it.
- A customer rule that already matches `*.tsx` gets ours appended in a list. Turbopack's behavior for two matching rule objects wasn't tested, because no fixture has one.
