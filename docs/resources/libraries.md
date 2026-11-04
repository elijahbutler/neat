# Preferred libraries

Use existing project libraries before adding a dependency. Install a library only when a concrete editor task needs it.

## Adopted

| Need | Library | Where it's used | Status |
| --- | --- | --- | --- |
| Drag and drop | [dnd-kit](https://dndkit.com) (`@dnd-kit/core`) | Dragging components from the library panel onto the page, reordering (E03). Drop targets live in the editor overlay, positioned from the preview bridge, so the drag never has to cross into the iframe. | Planned |
| Command palette | [cmdk](https://cmdk.paco.me) | ⌘K for editor actions and component search in the library panel (P03, E03) | Planned |
| Toasts | [Sonner](https://sonner.emilkowal.ski) | Save, rebase, pull-request, and failed-run notices (E05, E06) | Planned |
| Icons | [Lucide](https://lucide.dev) (`lucide-react`) | All UI icons. Use the editor icon style. | Installed |
| Animation | [Motion](https://motion.dev) (import from `motion/react`, not `framer-motion`) | Panel and request-card transitions that CSS can't do well, such as layout animation when cards reorder | Add when CSS isn't enough |

## Maybe later

| Library | Possible use | Decide when |
| --- | --- | --- |
| [TanStack Table](https://tanstack.com/table) | Design system profile page: components, props, usage counts, sorting and filtering | The profile page outgrows a plain table (C05) |
| [Recharts](https://recharts.org) | Usage and cost dashboard | A measured need for charts |

## Not for now

Lenis, GSAP with ScrollTrigger, COBE, Spline, React Three Fiber with Drei, and p5.js are for marketing-page effects or 3D, not the editor. Lenis or COBE could appear on the landing page later. date-fns isn't needed while `Intl.RelativeTimeFormat` and `Intl.DateTimeFormat` cover our date formatting. canvas-confetti is optional, one burst when a team's first pull request opens at most.

## Rules

- Don't add a library when the platform already does the job. A fade or hover is CSS (`opacity` and `transform`), not a dependency.
- Match the tool to the job. A one-off transition doesn't justify a 30 to 50 KB animation runtime.
- Prefer libraries that are actively maintained and widely used.
- Only animate `transform`, `opacity`, and `filter`. Don't animate `width`, `height`, or `margin`.
- Respect `prefers-reduced-motion` in every animation.
- Use the library's current API. Check its docs when unsure instead of relying on an older version you remember.
- Say which library you're adding, and why, before installing anything not on this page.

## Product note

This page is a hand-written version of something Neat Labs does for customers. The design system profile records which of these UI libraries a repo already depends on, so the edit agent reuses them instead of adding new dependencies. That's the same rule as above, applied to each customer's repo.
