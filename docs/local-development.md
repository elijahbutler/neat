# Local development

Install Node.js 22.12 or newer, Bun, and Git on macOS or Linux. From the repository root:

```sh
bun install
bun run fixtures:install
bun run check
bun bin/neat.ts open fixtures/orbit-studio --port 4400
```

Open the printed URL, create a session, and open the preview. Select an element to inspect its source and edit text or token-backed properties. Direct edits need no key. Set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before launch to use Ask.

The worker bundles the editor client with Bun and processes its CSS with Tailwind. It serves the UI and API on one loopback port. The preview runs separately in a temporary worktree. Ctrl+C stops the preview and removes that worktree. Pass state is currently in memory; branch and patch export remain planned.

Use `bun run typecheck` for a focused type check and `bun test path/to/file.test.ts` for focused tests. The full check needs fixture dependencies. Docker integration tests are optional and run with `bun run test:docker` after building the image described in the [README](../README.md).

The convenience command `bun run editor` opens the same local editor against orbit-studio by default. To inspect extracted data without starting a server, run `bun bin/neat.ts extract fixtures/orbit-studio`.

The optional public component catalogue is configured with `NEAT_LIBRARY_URL`. Without it, the library panel lists the repository's own components and reports the external catalogue as unavailable. The [roadmap](../ROADMAP.md) describes upcoming work.
