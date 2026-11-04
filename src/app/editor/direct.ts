// Turns what a control in the editor did into edit operations for the worker's direct-edit path. No model, and
// nothing here touches the file system, so it is safe to import into the browser bundle.
import type { EditOperation } from '../../edit/operations';

/**
 * Which element on the page is being typed in, and which source tag its text is written at. Double-clicks can
 * overlap: each asks the worker a question, and the answers can come back in any order. Only the answer to the
 * newest question counts, so a late answer for an earlier element can't replace the one being edited.
 */
export function textEditTracker() {
  let latest = 0;
  let current: { key: string; target: string } | null = null;
  return {
    /** A double-click happened. Returns the ticket its answer must present. */
    ask(): number { return ++latest; },
    /** The worker says the text is editable. False when a newer double-click has made this answer stale. */
    answer(ticket: number, key: string, target: string): boolean {
      if (ticket !== latest) return false;
      current = { key, target };
      return true;
    },
    /** Whether an answer is still the newest, for answers that only carry a message. */
    isLatest(ticket: number): boolean { return ticket === latest; },
    /** The page committed text for `key`. Returns the source tag to write it at, or null when it isn't the element being edited. */
    commit(key: string): string | null {
      if (current?.key !== key) return null;
      const { target } = current;
      current = null;
      return target;
    },
    /** The page stopped editing `key` without a commit. A cancel for another element changes nothing. */
    cancel(key: string): void { if (current?.key === key) current = null; },
  };
}

/** The operation for text typed over an element on the page. Null when there is nothing to write. */
export function textOperation(target: string, typed: string): EditOperation | null {
  const text = typed.replace(/\s+/g, ' ').trim();
  return text ? { op: 'set-text', target, text } : null;
}

/** The element selected on the page, as the preview reported it: source tags for itself, its instance, and its ancestors. */
export interface SelectedTarget {
  src: string | null;
  inst: string | null;
  element: string;
  text: string;
  ancestors: Array<{ src: string | null; inst: string | null; childIndex: number }>;
}

/** Every source tag the selection holds, for the worker to follow across a change. */
export function targetTags(target: SelectedTarget): string[] {
  return [...new Set([target.src, target.inst, ...target.ancestors.flatMap((a) => [a.src, a.inst])].filter((tag): tag is string => !!tag))];
}

/**
 * The selection after a change moved lines and columns. `moved` maps each tag the worker was given to its new tag, or
 * null when it could not be followed. Returns null when the selected element itself is lost, so the page can ask for a
 * new click instead of pointing at the wrong code. An ancestor that is lost only stops being used.
 */
export function moveTarget(target: SelectedTarget, moved: Record<string, string | null>): SelectedTarget | null {
  const follow = (tag: string | null) => (tag === null ? null : tag in moved ? moved[tag] ?? null : tag);
  const next = { ...target, src: follow(target.src), inst: follow(target.inst), ancestors: target.ancestors.map((a) => ({ ...a, src: follow(a.src), inst: follow(a.inst) })) };
  // The instance is what edits target when there is one, so losing it loses the selection.
  const lost = target.inst !== null ? next.inst === null : target.src !== null && next.src === null;
  return lost ? null : next;
}

export interface PatchLine { kind: 'hunk' | '+' | '-' | ' '; text: string }

/** The lines of a step's unified diff worth showing: hunk headers, additions, removals, and context. */
export function patchLines(patch: string): PatchLine[] {
  const lines: PatchLine[] = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) { inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; lines.push({ kind: 'hunk', text: line.replace(/^(@@[^@]*@@).*$/, '$1') }); continue; }
    if (!inHunk) continue;
    if (line.startsWith('+')) lines.push({ kind: '+', text: line.slice(1) });
    else if (line.startsWith('-')) lines.push({ kind: '-', text: line.slice(1) });
    else if (line.startsWith(' ')) lines.push({ kind: ' ', text: line.slice(1) });
  }
  return lines;
}
