# Fixture repos

Original Next.js App Router apps used by the S2 and S4 spikes and, later, the edit-agent evals. They're our own code, so they avoid the catalogue's content-permission question (F08). Don't copy catalogue or scraped content into them.

| Fixture | What it exercises |
| --- | --- |
| `acme-analytics` | shadcn-style components with `cva` and `cn`, oklch tokens in `:root`/`.dark` mapped through `@theme inline`, a client component, `next.config.ts` exporting an object |
| `orbit-studio` | A custom design system: object-map variants, one `cva` component, `forwardRef`, default and named exports, `@theme` tokens with custom names, a dynamic route, `next.config.ts` exporting a function |
| `messy-market` | Inline styles, arbitrary Tailwind values, a repeated button class list, two components named `ProductCard`, an anonymous default export, a `.jsx` component, `next.config.mjs` |

Install dependencies with `bun run fixtures:install` from the repo root. Extraction tests need them. Pass `--update` to refresh lockfiles after changing a fixture's `package.json`.

Run one directly with `cd fixtures/<name> && bun run dev`.
