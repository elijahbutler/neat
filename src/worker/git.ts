// Git and file-system primitives for kept steps. Everything here treats the worktree as untrusted ground: files are
// hashed before they are trusted, and nothing is written through a symlink.
import { mkdtemp, lstat, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix, relative, sep } from 'node:path';
import { sandboxWrite } from '../tagging/inject';
import { isSafeRelative, sha256 } from './passes';

/** A request the editor refuses on purpose. The message is fit to show: it names repository files, never machine paths. */
export class Refusal extends Error {
  constructor(readonly status: 404 | 409 | 422, readonly code: 'changed' | 'symlink' | 'conflict' | 'unsafe' | 'breaks' | 'missing' | 'error', message: string) {
    super(message);
  }
}

/** The checkout a session edits. `root` is the repository root, `appDir` the app inside it, both as real paths. */
export interface Worktree { root: string; appDir: string; prefix: string }

interface GitResult { code: number; out: string; err: string }

export async function git(cwd: string, args: string[], options: { input?: string; env?: Record<string, string> } = {}): Promise<GitResult> {
  const proc = Bun.spawn(['git', '--literal-pathspecs', '-c', 'core.quotepath=false', '-c', 'core.autocrlf=false', ...args], {
    cwd,
    stdin: options.input === undefined ? 'ignore' : new TextEncoder().encode(options.input),
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

/** Run git and return its output. The failure message leaves out git's own text, which can hold paths. */
export async function gitText(cwd: string, args: string[], options?: Parameters<typeof git>[2]): Promise<string> {
  const result = await git(cwd, args, options);
  if (result.code !== 0) throw new Error(`git ${args[0]} failed`);
  return result.out;
}

export async function openWorktree(appDir: string): Promise<Worktree> {
  const app = await realpath(appDir);
  const root = await realpath((await gitText(app, ['rev-parse', '--show-toplevel'])).trim());
  const prefix = relative(root, app).split(sep).join('/');
  return { root, appDir: app, prefix };
}

export const repoPath = (wt: Worktree, file: string) => (wt.prefix ? posix.join(wt.prefix, file) : file);
export const headCommit = async (wt: Worktree) => (await gitText(wt.root, ['rev-parse', 'HEAD'])).trim();
export async function commitExists(repo: string, commit: string): Promise<boolean> {
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(commit) && (await git(repo, ['cat-file', '-e', `${commit}^{commit}`])).code === 0;
}

/** The absolute path of an app file, refusing a symlink anywhere along it. Returns null when the file does not exist. */
async function plainPath(wt: Worktree, file: string): Promise<string | null> {
  if (!isSafeRelative(file)) throw new Refusal(409, 'unsafe', `${file} is not a path inside the app.`);
  let current = wt.appDir;
  for (const part of file.split('/')) {
    current = join(current, part);
    const info = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) return null;
    if (info.isSymbolicLink()) throw new Refusal(409, 'symlink', `${file} is, or sits behind, a symbolic link, so the editor will not write it.`);
  }
  return current;
}

/** The file's text on disk, or null when it does not exist. */
export async function readApp(wt: Worktree, file: string): Promise<string | null> {
  const path = await plainPath(wt, file);
  return path === null ? null : readFile(path, 'utf8');
}

/** The file's text in the current commit, or null when the commit does not have it. */
export async function headText(wt: Worktree, file: string): Promise<string | null> {
  const result = await git(wt.root, ['cat-file', '--filters', `HEAD:${repoPath(wt, file)}`]);
  return result.code === 0 ? result.out : null;
}

/**
 * Write app files, all or none. Every path is checked for symlinks before the first write, and each write replaces the
 * file instead of opening it, so a link created in between still cannot send the bytes outside the checkout.
 */
export async function writeApp(wt: Worktree, writes: Array<{ file: string; text: string }>): Promise<void> {
  const originals = new Map<string, string | null>();
  const modes = new Map<string, number>();
  for (const { file } of writes) {
    const path = await plainPath(wt, file);
    originals.set(file, await readApp(wt, file));
    if (path) modes.set(file, (await lstat(path)).mode & 0o7777);
  }
  const done: string[] = [];
  try {
    for (const { file, text } of writes) {
      // Permissions belong to the open temporary file, before replacement. Never resolve the destination again for chmod.
      await sandboxWrite(wt.appDir, join(wt.appDir, file), text, modes.get(file) ?? 0o600);
      done.push(file);
    }
  } catch (error) {
    for (const file of done.reverse()) {
      const text = originals.get(file);
      if (typeof text === 'string') await sandboxWrite(wt.appDir, join(wt.appDir, file), text, modes.get(file) ?? 0o600).catch(() => undefined);
    }
    throw error;
  }
}

/** Require each file to be exactly the expected text on disk and, when `clean`, identical in the current commit. */
export async function requireState(wt: Worktree, expected: Array<{ file: string; hash: string }>, clean = true): Promise<void> {
  for (const { file, hash } of expected) {
    const disk = await readApp(wt, file);
    if (disk === null || sha256(disk) !== hash) throw new Refusal(409, 'changed', `${file} changed outside the editor. Restart the editor to rebuild it from your kept steps.`);
    if (clean) {
      const committed = await headText(wt, file);
      if (committed === null || sha256(committed) !== hash) throw new Refusal(409, 'changed', `${file} differs from the last kept step. Restart the editor to rebuild it from your kept steps.`);
    }
  }
}

export async function stage(wt: Worktree, files: string[]): Promise<void> {
  await gitText(wt.root, ['add', '--', ...files.map((file) => repoPath(wt, file))]);
}
export async function unstage(wt: Worktree, files: string[]): Promise<void> {
  await git(wt.root, ['reset', '-q', 'HEAD', '--', ...files.map((file) => repoPath(wt, file))]);
}
/** The staged change to these files as a patch that applies from the repository root. */
export async function stagedPatch(wt: Worktree, files: string[]): Promise<string> {
  return gitText(wt.root, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', ...files.map((file) => repoPath(wt, file))]);
}
/** Build a patch from validated text using an isolated index, without staging working files. */
export async function snapshotPatch(wt: Worktree, changes: Array<{ file: string; after: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neat-snapshot-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await gitText(wt.root, ['read-tree', 'HEAD'], { env });
    for (const change of changes) {
      const path = repoPath(wt, change.file);
      const entry = await gitText(wt.root, ['ls-files', '--stage', '--', path], { env });
      const mode = /^(100644|100755) /.exec(entry)?.[1];
      if (!mode) throw new Refusal(409, 'unsafe', 'Only existing regular files can be kept.');
      const blob = (await gitText(wt.root, ['hash-object', '-w', '--path', path, '--stdin'], { input: change.after })).trim();
      await gitText(wt.root, ['update-index', '--cacheinfo', mode, blob, path], { env });
    }
    return await gitText(wt.root, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--', ...changes.map(c => repoPath(wt, c.file))], { env });
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Commit the recorded patch through a private index. Plumbing commands do not run repository hooks or reread disk. */
export async function commitFiles(wt: Worktree, message: string, files: string[], patch: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'neat-commit-'));
  const env = {
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'Neat', GIT_AUTHOR_EMAIL: 'sandbox@neatlabs.design',
    GIT_COMMITTER_NAME: 'Neat', GIT_COMMITTER_EMAIL: 'sandbox@neatlabs.design',
  };
  try {
    const parent = await headCommit(wt);
    await gitText(wt.root, ['read-tree', parent], { env });
    await gitText(wt.root, ['apply', '--cached', '--whitespace=nowarn'], { env, input: patch });
    const tree = (await gitText(wt.root, ['write-tree'], { env })).trim();
    const commit = (await gitText(wt.root, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', parent], { env, input: message + '\n' })).trim();
    await gitText(wt.root, ['update-ref', 'HEAD', commit, parent]);
    await unstage(wt, files);
    return commit;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
/** Move the commit pointer back one commit, then match the index to it for these files. The disk already holds that state. */
export async function dropHeadCommit(wt: Worktree, files: string[]): Promise<void> {
  await gitText(wt.root, ['reset', '-q', '--soft', 'HEAD~1']);
  await unstage(wt, files);
}

/**
 * What the files would read after applying a patch to the current commit, without touching the worktree. Uses a throwaway
 * index. Refuses a patch that creates, deletes, renames, or changes the mode of anything, or that names other files.
 */
export async function previewPatch(wt: Worktree, patch: string, options: { reverse: boolean; repoFiles: string[] }): Promise<Map<string, string>> {
  const dir = await mkdtemp(join(tmpdir(), 'neat-index-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    const summary = await git(wt.root, ['apply', '--summary'], { input: patch });
    const numstat = await git(wt.root, ['apply', '--numstat', '-z'], { input: patch });
    if (summary.code !== 0 || numstat.code !== 0 || summary.out.trim()) throw new Refusal(409, 'unsafe', 'The saved change is not a plain edit of existing files.');
    const named = numstat.out.split('\0').filter(Boolean).map((record) => record.split('\t').slice(2).join('\t'));
    const expected = [...options.repoFiles].sort();
    if (named.length !== expected.length || [...named].sort().some((path, i) => path !== expected[i])) throw new Refusal(409, 'unsafe', 'The saved change names files it does not list.');
    await gitText(wt.root, ['read-tree', 'HEAD'], { env });
    // Taking a step back merges with a three-way apply, so independent work next to it survives. A rebuild replays
    // steps onto the exact text they were made from, so it needs no merge.
    const applied = await git(wt.root, ['apply', '--cached', '--whitespace=nowarn', ...(options.reverse ? ['-R', '--3way'] : [])], { input: patch, env });
    if (applied.code !== 0) throw new Refusal(409, 'conflict', 'Later steps change the same code, so this step cannot be taken back on its own. Undo the later steps first.');
    const texts = new Map<string, string>();
    for (const path of named) texts.set(path, await gitText(wt.root, ['cat-file', '--filters', `:${path}`], { env }));
    return texts;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
