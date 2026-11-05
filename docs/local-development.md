# Local development

Install Node.js 22.12 or newer, Bun, and Git. From the repository root:

```sh
bun install
bun run fixtures:install
bun run check
NEAT_HOME=/tmp/neat-dev bun bin/neat.ts open fixtures/orbit-studio --port 4460
```

Open the printed URL while the preview prepares its dependencies and restores saved work. The page attaches to the session automatically. Wait for the preview to connect and **Select** to become available. Choose **Select**, then double-click a heading to edit its text and keep the change. Open **Edit** to change a property and keep it too. Choose **Interact** to follow links and use the app normally.

Use **History** to inspect each diff and its checks, or undo a saved step. An undone row remains visible as **Undone**. Pending **Keep** and **Undo** controls and shared-change confirmation stay visible when you switch tabs. The tablist supports Left and Right arrows, Home, and End.

Startup is readable at `GET /api/editor/startup` before a preview session exists. Its `phase` reports preparation, dependency setup, saved-pass restoration, app startup, readiness, or failure. Selection also waits for the preview bridge to connect. If that connection times out, use **Reconnect preview**. **Reload preview** reloads the current preview route without restarting the worker. These controls preserve a pending change in the active session.

Stop the worker with Ctrl+C, then repeat the same command and `NEAT_HOME` value. The kept steps return in a fresh worktree. Browser reloads preserve the active session, including a pending change or confirmation. Worker restarts recover only kept steps.

Open **Deliver**, then use **Create branch** or **Export patch** to deliver the pass. A branch is built through a separate temporary worktree and never checks out in the original repository. The explicit **Open pull request** action can push, so use a local test repository without a remote when testing delivery without publishing.

Direct edits need no key. Ask uses `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` from the launch environment. Tests use a scripted client and temporary Git repositories, with no network. Keep real keys outside version control.

The worker bundles `src/app/editor/standalone.tsx`, processes the editor CSS, and serves the UI and API together. The preview runs on another loopback port. Stop verification workers when finished; the provider stops their Next processes and removes their session worktrees. Delete the chosen temporary `NEAT_HOME` only after saving any passes you need.

Run `bun run typecheck` and focused `bun test path/to/file.test.ts` checks while editing. Before publishing, run `bun run check`. Docker tests are optional with `bun run test:docker`, and Docker is outside the durable delivery workflow.

`bun run editor` opens orbit-studio through the same worker. `bun bin/neat.ts extract fixtures/orbit-studio` inspects extracted data without starting a server. The optional public catalogue uses `NEAT_LIBRARY_URL`; otherwise the library panel lists local components and reports the external catalogue as unavailable.

See [verification](verification.md) for the acceptance scope, [product intent](../PRODUCT.md), [design](../DESIGN.md), and the [roadmap](../ROADMAP.md).

## Browser acceptance

Use `scripts/verify-editor.mjs` to drive an isolated editor through Chromium. Supply an existing Playwright module and browser installed outside this checkout. The runner adds no project dependencies and never attaches to an existing editor session.

```sh
NEAT_BROWSER_DRIVER=/path/to/playwright/index.mjs bun scripts/verify-editor.mjs \
  --port 4460 --provider-port 4462 \
  --browser-executable /path/to/chromium \
  --evidence /tmp/neat-browser-proof
```

Choose a new evidence directory for each run. Run `bun scripts/verify-editor.mjs --help` for the options. The preview uses the normal port allocator. The runner creates its own fixture repository, saved-pass directory, and local scripted model endpoint with fake credentials. It does not use a live model service or publish a pull request.

Read `report.json` for asserted coverage and remaining gaps. The trace, desktop, tablet, and mobile captures, source revision and diff, pass files, exported patch, and branch bundle remain after cleanup. Startup captures are opportunistic; the report records the phase and visible progress observed for each launch. Those observations do not establish coverage of every startup phase. A successful run must also report completed cleanup and unchanged input files and index. A failed run exits nonzero and retains its evidence.

The `workspaceRecovery` phase extends the earlier 13-phase runner to 14 phases. It uses native Reload on `/?view=compact#team`, stops the owned preview process after checking its identity, compares the displayed startup logs with the real API response, and uses **Try again** to restore the same kept pass. Its artifacts include `failed-preview.png`, `retried-preview.png`, and replacement session and process identities in `report.previewRetry`. The 2026-11-05 workspace run passed all 14 phases, completed cleanup, and preserved the exact input snapshot through teardown.

The maintained [verification skill](../.agents/skills/verify-neat/SKILL.md) and [feature map](../.agents/skills/verify-neat/features/README.md) distinguish proved startup, preview, tab, and recovery paths from supplemental checks. Native **Reconnect preview** after a bridge timeout remains unverified. Treat proof status as specific to the entries actually exercised.

The final 14-phase run also proved route-bound late Keep in its `text` phase. It held the actual About navigation and Keep responses, waited for the About document and ready preview bridge, then released Keep. The inspector stayed at **Nothing selected** with no old property controls. Returning home and continuing edits succeeded. Route changes during other mutation types remain supplemental.
