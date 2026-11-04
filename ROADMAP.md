# Neat Labs roadmap

Neat Labs is a local editor for Next.js App Router repositories. This roadmap lists the work ahead. Historical local experiment measurements are in [docs/spikes](docs/spikes/).

| Milestone | Work | Depends on | Exit gate |
| --- | --- | --- | --- |
| v0.1 M2: Durable passes, revision safety, and shared-component impact | File-backed passes in `~/.neat/passes`; updated source tags after line shifts; file hash checks; immediate shared-component confirmation; affected routes and call sites; consumer typechecks and render checks | Local launcher and editing pipeline | Consecutive edits survive line shifts, restart preserves a pass, and shared edits require confirmation and validate all consumers |
| v0.1 M3: Token hardening and local design system UI | Role-aware and surface-aware matching; Tailwind v3 config, HSL channels, and palette fallback; Design System Profile and Token Drift tabs; one-click replacement; `neat profile` alias | Local extraction and editor | Dark sections use readable tokens, supported styling systems populate controls, and token bypasses can be inspected and replaced |
| v0.1 M4: Branch delivery, read-only MCP, and benchmarks | Three-way patch delivery to `neat/<slug>`; patch export; optional pull request creation; read-only stdio `neat mcp <dir>`; benchmarks on three fixtures and three real repositories | M2, M3 | Passes export without overwriting concurrent checkout changes, read-only tools serve components and tokens, and benchmark results are recorded |
| v0.2: Editor intelligence and variant exploration | Interactive planning; live variant controls; pass forking; element notes; deterministic component insertion; sibling reorder; image references; repository rules | v0.1 | Users can plan structural edits, compare variants, and insert existing components with reviewable changes |
