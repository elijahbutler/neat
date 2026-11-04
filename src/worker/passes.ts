// Durable passes: the kept steps of one editing session, saved as JSON so a restart can rebuild them.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize } from 'node:path';
import { z } from 'zod';

export const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const time = z.string().datetime();
const commit = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/);

/** A path inside the repository: relative, normalized, and never climbing out. */
export function isSafeRelative(path: string): boolean {
  return path !== '' && !path.includes('\0') && !path.includes('\\') && !isAbsolute(path) && normalize(path) === path && path !== '.' && !path.split('/').includes('..');
}
const relativePath = z.string().refine(isSafeRelative, 'a path inside the repository');

const checkSchema = z.object({
  name: z.enum(['syntax', 'typecheck', 'imports', 'variants', 'lint', 'render']),
  status: z.enum(['passed', 'not-run']),
}).strict();
const fileSchema = z.object({
  /** Relative to the app, the way the editor addresses it. */
  file: relativePath,
  /** Relative to the repository root, the way a patch addresses it. */
  repoFile: relativePath,
  beforeHash: hash,
  afterHash: hash,
}).strict();
const spanSchema = z.object({ file: relativePath, start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), length: z.number().int().nonnegative() }).strict();

const stepFields = {
  id,
  summary: z.string().min(1).max(200),
  createdAt: time,
  files: z.array(fileSchema).min(1).max(200),
  /** Repository-relative unified diff of this step alone, from `git diff`. */
  patch: z.string().min(1).max(8_000_000),
  checks: z.array(checkSchema).max(12),
  /** Replaced ranges in the text before the step, for moving source tags across it. */
  spans: z.array(spanSchema).max(2000),
};
const undoneSchema = z.discriminatedUnion('mode', [
  /** The newest step, removed from the history as if it never happened. */
  z.object({ mode: z.literal('dropped'), at: time }).strict(),
  /** An earlier step, taken back by a later revert step that stays in the history. */
  z.object({ mode: z.literal('reverted'), at: time, revertId: id }).strict(),
]);
export const entrySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('edit'), source: z.enum(['ask', 'direct']), tag: z.string().max(1000), ...stepFields, undone: undoneSchema.optional() }).strict(),
  z.object({ kind: z.literal('revert'), target: id, ...stepFields }).strict(),
]);
export type Entry = z.infer<typeof entrySchema>;
export type EditEntry = Extract<Entry, { kind: 'edit' }>;
export type StepFile = z.infer<typeof fileSchema>;
export type StepCheck = z.infer<typeof checkSchema>;

export const passSchema = z.object({
  version: z.literal(1),
  id,
  /** Real path of the repository the pass belongs to. */
  repo: z.string().min(1),
  /** The app inside the repository, as given to `--app`. */
  app: z.string().min(1),
  baseCommit: commit,
  status: z.enum(['open', 'closed']),
  createdAt: time,
  updatedAt: time,
  /** The pass this one continued after a rebuild stopped part way. */
  supersedes: id.optional(),
  entries: z.array(entrySchema).max(2000),
}).strict().superRefine((pass, ctx) => {
  const ids = new Set<string>();
  for (const [index, entry] of pass.entries.entries()) {
    if (ids.has(entry.id)) ctx.addIssue({ code: 'custom', path: ['entries', index, 'id'], message: 'duplicate step id' });
    ids.add(entry.id);
  }
  for (const [index, entry] of pass.entries.entries()) {
    const link = entry.kind === 'revert' ? entry.target : entry.undone?.mode === 'reverted' ? entry.undone.revertId : null;
    if (link && !ids.has(link)) ctx.addIssue({ code: 'custom', path: ['entries', index], message: 'unknown linked step' });
  }
});
export type Pass = z.infer<typeof passSchema>;

/** Steps the history still contains. A dropped step is gone: later steps were made without it. */
export const isReplayable = (entry: Entry): boolean => !(entry.kind === 'edit' && entry.undone?.mode === 'dropped');

export const passesHome = () => join(process.env.NEAT_HOME ?? join(homedir(), '.neat'), 'passes');
export const repoHash = (repo: string) => sha256(repo).slice(0, 24);
const passDir = (repo: string) => join(passesHome(), repoHash(repo));
const MAX_PASS_BYTES = 64 * 1024 * 1024;

export const newId = (prefix: string) => `${prefix}-${randomBytes(5).toString('hex')}`;
export const now = () => new Date().toISOString();

export function createPass(input: { repo: string; app: string; baseCommit: string; supersedes?: string }): Pass {
  const at = now();
  return { version: 1, id: newId('pass'), repo: input.repo, app: input.app, baseCommit: input.baseCommit, status: 'open', createdAt: at, updatedAt: at, ...(input.supersedes ? { supersedes: input.supersedes } : {}), entries: [] };
}

/** Write the whole pass atomically: a temporary file in the same directory, flushed, then renamed over the old one. */
export async function writePass(pass: Pass): Promise<void> {
  const dir = passDir(pass.repo);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await lstat(dir)).isDirectory()) throw new Error('Pass directory is not a directory.');
  const target = join(dir, `${pass.id}.json`);
  const temp = join(dir, `.${pass.id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(JSON.stringify(passSchema.parse(pass)));
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temp, { force: true });
    throw error;
  }
  await handle.close();
  try { await rename(temp, target); } catch (error) { await rm(temp, { force: true }); throw error; }
}

export interface LoadedPasses {
  passes: Pass[];
  /** Files in the pass directory that could not be used: unreadable, invalid, too large, or not a plain file. */
  skipped: number;
}

/** Every usable pass saved for this repository. A bad file is skipped and left alone, never fatal. */
export async function loadPasses(repo: string): Promise<LoadedPasses> {
  const dir = passDir(repo);
  const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
  const passes: Pass[] = [];
  let skipped = 0;
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    try {
      const path = join(dir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_PASS_BYTES) throw new Error('unusable');
      const pass = passSchema.parse(JSON.parse(await readFile(path, 'utf8')));
      if (`${pass.id}.json` !== name || pass.repo !== repo) throw new Error('misplaced');
      passes.push(pass);
    } catch {
      skipped++;
      console.warn('Skipping an unreadable Neat pass file.');
    }
  }
  return { passes, skipped };
}

/** The pass to continue: the most recently updated open one for this app. */
export function latestOpenPass(passes: Pass[], app: string): Pass | undefined {
  return passes.filter((pass) => pass.status === 'open' && pass.app === app)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))[0];
}
