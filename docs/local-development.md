# Local development

Install Node.js 22.12 or newer, Bun, and Git. From the repository root:

```sh
bun install
bun run fixtures:install
bun run check
NEAT_HOME=/tmp/neat-dev bun bin/neat.ts open fixtures/orbit-studio --port 4400
```

Open the printed URL. Select a heading, double-click to edit its text, and keep the change. Change a property and keep it too. The timeline shows each diff and the checks that ran. Undo a step to exercise revision checks and dependency conflicts.

Stop the worker with Ctrl+C, then repeat the same command and `NEAT_HOME` value. The kept steps return in a fresh worktree. Browser reloads preserve the active session, including a pending change or confirmation. Worker restarts recover only kept steps.

Use Create branch or Export patch to deliver the pass. A branch is built through a separate temporary worktree and never checks out in the original repository. The explicit Open pull request action can push, so use a local test repository without a remote when testing delivery without publishing.

Direct edits need no key. Ask uses `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the launch environment. Tests use a scripted client and temporary Git repositories, with no network. Keep real keys outside version control.

The worker bundles `src/app/editor/standalone.tsx`, processes the editor CSS, and serves the UI and API together. The preview runs on another loopback port. Stop verification workers when finished; the provider stops their Next processes and removes their session worktrees. Delete the chosen temporary `NEAT_HOME` only after saving any passes you need.

Run `bun run typecheck` and focused `bun test path/to/file.test.ts` checks while editing. Before publishing, run `bun run check`. Docker tests are optional with `bun run test:docker`, and Docker is outside the durable delivery workflow.

`bun run editor` opens orbit-studio through the same worker. `bun bin/neat.ts extract fixtures/orbit-studio` inspects extracted data without starting a server. The optional public catalogue uses `NEAT_LIBRARY_URL`; otherwise the library panel lists local components and reports the external catalogue as unavailable.

See [verification](verification.md) for the acceptance scope, [product intent](../PRODUCT.md), [design](../DESIGN.md), and the [roadmap](../ROADMAP.md).
