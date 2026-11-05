# Neat Labs editor

Neat Labs edits a running Next.js app using its own components. Keep changes in a durable pass, return after restarting the editor, and deliver a local branch or patch without changing your original working tree or index.

## Install and open a project

Requirements: macOS or Linux, Node.js 22.12 or newer, Bun, and Git. The target must use Next.js 14 to 16 App Router with `app/` or `src/app/`. Install the target's dependencies and complete any required code generation first.

```sh
git clone https://github.com/elijahbutler/neat.git
cd neat
bun install
bun bin/neat.ts open /path/to/your-app
```

For an app inside a repository:

```sh
bun bin/neat.ts open /path/to/repository --app apps/web --port 4400
```

Open the printed editor URL. The editor binds to `127.0.0.1:4317`, or the next free port. The preview starts on a separate loopback port from 4100. Port 3000 stays available. The client bundles with Bun at launch; no production build is required.

The preview starts from a committed revision in a detached Git worktree. Your original files, index, and current branch stay unchanged, including uncommitted work. Commit changes you want included in a new preview first. Only open repositories you trust: their Next.js configuration and development code run on your machine.

## Make and keep changes

1. Click an element in the preview to inspect it. Double-click plain text to edit it in place. Use the property panel for supported classes and component options.
2. Review the preview change, then choose **Keep** or **Undo**. An applied change is not saved until you keep it.
3. To use Ask, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` before launching. Direct edits need no key. Keep keys outside version control.
4. If a change reaches a component definition, review its affected routes and source call sites. **Change everywhere** applies the saved operations without another model call. **Cancel** writes nothing.
5. Expand **Code and checks** in the timeline to inspect a step's diff and check results. Each kept step has its own Undo action.

Checks compare new syntax and type diagnostics, imports, and variant values against the code before the edit. They cover changed files and consumers found through the JSX render graph. Existing diagnostics do not block an otherwise valid edit. Lint and render checks are marked as not run; the editor does not claim to have run the application's full validation suite.

Undoing the newest kept step drops its commit. Undoing an earlier step records a reversal and preserves later independent work. If later steps overlap or depend on it, Undo refuses and explains which work must be taken back first.

Undo actions cannot be redone. Reversal commits remain in delivered history.

## Resume after a restart

Close the browser without stopping the preview, or press Ctrl+C to stop the worker and remove its temporary worktree. Run the same command again to resume the latest saved pass for that repository and app, at its original base commit.

Pass files live at `${NEAT_HOME:-~/.neat}/passes/<repo-hash>/<pass-id>.json`. Each contains ordered summaries, diffs, check results, and SHA-256 hashes before and after every touched file. Writes use a temporary file and rename. Unreadable pass files are skipped without blocking startup. A restore notice reports any step that could not be recovered; the saved file remains intact.

Pending changes and unconfirmed proposals are not saved across worker restarts. File changes outside the editor cause apply, Keep, or Undo to refuse rather than overwrite them. Restart to rebuild the preview from kept steps. Confirmations expire and reject changes to their source or configuration.

The worktree provider reuses installed dependencies when lockfiles and relevant manifests match. It can copy a generated local lockfile when no committed lockfile exists and the manifests match. It copies untracked `.env*` files into the sandbox. Initialize apps that require generated assets before opening them; Neat starts Next directly rather than running custom preparation scripts.

## Deliver a pass

Keep or undo the change in progress, then use **Deliver**:

- **Create branch** creates `neat/<slug>` from the pass base. If your checkout advanced, **Start from** also offers its current commit. Neat applies the kept commits with `git format-patch` and `git am -3` in a separate temporary worktree. Conflicts create no partial branch. Existing names receive a numeric suffix.
- **Export patch** writes a mailbox patch under `${NEAT_HOME:-~/.neat}/exports` and provides a download link. Apply it on a suitable branch with `git am -3 /path/to/file.patch`.
- **Open pull request** appears when the GitHub CLI is installed and authenticated. Clicking it explicitly pushes the delivered branch to `origin`, then opens or reuses a pull request. Creating a branch or patch never pushes. Deliver again after keeping or undoing more steps before opening a PR.

Created branches and patch files remain after stopping the editor. The delivery panel remembers them through browser reloads, but its delivery record is currently in memory. After a worker restart, create the branch again to restore that record; collision handling preserves the earlier branch.

## Current limits

Editing focuses on source files owned by the selected app. Workspace dependency resolution supports pnpm and hoisted Next installations, but selecting and editing component definitions outside the app directory remains limited. MDX content, runtime-generated markup, and dynamic text may not map to an editable source element.

Tailwind v3 configuration, semantic color roles, dark-surface matching, and tokens from workspace stylesheets need more work. Text and supported spacing controls still work when token lists are incomplete. Inspect the preview before keeping a style change.

Pages Router, native Windows outside WSL2, and non-Next.js frameworks are outside the support contract. Concurrent workers editing the same saved pass are not coordinated across processes. See [verification](docs/verification.md) for the tested repositories, setup, and remaining gaps, and the [roadmap](ROADMAP.md) for forward work.

The optional Docker preview is experimental and is not part of the durable-pass and delivery workflow. Use the default provider for saved passes and branches. Docker integration checks require a running Docker service:

```sh
docker build -t neat-sandbox:dev -f sandbox/Dockerfile .
bun bin/neat.ts open /path/to/your-app --docker
```

## CLI pipeline

Extraction and validated edits are also available without opening the editor:

```sh
bun bin/neat.ts extract ./your-app
bun bin/neat.ts context ./your-app app/page.tsx:12:7
bun bin/neat.ts edit ./your-app ops.json
```

## Contributing

Use Bun. Run `bun run fixtures:install`, then `bun run check`. Prefer focused tests while editing. See [local development](docs/local-development.md) and [library guidance](docs/resources/libraries.md). The worker is in `src/worker`, the editor client in `src/app/editor`, and sandbox providers in `src/sandbox`. Extraction and source tagging live in `src/extract` and `src/tagging`.

## License

MIT. See [LICENSE](LICENSE).
