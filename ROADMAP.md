# Neat Labs roadmap

## Shipped

- A loopback editor and isolated preview for Next.js App Router apps.
- Durable passes with ordered diffs, check results, restart recovery, and per-step undo.
- Revision hashes and updated source tags for consecutive edits.
- Shared-component impact, explicit confirmation, and deterministic replay without another model call.
- Local branch delivery, downloadable patch series, and an explicit optional pull request action.
- Startup progress, preview readiness, explicit Select and Interact modes, and separate Edit, History, and Deliver tabs.
- An isolated browser acceptance runner with retained traces, screenshots, source provenance, and delivery checks.
- CommonJS configuration loading and development framing for the editor's own loopback origin.

## Forward work

| Milestone | Work | Exit gate |
| --- | --- | --- |
| M3: Token matching and design system controls | Role-aware and surface-aware matching; Tailwind v3 configuration; HSL channels and palette fallback; workspace stylesheets; Design System Profile and Token Drift tabs; replacement controls; `neat profile` | Supported styling systems populate controls, and dark sections use readable tokens |
| Compatibility and pass management | Source selection for workspace component definitions; generated-asset preparation contracts; cross-process pass locking; a pass picker; persisted delivery records; coordinated Docker recovery and delivery | Larger workspaces and multiple workers preserve and expose the same work safely |
| Read-only MCP and benchmarks | Read-only stdio `neat mcp <dir>`; benchmarks on fixtures and real repositories | Component and token tools serve local data without writes; benchmark commands and results are reproducible |
| v0.2: Editor planning and variant exploration | Interactive planning; live variant controls; pass forking; element notes; component insertion; sibling reorder; image references; repository rules | Users can plan structural edits, compare variants, and insert existing components with reviewable changes |

## Observed compatibility follow-ups

- `vercel/next.js`, `examples/blog-starter`, uses Tailwind v3 configuration. Its text and spacing workflow works, but project color tokens are not fully represented in the property panel. Extend M3 extraction rather than guessing replacements.
- `shadcn-ui/ui`, the Next monorepo template, imports its styling and Button from a sibling workspace package. App-owned elements can be edited, but workspace component definitions and their stylesheet tokens need broader source indexing and tagging.
- The `shadcn-ui/ui` documentation app requires generated registry assets before startup. Project-specific preparation is not inferred or run by the launcher.
- `timlrx/tailwind-nextjs-starter-blog` at `b45bef66b40c63b6f57c15ee8cd090682238df4c` reproduces Headless UI portal hydration errors without instrumentation. Retest compatible upstream revisions before claiming clean browser acceptance. Its edit, recovery, framing, and delivery checks completed.

[Verification](docs/verification.md) records the exact acceptance scope. Historical extraction experiments remain in [docs/spikes](docs/spikes/).
