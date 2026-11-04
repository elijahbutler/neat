# S3: the edit agent

September 23, 2026. Fixture `orbit-studio`, 10 tasks, Claude Sonnet 5 and Claude Opus 5 at effort `medium`, using an Anthropic-compatible endpoint. Raw results, including every diff, are in [s3-results.json](s3-results.json). Harness: `scripts/spikes/s3-edit-agent.ts`; tasks and graders: `scripts/spikes/s3-tasks.ts`.

## Question

Can a model make good edits through the hybrid pipeline, where it only returns small operations that code validates and applies, and does that cost less than giving it the files and asking for the change?

## What we ran

- **Pipeline.** The context packet from `buildContext` (selection, parents with their props, numbered source with each element's tag, component cards, tokens, facts) and the request. The model returns edit operations as structured output. `applyEdits` applies them, `checkEdit` checks them, and any errors go back to the model, for up to three attempts.
- **Baseline.** The clicked file, the route's page, every component file the route renders, and `globals.css`, with the clicked location and the request. The model returns the full new contents of each file it changes. The same `checkEdit` runs on the result, with the same retries.

Each task is a click plus a request in a designer's words, such as "make this the main call to action style instead of the quiet one" or "make the project title color #e4572e". A grader checks the intent: the team's `Button` with the right variant rather than new markup, the `text-brand` token rather than the hex value, the label above the heading, and no changes outside the expected file.

## Results

| Model | Approach | Passed | First try | Input tokens | Output tokens | Cost per task | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Sonnet 5 | Pipeline | 9 / 10 | 9 | 4,442 | 105 | $0.0083 | 2.9 s |
| Sonnet 5 | Baseline | 8 / 10 | 8 | 2,461 | 385 | $0.0095 | 4.0 s |
| Opus 5 | Pipeline | 9 / 10 | 9 | 4,442 | 70 | $0.0223 | 2.4 s |
| Opus 5 | Baseline | 10 / 10 | 10 | 2,461 | 475 | $0.0272 | 6.2 s |

Costs are list prices for the same tokens on the API; actual endpoint charges were not measured. Every passing run passed on the first attempt, so the retry loop was never needed.

## Findings

- **The pipeline makes small, correct edits, and can't make large wrong ones.** Every pipeline diff touched only the lines the request was about. Sonnet's baseline on "put a New label above this heading" rewrote `app/page.tsx` and swapped the contents of the two sections. It typechecked and would have passed every check except the grader. Operations applied at syntax-tree positions rule this out.
- **The pipeline is cheaper and faster, even on a tiny fixture.** Output is 70 to 105 tokens instead of 385 to 475, which matters more than the pipeline's larger input because output costs five times as much. Per task it's 13% cheaper on Sonnet, 18% cheaper on Opus, and faster on both. The fixture's files are 10 to 30 lines. On real files the baseline's input and output grow with file size, while the pipeline's stay roughly flat, so the gap should widen. That still needs measuring on a real repo.
- **Sonnet 5 matches Opus 5 in the pipeline at 37% of the cost.** Same pass rate and the same failure, with fewer output tokens from Opus but a higher price. Sonnet 5 is the default model for the edit step. Opus 5.5 was not tested in this experiment.
- **Dark surfaces are a blind spot, in the profile and in the models.** On t08 ("add a line under this heading in the muted text color", with the heading in `<Section tone="ink">`), every pipeline run and most baseline runs used `text-ink-muted`: dark grey on near-black. The repo has no muted token for dark surfaces; `Section`'s ink tone uses `text-paper`. Showing the model the parent's `tone="ink"` didn't change the answer, because it follows the instruction's words. One Opus baseline run used `text-paper/70`, which reads correctly, and a rerun didn't repeat it. Two fixes, both planned work: extract surface-specific roles (what text color each dark surface uses), and the sandbox render check, which will measure contrast in the selected region.
- **Prompt caching didn't help yet.** The system prompt is under the minimum cacheable size, and the packet changes per request. Splitting the packet into a stable repo part (cards, tokens, facts, cached) and a per-request part (selection, source), for repeated requests, is the next cost lever.

## Other recorded runs

Additional historical model measurements are in [s3-results-gpt.json](s3-results-gpt.json). These are local experiment results, not guarantees for other repositories or current models.
