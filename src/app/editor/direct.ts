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
