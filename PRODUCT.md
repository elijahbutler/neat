# Neat Labs editor

Neat Labs is a local visual editor for people maintaining Next.js App Router applications. A user selects rendered code, changes text or properties, reviews the result, and keeps steps in a pass. The output is a branch or patch in the user's own components.

A successful session survives a browser reload and a worker restart. It preserves the original checkout, makes shared changes explicit, and reports what it checked. Delivery requires an explicit action. A PR push requires a separate explicit action.

The MVP supports direct edits, optional Ask, an ordered timeline, revision checks, restart recovery, and branch or patch delivery through the default worktree provider. Token-system expansion, workspace-wide component editing, MCP, benchmarking, and broader editor planning remain later work.

The editor is an operating interface. Selection and preview stay visible beside the inspector on desktop. On narrow screens, the preview sits above the inspector. Controls name their action, errors explain recovery, and code details remain expandable.

Interaction targets after the preview is warm are two seconds for selection and ten seconds for a checked edit on small applications. These are product budgets, not measured guarantees or CI thresholds. Dependency installation and the target application's initial compilation are separate costs. Any speed-improvement claim needs measurements on the same repository and environment.
