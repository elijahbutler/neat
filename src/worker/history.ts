// Keep, undo, and replay of the steps in a pass. Each step is a commit in the session worktree and a patch in the pass
// file; the pass file is the record, so it is saved before a commit is made or dropped.
import type { CheckStatus } from '../edit/direct';
import type { FileChange } from '../edit/operations';
import type { FileSpan } from '../edit/shift';
import {
  commitFiles, dropHeadCommit, headCommit, headText, previewPatch, readApp, Refusal, repoPath, requireState, snapshotPatch, stage, unstage, writeApp,
  type Worktree,
} from './git';
import { isReplayable, newId, now, sha256, type EditEntry, type Entry, type Pass, type StepFile } from './passes';

export interface History {
  wt: Worktree;
  pass: Pass;
  /** Commit of each step in the current worktree. Commits differ after every rebuild, so they are never saved. */
  commits: Map<string, string>;
  /** Save the pass. Must not return before the file is on disk. */
  persist: () => Promise<void>;
}

/** The text each file should have now, according to the steps the history still holds. */
export function chainHeads(pass: Pass): Map<string, string> {
  const heads = new Map<string, string>();
  for (const entry of pass.entries) {
    if (!isReplayable(entry)) continue;
    for (const file of entry.files) heads.set(file.file, file.afterHash);
  }
  return heads;
}

const oneLine = (text: string, max = 200) => text.replace(/\s+/g, ' ').trim().slice(0, max);

function stepFiles(h: History, changes: FileChange[]): StepFile[] {
  return changes.map((change) => ({ file: change.file, repoFile: repoPath(h.wt, change.file), beforeHash: sha256(change.before), afterHash: sha256(change.after) }));
}

/** Put the pass back as it was after a step failed to land. The failed step's file changes are undone by the caller. */
async function forget(h: History, entry: Entry, restore: () => void): Promise<void> {
  h.pass.entries = h.pass.entries.filter((e) => e !== entry);
  restore();
  await h.persist().catch(() => undefined);
}

export interface KeepInput { source: EditEntry['source']; summary: string; tag: string; changes: FileChange[]; spans: FileSpan[]; checks: CheckStatus[] }

/**
 * Record the applied change as a step and commit it. The files on disk must still be exactly the applied text, and the
 * committed text must still be what the change started from, so the step's patch is the whole difference.
 */
export async function keepStep(h: History, input: KeepInput): Promise<EditEntry> {
  const heads = chainHeads(h.pass);
  const files = stepFiles(h, input.changes);
  const names = files.map((f) => f.file);
  await requireState(h.wt, input.changes.map((c) => ({ file: c.file, hash: sha256(c.after) })), false);
  for (const change of input.changes) {
    const committed = await headText(h.wt, change.file);
    const known = heads.get(change.file);
    if (committed !== change.before || (known !== undefined && known !== sha256(change.before))) {
      throw new Refusal(409, 'changed', `${change.file} differs from the last kept step. Undo this change and restart the editor to rebuild it from your kept steps.`);
    }
  }
  const patch = await snapshotPatch(h.wt, input.changes);
  const summary = oneLine(input.summary);
  const entry: EditEntry = {
    kind: 'edit', source: input.source, tag: input.tag.slice(0, 1000), id: newId('step'), summary: summary || 'Edit', createdAt: now(),
    files, patch, checks: input.checks, spans: input.spans.filter((span) => names.includes(span.file)),
  };
  const before = h.pass.updatedAt;
  h.pass.entries.push(entry);
  h.pass.updatedAt = now();
  try { await h.persist(); } catch (error) { await forget(h, entry, () => { h.pass.updatedAt = before; }); await unstage(h.wt, names); throw error; }
  try { h.commits.set(entry.id, await commitFiles(h.wt, entry.summary, names, entry.patch)); }
  catch (error) { await forget(h, entry, () => { h.pass.updatedAt = before; }); await unstage(h.wt, names); throw error; }
  return entry;
}

export interface UndoHooks {
  /** Check the files as they would read after the undo. Return a sentence when the code would break, else null. */
  check: (changes: FileChange[]) => string | null;
}
export interface UndoResult { entry: EditEntry; mode: 'dropped' | 'reverted'; changes: FileChange[] }

/**
 * Take one kept step back. The newest step is removed from the history. An earlier step is reversed with its own
 * patch and recorded as a new step, so work done after it stays. If later steps changed the same lines the patch does
 * not apply and the undo is refused with nothing written.
 */
export async function undoStep(h: History, id: string, hooks: UndoHooks): Promise<UndoResult> {
  const entry = h.pass.entries.find((e): e is EditEntry => e.kind === 'edit' && e.id === id);
  if (!entry) throw new Refusal(404, 'missing', 'That step is not in this pass.');
  if (entry.undone) throw new Refusal(409, 'conflict', 'That step is already undone.');
  const heads = chainHeads(h.pass);
  const names = entry.files.map((f) => f.file);
  const repoFiles = entry.files.map((f) => f.repoFile);
  await requireState(h.wt, entry.files.map((f) => ({ file: f.file, hash: heads.get(f.file) ?? f.afterHash })));
  const texts = await previewPatch(h.wt, entry.patch, { reverse: true, repoFiles });
  const changes: FileChange[] = [];
  for (const f of entry.files) {
    changes.push({ file: f.file, before: (await readApp(h.wt, f.file))!, after: texts.get(f.repoFile)! });
  }
  const broken = hooks.check(changes);
  if (broken) throw new Refusal(422, 'breaks', broken);

  const last = [...h.pass.entries].reverse().find(isReplayable);
  const newest = last === entry && h.commits.get(entry.id) === await headCommit(h.wt);
  const before = h.pass.updatedAt;
  const restoreDisk = () => writeApp(h.wt, changes.map((c) => ({ file: c.file, text: c.before }))).catch(() => undefined);
  await writeApp(h.wt, changes.map((c) => ({ file: c.file, text: c.after })));
  try {
    await stage(h.wt, names);
    if (newest) {
      entry.undone = { mode: 'dropped', at: now() };
      h.pass.updatedAt = now();
      try { await h.persist(); } catch (error) { delete entry.undone; h.pass.updatedAt = before; await h.persist().catch(() => undefined); throw error; }
      try { await dropHeadCommit(h.wt, names); } catch (error) { delete entry.undone; h.pass.updatedAt = before; await h.persist().catch(() => undefined); throw error; }
      h.commits.delete(entry.id);
      return { entry, mode: 'dropped', changes };
    }
    const revert: Entry = {
      kind: 'revert', target: entry.id, id: newId('step'), summary: `Undo: ${entry.summary}`.slice(0, 200), createdAt: now(),
      files: stepFiles(h, changes), patch: await snapshotPatch(h.wt, changes), checks: entry.checks, spans: [],
    };
    entry.undone = { mode: 'reverted', at: now(), revertId: revert.id };
    h.pass.entries.push(revert);
    h.pass.updatedAt = now();
    const undo = () => { delete entry.undone; h.pass.entries = h.pass.entries.filter((e) => e !== revert); h.pass.updatedAt = before; };
    try { await h.persist(); } catch (error) { undo(); await h.persist().catch(() => undefined); throw error; }
    try { h.commits.set(revert.id, await commitFiles(h.wt, revert.summary, names, revert.patch)); }
    catch (error) { undo(); await h.persist().catch(() => undefined); throw error; }
    return { entry, mode: 'reverted', changes };
  } catch (error) {
    await unstage(h.wt, names).catch(() => undefined);
    await restoreDisk();
    throw error;
  }
}

export interface ReplayResult {
  /** Steps put back, counting the ones that were taken back by a later revert. */
  applied: number;
  /** The first step that could not be put back, and why. Steps after it were not tried. */
  failure: { entry: Entry; reason: Refusal['code'] } | null;
}

async function replayEntry(h: History, entry: Entry): Promise<void> {
  const names = entry.files.map((f) => f.file);
  await requireState(h.wt, entry.files.map((f) => ({ file: f.file, hash: f.beforeHash })));
  const texts = await previewPatch(h.wt, entry.patch, { reverse: false, repoFiles: entry.files.map((f) => f.repoFile) });
  for (const f of entry.files) {
    if (texts.get(f.repoFile) === undefined || sha256(texts.get(f.repoFile)!) !== f.afterHash) throw new Refusal(409, 'conflict', 'The saved step no longer produces the text it recorded.');
  }
  const committed = new Map<string, string>();
  for (const f of entry.files) committed.set(f.file, (await headText(h.wt, f.file))!);
  try {
    await writeApp(h.wt, entry.files.map((f) => ({ file: f.file, text: texts.get(f.repoFile)! })));
    await stage(h.wt, names);
    h.commits.set(entry.id, await commitFiles(h.wt, entry.summary, names, entry.patch));
  } catch (error) {
    // Leave the worktree as the last commit has it, so the steps that did come back stay usable.
    await unstage(h.wt, names).catch(() => undefined);
    await writeApp(h.wt, entry.files.map((f) => ({ file: f.file, text: committed.get(f.file)! }))).catch(() => undefined);
    throw error;
  }
}

/** Put every remaining step of the pass onto a worktree checked out at the pass's base commit, in order. */
export async function replayPass(h: History): Promise<ReplayResult> {
  let applied = 0;
  for (const entry of h.pass.entries) {
    if (!isReplayable(entry)) continue;
    try { await replayEntry(h, entry); } catch (error) {
      // An unexpected failure stops the rebuild like a mismatch does: a restart must not depend on one bad step.
      return { applied, failure: { entry, reason: error instanceof Refusal ? error.code : 'error' } };
    }
    applied++;
  }
  return { applied, failure: null };
}

/** The pass cut before one step, for continuing after a rebuild stopped there. Links into the cut part are cleared. */
export function entriesBefore(pass: Pass, stop: Entry): Entry[] {
  const kept = pass.entries.slice(0, pass.entries.indexOf(stop));
  const ids = new Set(kept.map((e) => e.id));
  return kept.map((e) => (e.kind === 'edit' && e.undone?.mode === 'reverted' && !ids.has(e.undone.revertId) ? { ...e, undone: undefined } : e));
}

export interface TimelineStep {
  id: string;
  number: number;
  source: EditEntry['source'];
  summary: string;
  files: string[];
  status: 'kept' | 'undone';
  undoneAt: string | null;
  createdAt: string;
  /** Unified diff of this step alone, with repository-relative paths. */
  patch: string;
  checks: CheckStatus[];
  /** Short commit in the current worktree, or null when the step is not committed there. */
  commit: string | null;
  /** The newest step still in the history: undoing it leaves no trace. */
  latest: boolean;
}

/** The edit steps in the order they were kept, for the editor's timeline. */
export function timeline(h: History): TimelineStep[] {
  const last = [...h.pass.entries].reverse().find(isReplayable);
  return h.pass.entries.filter((e): e is EditEntry => e.kind === 'edit').map((entry, index) => ({
    id: entry.id,
    number: index + 1,
    source: entry.source,
    summary: entry.summary,
    files: entry.files.map((f) => f.file),
    status: entry.undone ? 'undone' : 'kept',
    undoneAt: entry.undone?.at ?? null,
    createdAt: entry.createdAt,
    patch: entry.patch,
    checks: entry.checks,
    commit: h.commits.get(entry.id)?.slice(0, 7) ?? null,
    latest: !entry.undone && entry === last,
  }));
}
