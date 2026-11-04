# S4: design system extraction

September 22, 2026. ts-morph 28, TypeScript 5.9, Bun 1.3.13, run on the three fixtures in [`fixtures/`](../../fixtures/README.md).

## Question

Can we read a Next.js repo and produce a useful design system profile, with every claim backed by a file and line, without using AI?

## Answer

Yes, for component inventory, variants, tokens, and usage. On the three fixtures, extraction found every component, every variant group with its default, and every token role the CSS defines, in under a second per repo. The rules step still needs AI to turn facts into readable guidance. The deterministic facts give that step solid, cited input.

## What we built

`neat extract [dir] [--out file.json]` runs the pipeline in [`src/extract/`](../../src/extract):

1. **Components** (`components.ts`). Top-level PascalCase functions that render JSX, in `.tsx`, `.jsx`, and `.js` files. It handles `forwardRef` and `memo` (including `memo(Card)` with a separately defined function), named, default, and anonymous default exports (named after the file), and `export { X }` lists. Props come from the type checker, keeping only props declared in the repo, so HTML attributes from `React.ComponentProps<'button'>` don't flood the list. Any prop typed as a union of string literals becomes a variant group, which covers `cva`, object maps (`keyof typeof intents`), and plain unions. `cva` configs supply defaults. Untyped `.jsx` components fall back to their destructured prop names.
2. **Tokens** (`tokens.ts`). Custom properties from every stylesheet, with scope and line, `var()` references resolved (light values first, cycles stopped), mapped to the same roles as the catalogue token model: seven colors, three fonts, three radii. Missing roles are listed rather than filled with defaults.
3. **Usage** (`usage.ts`, `classes.ts`). Every JSX use of a repo component, resolved through imports to the right definition, with counts of literal prop values. Tailwind classes counted by category (spacing, radius, font size, color) from `className` and from `cn`, `clsx`, and `cva` calls. Arbitrary values and inline `style` objects recorded as token bypasses. Host elements that repeat the same class list three or more times.
4. **Facts** (`facts.ts`). A variant value used in a strict majority of places, a clear most-common radius and font size, token bypasses, repeated class lists, components defined in more than one file, and exported components never rendered. Every fact cites at least one location.
5. **UI libraries.** Which known UI libraries the repo depends on, so the edit agent can reuse them (see [libraries.md](../resources/libraries.md)).

The profile schema is in [`types.ts`](../../src/extract/types.ts). The reference outputs are in [`src/extract/__golden__/`](../../src/extract/__golden__), and a test compares against them on every run.

## Results

| | acme-analytics | orbit-studio | messy-market |
| --- | --- | --- | --- |
| Components found / written | 10 / 10 | 5 / 5 | 5 / 5 |
| Pages and layouts | 3 | 4 | 3 |
| Variant groups (with defaults) | Button `variant`, `size`; Badge `variant`; BillingToggle `initial` | Button `intent`; Section `tone`, `width`; Tag `tone` | none (none written) |
| Token roles mapped | 10 of 13 | 9 of 13 | 3 of 13 |
| Facts | 2 | 3 | 4 |
| UI libraries | `class-variance-authority`, `clsx`, `tailwind-merge` | `class-variance-authority` | none |
| Time (CLI, including startup) | 1.0 s | 0.6 s | 0.6 s |

Facts produced, all checked by hand against the source:

- acme: `Button uses size="sm" in 5 of 9 places`; `text-sm is the most common font size class (4 of 12)`.
- orbit: `Button uses intent="quiet" in 2 of 3 places`; `Section uses tone="paper" in 3 of 4 places`; `text-sm` again.
- messy: 14 token bypasses (7 arbitrary classes, 7 inline styles); `ProductCard is defined in 2 files`; the `<button>` class list repeated 3 times; `rounded` used everywhere.

Usage resolves through imports correctly, including messy-market's two components named `ProductCard`: each page's use is attributed to the file it imports.

## What we changed while reviewing the reference outputs

The first run produced true but misleading facts. "Badge uses `variant="default"` in 1 of 2 places" was a tie broken alphabetically, and "Button uses `variant="default"` in 2 of 9 places" was a plurality. If the agent read those as rules, it would learn conventions that don't exist. Variant facts now require a strict majority, and "most common class" facts need a clear winner used at least twice. Optional prop types no longer repeat `| undefined`, since optionality is its own field.

## Fixes from the independent review

- Next's other route files (`loading`, `error`, `not-found`, `template`, `default`, `global-error`) are now `kind: 'route'`, so they no longer appear as "exported but never rendered".
- `memo(Card)` and `forwardRef(ButtonImpl)` with a separately defined function now resolve to the wrapped function, so the component keeps its name, props, and usage.
- `'use client'` is read from the directive prologue, so a leading comment no longer hides it.
- `text-sm/6` counts as a font size, and `bg-clip-text`, `bg-top`, `bg-bottom`, and `bg-origin-*` no longer count as colors.
- `.js` files with JSX are included.

## Gaps

- ~~**Class strings in plain object maps aren't counted.**~~ Fixed September 23: identifiers in a `className` or class helper are followed to same-file variables, so `className={className}` and maps like `intents[intent]` count their strings, once per definition.
- **Tailwind v3 `tailwind.config` isn't read.** Only CSS custom properties are. All fixtures use Tailwind v4.
- **Dark-mode values aren't mapped to roles.** They're kept in `variables` with their scope, but roles use the light values.
- **Usage counts JSX sites, not rendered instances.** A `<Card>` inside `.map()` counts once.
- **Free-text props are recorded as values.** Copy such as `title="Summer market"` shows up in prop counts. That's harmless for facts, because only variant props produce them, but it adds noise to the profile.
- ~~**Non-token colors aren't linked to tokens.**~~ Fixed September 23: arbitrary color and radius classes, and hex colors in inline styles, record the token with the same value (`bypass.token`), and a `token:<variable>` fact cites them. messy-market's five `#0a7d5a` values now point at `--main-color`.
- ~~**Big repos are untested.**~~ Measured September 23; see Real repos below.

## Real repos (September 23)

Run with `neat`'s extraction and the edit index on shallow clones, dependencies installed with `--ignore-scripts` (shadcn's `apps/v4` without dependencies), on the same Mac. Times cover loading the repo, extracting, and building the index. Memory is the process's peak resident size.

| Repo | Next / Tailwind | Source files | Components | Routes | Render edges | Time | Memory | Facts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| shadcn-ui/taxonomy `298a885` | 13.3 / 3.3 | 125 | 149 | 14 | 116 | 2.8 s | 1.3 GB | 98 |
| vercel/commerce `3761e52` | 15.6 / 4.0 | 64 | 49 | 6 | 60 | 1.0 s | 0.5 GB | 12 |
| shadcn-ui/ui `apps/v4` | 16 / 4 | 3,414 | 5,743 | 22 | 21,928 | 11.8 s | 3.2 GB | 4,215 |

Fixed during the run:

- **Layout sizes counted as bypasses.** `w-[350px]` and `grid-cols-[200px_1fr]` were reported as values that bypass tokens (84 of taxonomy's 90). Only arbitrary values in a token family (color, spacing, radius, font size) count now: taxonomy 13, commerce 4.
- **The repo was loaded twice.** Extraction and the edit pipeline each built their own TypeScript project. `extractDesignSystem` now takes the pipeline's project, which cut taxonomy from 4.2 s and 2.0 GB to 2.8 s and 1.3 GB.

Still open:

- **shadcn's HSL channel tokens aren't colors to us.** `--background: 0 0% 100%` is used as `hsl(var(--background))`, so role names resolve but values can't be matched, and a hardcoded `bg-[hsl(...)]` won't link to its token. Tailwind v4 shadcn (oklch values) is fine.
- **Repos without custom properties get no tokens.** commerce uses Tailwind's default palette, so every role is unresolved. The profile should fall back to the most used palette classes (`neutral-900` and so on) as de facto tokens.
- **Unused-component facts are noisy for UI kits.** taxonomy has 78 "exported but never rendered" facts, mostly shadcn components it installed and never used. They're true, but the profile page should group them, and they never enter the edit context unless they're about the selection.
- **Registry-style repos produce thousands of facts.** `apps/v4` defines the same example in several styles (1,362 duplicate facts, 2,131 unused). It isn't a typical customer app, but the profile page needs ranking and caps.
- **Memory sets the sandbox size.** The TypeScript program with library types takes 0.5 to 3 GB on top of `next dev`. Plan on 4 GB per sandbox for ordinary apps and measure again in S1.

## Decision

This is a good base for M1's extraction pipeline (C04) and for the edit agent's context (S3). Priorities before M1: count classes in object maps, link bypassed values to matching tokens, and run on one or two real open-source Next.js apps to check speed and noise. The AI rules step should take facts as input and cite the same evidence, never invent rules without it.
