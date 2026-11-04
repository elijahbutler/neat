import type { Project } from 'ts-morph';
import { checkEdit, type CheckError } from './check';
import type { RepoIndex } from './index';
import { applyEdits, editOperationsSchema, type EditError, type EditOperation, type FileChange } from './operations';
import { confirmations, type ScopeConfirmation } from './scope';

export interface DirectEditRequest {
  /** Source tag of the selected element. It is the scope, exactly as for an Ask. */
  tag: string;
  /** `set-text`, `replace-class`, or `set-prop` with a string or null value. */
  operations: unknown;
  /** Wider targets the person has confirmed. */
  allow?: string[];
  /** What the control did, in plain words, such as "Padding: 4 to 6". Used as the review title and commit message. */
  label?: string;
}

export type DirectEditResult =
  | { ok: true; changes: FileChange[]; summary: string }
  | {
    ok: false;
    /** Plain words for the person: what happened and what to do. */
    message: string;
    errors: EditError[];
    checks: CheckError[];
    confirm: ScopeConfirmation[];
  };

const quote = (text: string) => `"${text.length > 60 ? `${text.slice(0, 57)}...` : text}"`;

/** One line that says what a set of operations does, for the review card and the commit. */
export function summarize(operations: EditOperation[]): string {
  const parts = operations.map((operation) => {
    if (operation.op === 'set-text') return `Change text to ${quote(operation.text)}`;
    if (operation.op === 'replace-class') {
      if (!operation.to) return `Remove ${operation.from}`;
      if (!operation.from) return `Add ${operation.to}`;
      return `Change ${operation.from} to ${operation.to}`;
    }
    if (operation.op === 'set-prop') return operation.value === null ? `Remove ${operation.name}` : `Set ${operation.name} to ${typeof operation.value === 'string' ? operation.value : 'a new value'}`;
    return 'Add an element';
  });
  return parts.map((part, i) => (i === 0 ? part : part[0]!.toLowerCase() + part.slice(1))).join(', ');
}

function failure(errors: EditError[], checks: CheckError[]): DirectEditResult {
  const confirm = confirmations(errors);
  const codes = new Set(errors.map((e) => e.code));
  let message = "That change couldn't be made. Click the element again and retry.";
  if (confirm[0]) message = `That would change ${confirm[0].component} everywhere it is used (${confirm[0].uses} ${confirm[0].uses === 1 ? 'place' : 'places'}). The editor can't confirm changes to shared components yet.`;
  else if (codes.has('out-of-scope')) message = 'That change reaches outside the selected element, so it was not made.';
  else if (codes.has('target-not-found')) message = 'That element is no longer in the code. Click it again.';
  else if (codes.has('not-plain-text')) message = "This text isn't written directly in the code here, so it can't be edited on the page.";
  else if (codes.has('class-not-found') || codes.has('ambiguous-class')) message = "The styles on this element aren't a plain list in the code, so this control can't change them. Ask for the change instead.";
  else if (checks.some((c) => c.check === 'variants')) message = "That option isn't one this component offers.";
  else if (checks.length) message = 'That change would break the code, so it was not made.';
  return { ok: false, message, errors, checks, confirm };
}

/**
 * Apply operations that come straight from a control in the editor, with no model call. They go through the same
 * scope and checks as an Ask. Controls never write code, so inserted JSX and expression values are refused here.
 */
export function directEdit(project: Project, root: string, index: RepoIndex, request: DirectEditRequest): DirectEditResult {
  const parsed = editOperationsSchema.safeParse(request.operations);
  if (parsed.success) {
    const refused = parsed.data.flatMap((operation, op): EditError[] => {
      if (operation.op === 'insert-jsx') return [{ op, code: 'invalid', message: 'A direct edit cannot insert JSX.' }];
      if (operation.op === 'set-prop' && operation.value !== null && typeof operation.value !== 'string') return [{ op, code: 'invalid', message: 'A direct edit can only set a prop to a string, or remove it.' }];
      return [];
    });
    if (refused.length) return failure(refused, []);
  }
  const applied = applyEdits(project, root, index, request.operations, { selection: request.tag, allow: request.allow });
  if (!applied.ok || !parsed.success) return failure(applied.errors, []);
  const changes = applied.changes.filter((change) => change.before !== change.after);
  if (!changes.length) return { ok: false, message: 'Nothing changed. The code already says that.', errors: [], checks: [], confirm: [] };
  const check = checkEdit(project, root, index, changes);
  if (!check.ok) return failure([], check.errors);
  return { ok: true, changes, summary: request.label?.trim().slice(0, 120) || summarize(parsed.data) };
}
