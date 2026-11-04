# Neat Labs editor

Neat Labs lets you edit a running Next.js app using your own components and tokens. It runs your repository in an isolated Git worktree, maps preview elements to source, and checks edits before you keep them. The goal is a clean branch you can review. Branch and patch delivery is still planned; current session commits are temporary.

## Install and run

Requirements: macOS or Linux, Node.js 22.12 or newer, Bun, and Git. The target app must use Next.js 14 to 16 App Router with `app/` or `src/app/`.

```sh
git clone https://github.com/elijahbutler/neat.git
cd neat
bun install
bun bin/neat.ts open /path/to/your-next-app
```

Open the printed editor URL. The editor binds to `127.0.0.1:4317`, or the next free port. The preview uses a separate loopback port starting at 4100, leaving port 3000 available. Use `--port 4400` to choose the editor's starting port and `--app apps/web` for a monorepo app.

The default provider creates a detached worktree under `~/.neat/sessions`, or `$NEAT_HOME/sessions`. It copies untracked `.env*` files and reuses dependencies only when lockfiles match. Install dependencies in your target repository first for an offline launch. Otherwise its lockfile selects the package manager used to install them. Only open repositories you trust: their development scripts run on your machine.

Extraction, inspection, direct text edits, and token-backed property edits work without an API key. To use Ask, set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment before launch. Keep keys outside version control.

For a Docker preview, build the optional sandbox image and pass `--docker`:

```sh
docker build -t neat-sandbox:dev -f sandbox/Dockerfile .
bun bin/neat.ts open /path/to/your-next-app --docker
```

Docker must be running. Docker with `--app` is not supported yet. The editor client bundles with Bun at launch. Ctrl+C stops preview processes and removes the session worktree.

## Current limitations

This is an early local editor. Session state is in memory, and accepted commits stay isolated in temporary worktrees. Save any work you need before stopping the editor. Durable passes, revision safety, shared-component impact previews, stronger token matching, and branch or patch export are on the [roadmap](ROADMAP.md). Pages Router, native Windows outside WSL2, and non-Next.js frameworks are outside the current support contract.

The CLI also exposes the extraction and edit pipeline:

```sh
bun bin/neat.ts extract ./my-next-app
bun bin/neat.ts context ./my-next-app app/page.tsx:12:7
bun bin/neat.ts edit ./my-next-app ops.json
```

## Repository layout

| Path | Purpose |
| --- | --- |
| `bin/neat.ts` | CLI entry point |
| `src/app/editor/` | Editor client, bundled by Bun |
| `src/worker/` | Local HTTP server, sessions, inspection, and edits |
| `src/sandbox/` | Worktree and optional Docker preview providers |
| `src/tagging/` | Development-only source tags and selection bridge |
| `src/extract/` | Components, variants, tokens, usage, and cited facts |
| `src/edit/` | Context, validated edit operations, checks, and model adapters |
| `src/tokens/` | Token models and utilities |
| `src/catalogue/` | Client for the public [component library](https://github.com/elijahbutler/neat-labs) |
| `fixtures/` | Original Next.js apps used by tests and local sessions |
| `sandbox/Dockerfile` | Optional Docker preview image |
| `docs/spikes/` | Local experiments and recorded measurements |

## Contributing

Use Bun for this repository. Run `bun run fixtures:install`, then `bun run check` before submitting a change. Keep changes focused and cover changed behavior with tests. See [local development](docs/local-development.md) for a fixture session and [library guidance](docs/resources/libraries.md) before adding UI dependencies.

## License

MIT. See [LICENSE](LICENSE).
