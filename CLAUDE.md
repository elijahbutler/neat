# Contributor guidance

Use Bun to install dependencies, run TypeScript scripts, and test this repository. Node.js 22.12 or newer is still required for the target Next.js development process.

Read [README.md](README.md), [ROADMAP.md](ROADMAP.md), and [local development](docs/local-development.md) before changing the editor. The editor client is bundled by Bun from `src/app/editor/standalone.tsx`; `src/worker/server.ts` serves the UI and API together.

Run `bun run fixtures:install` before the full test suite, then `bun run check`. Prefer focused tests while editing. Do not start a server or run a production build unless the task calls for it. Stop session processes and remove temporary worktrees after manual checks.

Keep changes focused. Preserve the target repository's components, styling conventions, and package manager. Do not introduce `any` unless necessary. Never commit credentials, environment files, build output, or session state.

Before adding a UI dependency, read [library guidance](docs/resources/libraries.md), check what is already installed, and explain why the dependency is needed. Use CSS for simple transitions and respect reduced-motion preferences.
