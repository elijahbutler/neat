// Delivery of a pass: a branch in the person's repository, a patch file, or a pull request.
//
// The branch is built in a separate temporary worktree from `git format-patch` output, so the person's working tree,
// index, and current branch are never touched. Only a new `refs/heads/neat/<slug>` is added, after every commit applied.
// Nothing here pushes or calls GitHub unless `openPullRequest` is called, and every failure carries a fixed message:
// git's own text can hold paths, so it never leaves this file.
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const FAILURES = {
  DELIVERY_UNAVAILABLE: [409, 'Branch and patch delivery require the default local preview.'],
  NO_COMMITS: [422, 'This pass has no kept steps to deliver.'],
  NO_CHANGES: [422, 'The kept steps cancel each other out, so there is nothing to deliver.'],
  PENDING_CHANGE: [409, 'Keep or undo the change waiting in the editor before delivering.'],
  PENDING_PROPOSAL: [409, 'Confirm or cancel the shared-component change before delivering.'],
  SESSION_CHANGED: [409, 'The session no longer matches the saved pass. Restart the editor to rebuild it, then deliver again.'],
  BASE_MISSING: [409, 'The commit this pass started from is no longer in the repository.'],
  CONFLICT: [409, 'The kept steps do not apply cleanly on that base. Nothing was created. Try the other base.'],
  HEAD_MOVED: [409, 'The checkout moved to another commit while the branch was being built. Nothing was created. Try again.'],
  BRANCH_NAME_TAKEN: [409, 'No free branch name was found for that slug. Choose another.'],
  TOO_LARGE: [422, 'The pass is too large to deliver.'],
  EXPORT_UNSAFE: [409, 'The export folder is not a plain directory, so nothing was written.'],
  EXPORT_MISSING: [404, 'That export is not available.'],
  NO_DELIVERY: [409, 'Create a branch first.'],
  BRANCH_CHANGED: [409, 'The delivered branch no longer points at the commit that was delivered. Create the branch again.'],
  GITHUB_MISSING: [409, 'The GitHub command line tool is not installed.'],
  GITHUB_SIGNED_OUT: [409, 'The GitHub command line tool is not signed in.'],
  NO_ORIGIN: [409, 'This repository has no origin remote to push to.'],
  BASE_UNKNOWN: [422, 'Choose a base branch that exists on origin.'],
  PUSH_REJECTED: [409, 'Origin rejected the branch because it already has different commits under that name.'],
  PUSH_FAILED: [502, 'Pushing the branch to origin failed.'],
  GITHUB_FAILED: [502, 'GitHub did not complete the request.'],
  DELIVERY_FAILED: [500, 'Delivery failed.'],
} as const;
export type DeliveryCode = keyof typeof FAILURES;

/** A refusal with a fixed, public message. The code picks the message, so no caller can put git output in one. */
export class DeliveryError extends Error {
  readonly status: (typeof FAILURES)[DeliveryCode][0];
  constructor(readonly code: DeliveryCode) {
    super(FAILURES[code][1]);
    this.status = FAILURES[code][0];
  }
}

export const MAX_SERIES_BYTES = 32 * 1024 * 1024;
const MAX_SUFFIX = 50;
const NO_HOOKS = '/dev/null';

// ---- running git ----

interface Ran { code: number; out: Uint8Array }
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Only these GIT_ variables pass through. Anything else could point git at another repository or index. */
const KEEP_GIT_ENV = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_SSL_CAINFO']);
function cleanEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || (key.startsWith('GIT_') && !KEEP_GIT_ENV.has(key))) continue;
    env[key] = value;
  }
  // A background request cannot answer a prompt, and a read must not rewrite the person's index.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', GIT_OPTIONAL_LOCKS: '0', ...extra };
}
/** Settings that keep the person's hooks and signing out of work done on their behalf. */
const SAFE_CONFIG = ['-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'core.fsmonitor=false'];

async function runGit(cwd: string, args: string[], options: { input?: Uint8Array; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Ran> {
  try {
    const proc = Bun.spawn(['git', ...SAFE_CONFIG, ...args], {
      cwd, stdin: options.input ?? 'ignore', stdout: 'pipe', stderr: 'ignore', env: cleanEnv(options.env), timeout: options.timeoutMs ?? 60_000,
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
    return { code, out: new Uint8Array(out) };
  } catch { return { code: 127, out: new Uint8Array() }; }
}
async function gitOk(cwd: string, args: string[], options?: Parameters<typeof runGit>[2]): Promise<string> {
  const result = await runGit(cwd, args, options);
  if (result.code !== 0) throw new DeliveryError('DELIVERY_FAILED');
  return decode(result.out).trim();
}

// ---- names ----

/** A branch-safe slug: lowercase letters, digits, and single hyphens, at most 48 characters. Empty when nothing is left. */
export function slugify(text: string): string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 48).replace(/-+$/, '');
}
export const branchFor = (slug: string, attempt = 1) => `neat/${slug}${attempt > 1 ? `-${attempt}` : ''}`;
const BRANCH_PATTERN = /^neat\/[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** True for a branch name this module could have generated. */
export const isDeliveryBranch = (branch: string) => BRANCH_PATTERN.test(branch) && branch.length <= 64;

// ---- reading the series ----

export interface DeliverySource {
  /** The person's repository. */
  repo: string;
  /** The session worktree whose commits are the kept steps. */
  sandboxRoot: string;
  /** The commit the pass started from. */
  baseCommit: string;
  /** The session's commit for each step the pass still holds, oldest first. Anything else in the worktree is refused. */
  expectedCommits: string[];
}
export interface Series {
  commits: string[];
  head: string;
  tree: string;
  /** Repository-relative paths the series changes. */
  files: string[];
  /** The whole series as one mailbox, byte for byte what `git format-patch --stdout` printed. */
  mbox: Uint8Array;
}

const isCommitId = (value: string) => /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value);

/** Read the kept commits as a patch series and check they are exactly the steps the pass holds. */
export async function readSeries(source: DeliverySource): Promise<Series> {
  if (!source.expectedCommits.length) throw new DeliveryError('NO_COMMITS');
  const { repo, sandboxRoot, baseCommit } = source;
  if (!isCommitId(baseCommit) || (await runGit(repo, ['cat-file', '-e', `${baseCommit}^{commit}`])).code !== 0) throw new DeliveryError('BASE_MISSING');
  const head = await gitOk(sandboxRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const listed = (await gitOk(sandboxRoot, ['rev-list', '--reverse', `${baseCommit}..${head}`])).split('\n').filter(Boolean);
  if (listed.length !== source.expectedCommits.length || listed.some((commit, i) => commit !== source.expectedCommits[i])) throw new DeliveryError('SESSION_CHANGED');
  const changed = decode((await runGit(sandboxRoot, ['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', baseCommit, head])).out).split('\0').filter(Boolean);
  if (!changed.length) throw new DeliveryError('NO_CHANGES');
  const formatted = await runGit(sandboxRoot, [
    'format-patch', '--stdout', '--binary', '--full-index', '--no-signature', '--no-cover-letter', '--no-attach', '--no-add-header', '--no-to', '--no-cc',
    '--no-notes', '--no-base', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `${baseCommit}..${head}`,
  ], { timeoutMs: 120_000 });
  if (formatted.code !== 0 || !formatted.out.length) throw new DeliveryError('DELIVERY_FAILED');
  if (formatted.out.length > MAX_SERIES_BYTES) throw new DeliveryError('TOO_LARGE');
  const tree = await gitOk(sandboxRoot, ['rev-parse', `${head}^{tree}`]);
  return { commits: listed, head, tree, files: changed, mbox: formatted.out };
}

// ---- the person's checkout, read only ----

export interface BaseChoices {
  pass: { commit: string };
  /** The checkout's current commit and branch (null when detached). Never changed. */
  head: { commit: string; branch: string | null } | null;
  /** True when the checkout has moved past the commit the pass started from. */
  advanced: boolean;
}
export async function readBases(repo: string, baseCommit: string): Promise<BaseChoices> {
  const head = await runGit(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const commit = head.code === 0 ? decode(head.out).trim() : null;
  const branch = commit ? decode((await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out).trim() || null : null;
  return { pass: { commit: baseCommit }, head: commit ? { commit, branch } : null, advanced: commit !== null && commit !== baseCommit };
}

// ---- the temporary worktree ----

async function userIdentity(repo: string): Promise<Record<string, string>> {
  const read = async (key: string) => decode((await runGit(repo, ['config', '--get', key])).out).trim();
  const name = (await read('user.name')) || 'Neat';
  const email = (await read('user.email')) || 'sandbox@neatlabs.design';
  return { GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Remove the throwaway worktree and its record in the repository, even if git could not do it itself. */
async function discardWorktree(repo: string, dir: string, tree: string, resolvedTree: string): Promise<void> {
  await runGit(repo, ['worktree', 'remove', '--force', '--force', tree]);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  const common = decode((await runGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).out).trim();
  if (!common) return;
  const records = join(common, 'worktrees');
  for (const name of await readdir(records).catch(() => [])) {
    const pointer = await readFile(join(records, name, 'gitdir'), 'utf8').catch(() => '');
    if (pointer.trim() === join(resolvedTree, '.git')) await rm(join(records, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface DeliveredBranch {
  branch: string;
  requested: string;
  commit: string;
  /** The commit the branch is rooted on, and which choice that was. */
  root: { kind: 'pass' | 'head'; commit: string };
  commits: number;
  files: string[];
}
export interface BranchOptions {
  slug: string;
  base: 'pass' | 'head';
  /** Where the temporary worktree goes. The system temp folder by default. */
  tempRoot?: string;
  /** Runs once the commits exist and before the branch is installed. Tests use it to move the checkout. */
  beforeInstall?: () => Promise<void>;
}

/**
 * Apply the series with `git am -3` in a temporary worktree, then add `neat/<slug>` pointing at the result. The branch
 * is created last and only if absent, so a conflict or a crash leaves the repository with no new branch. An existing
 * branch is never moved: the next free numeric suffix is used instead.
 */
export async function deliverBranch(source: DeliverySource, options: BranchOptions): Promise<DeliveredBranch> {
  const { repo } = source;
  const series = await readSeries(source);
  const rootCommit = options.base === 'head' ? (await readBases(repo, source.baseCommit)).head?.commit : source.baseCommit;
  if (!rootCommit) throw new DeliveryError('BASE_MISSING');
  const dir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'neat-deliver-'));
  const resolvedDir = await realpath(dir);
  const tree = join(dir, 'tree');
  const resolvedTree = join(resolvedDir, 'tree');
  try {
    if ((await runGit(repo, ['worktree', 'add', '--detach', '--quiet', tree, rootCommit])).code !== 0) throw new DeliveryError('DELIVERY_FAILED');
    const mailbox = join(dir, 'series.mbox');
    await writeFile(mailbox, series.mbox, { mode: 0o600 });
    const env = await userIdentity(repo);
    const applied = await runGit(tree, ['am', '--3way', '--keep-cr', '--quiet', mailbox], { env, timeoutMs: 120_000 });
    if (applied.code !== 0) {
      await runGit(tree, ['am', '--abort']);
      throw new DeliveryError('CONFLICT');
    }
    const result = await gitOk(tree, ['rev-parse', '--verify', 'HEAD^{commit}']);
    const count = Number(await gitOk(tree, ['rev-list', '--count', `${rootCommit}..${result}`]));
    if (count !== series.commits.length) throw new DeliveryError('DELIVERY_FAILED');
    // On the pass's own base the result must be exactly the session's tree: nothing added, nothing missing.
    if (rootCommit === source.baseCommit && (await gitOk(tree, ['rev-parse', `${result}^{tree}`])) !== series.tree) throw new DeliveryError('DELIVERY_FAILED');
    await options.beforeInstall?.();
    if (options.base === 'head' && (await readBases(repo, source.baseCommit)).head?.commit !== rootCommit) throw new DeliveryError('HEAD_MOVED');
    const zero = '0'.repeat(result.length);
    for (let attempt = 1; attempt <= MAX_SUFFIX; attempt++) {
      const branch = branchFor(options.slug, attempt);
      // Creating needs the old value to be "absent", so an existing branch is never replaced, even by a concurrent run.
      const made = await runGit(repo, ['update-ref', '-m', 'neat: deliver pass', `refs/heads/${branch}`, result, zero]);
      if (made.code === 0) return { branch, requested: branchFor(options.slug), commit: result, root: { kind: options.base, commit: rootCommit }, commits: count, files: series.files };
    }
    throw new DeliveryError('BRANCH_NAME_TAKEN');
  } finally {
    await discardWorktree(repo, dir, tree, resolvedTree);
  }
}

// ---- patch export ----

export const exportsHome = () => join(process.env.NEAT_HOME ?? join(homedir(), '.neat'), 'exports');
const EXPORT_NAME = /^neat-[a-z0-9-]{0,48}-\d{8}T\d{6}Z-[0-9a-f]{8}\.patch$/;
export const isExportName = (name: string) => EXPORT_NAME.test(name);

export interface ExportedPatch { name: string; bytes: number; commits: number; files: string[] }

/** The export folder as a real directory. A symbolic link in its place is refused, so a write cannot be redirected. */
async function openExportRoot() {
  const path = exportsHome();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) throw new DeliveryError('EXPORT_UNSAFE');
  const root = await realpath(path);
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW).catch(() => { throw new DeliveryError('EXPORT_UNSAFE'); });
  const pinned = await directory.stat({ bigint: true });
  if (pinned.ino !== info.ino || pinned.dev !== info.dev) { await directory.close(); throw new DeliveryError('EXPORT_UNSAFE'); }
  // Descriptor-relative paths keep creation, reads, and cleanup bound to this directory if its name is replaced.
  return { directory, root, device: String(pinned.dev), inode: String(pinned.ino), base: `/proc/self/fd/${directory.fd}` };
}

/** Non-Linux fallback: a child validates its cwd identity, then performs relative operations there. */
async function directoryProcess(root: Awaited<ReturnType<typeof openExportRoot>>, mode: 'read' | 'write', name: string, input: Uint8Array, beforeFile?: () => Promise<void>): Promise<Uint8Array<ArrayBuffer>> {
  const child = Bun.spawn([process.execPath, '--no-env-file', `--config=${join(import.meta.dir, 'export-process.toml')}`, join(import.meta.dir, 'export-file.ts'), mode, name, root.device, root.inode, root.root], {
    cwd: import.meta.dir, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore', env: {}, timeout: 30_000,
  });
  const reader = child.stdout.getReader();
  try {
    const ready = await reader.read();
    if (ready.done || new TextDecoder().decode(ready.value) !== 'READY\n') throw new DeliveryError(mode === 'read' ? 'EXPORT_MISSING' : 'EXPORT_UNSAFE');
    await beforeFile?.();
    child.stdin.write(input);
    child.stdin.end();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.length;
      if (length > MAX_SERIES_BYTES) throw new DeliveryError('TOO_LARGE');
      chunks.push(part.value);
    }
    if (await child.exited !== 0) throw new DeliveryError(mode === 'read' ? 'EXPORT_MISSING' : 'EXPORT_UNSAFE');
    const out = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
    return out;
  } finally { reader.releaseLock(); if (child.exitCode === null) child.kill(); await child.exited; }
}

/** Write a mailbox through a pinned directory descriptor. The request never picks a filesystem path. */
export async function exportSeries(source: DeliverySource, options: { slug: string; now?: Date; beforeFile?: () => Promise<void>; useProcess?: boolean }): Promise<ExportedPatch> {
  const series = await readSeries(source);
  const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const name = `neat-${options.slug}-${stamp}-${randomBytes(4).toString('hex')}.patch`;
  if (!isExportName(name)) throw new DeliveryError('DELIVERY_FAILED');
  const pinned = await openExportRoot();
  const { directory, base } = pinned;
  try {
    if (process.platform !== 'linux' || options.useProcess) {
      await directoryProcess(pinned, 'write', name, series.mbox, options.beforeFile);
      return { name, bytes: series.mbox.length, commits: series.commits.length, files: series.files };
    }
    await options.beforeFile?.();
    const path = join(base, name);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600).catch(() => { throw new DeliveryError('EXPORT_UNSAFE'); });
    try { await handle.writeFile(series.mbox); await handle.sync(); }
    catch (error) { await handle.close(); await rm(path, { force: true }); throw error; }
    await handle.close();
    return { name, bytes: series.mbox.length, commits: series.commits.length, files: series.files };
  } finally { await directory.close(); }
}

/** Read only through the pinned export directory and refuse links at the file itself. */
export async function readExport(name: string, options: { beforeFile?: () => Promise<void>; beforeStart?: () => Promise<void>; useProcess?: boolean } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (!isExportName(name)) throw new DeliveryError('EXPORT_MISSING');
  const pinned = await openExportRoot();
  const { directory, base } = pinned;
  try {
    if (process.platform !== 'linux' || options.useProcess) {
      await options.beforeStart?.();
      return await directoryProcess(pinned, 'read', name, new Uint8Array(), options.beforeFile);
    }
    await options.beforeFile?.();
    const handle = await open(join(base, name), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => { throw new DeliveryError('EXPORT_MISSING'); });
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_SERIES_BYTES) throw new DeliveryError('EXPORT_MISSING');
      return new Uint8Array(await handle.readFile());
    } finally { await handle.close(); }
  } finally { await directory.close(); }
}

// ---- pull request ----

export interface CommandResult { code: number; out: string }
/** Runs the GitHub command line tool with an argument list. A seam so tests never reach GitHub. */
export type GithubRunner = (args: string[], options: { cwd: string; input?: string }) => Promise<CommandResult>;

export const runGithub: GithubRunner = async (args, { cwd, input }) => {
  try {
    const proc = Bun.spawn(['gh', ...args], {
      cwd, stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'ignore', timeout: 60_000,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat' },
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, out };
  } catch { return { code: 127, out: '' }; }
};

export type GithubState = 'ready' | 'missing' | 'signed-out';
/** Read only: asks the tool whether it is installed and signed in. */
export async function githubState(run: GithubRunner, cwd: string): Promise<GithubState> {
  const result = await run(['auth', 'status'], { cwd });
  return result.code === 0 ? 'ready' : result.code === 127 ? 'missing' : 'signed-out';
}

const BASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
/** A base branch that exists on origin. The default is origin's own default branch. */
async function resolveBase(repo: string, requested: string | undefined): Promise<string> {
  const exists = async (name: string) => BASE_PATTERN.test(name) && (await runGit(repo, ['check-ref-format', `refs/heads/${name}`])).code === 0
    && (await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`])).code === 0;
  if (requested !== undefined && requested !== '') {
    if (!(await exists(requested))) throw new DeliveryError('BASE_UNKNOWN');
    return requested;
  }
  const symbolic = decode((await runGit(repo, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'])).out).trim().replace(/^origin\//, '');
  for (const candidate of [symbolic, 'main', 'master']) if (candidate && await exists(candidate)) return candidate;
  throw new DeliveryError('BASE_UNKNOWN');
}

const listedSchema = z.array(z.object({ url: z.string().url(), headRefName: z.string(), isCrossRepository: z.boolean() }));
const pullUrl = (text: string) => text.split('\n').map((line) => line.trim()).reverse().find((line) => /^https:\/\/[^\s]+\/pull\/\d+$/.test(line));

async function sshHostname(host: string): Promise<string> {
  try {
    const child = Bun.spawn(['ssh', '-G', '--', host], { stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 5_000 });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    const hostname = /^hostname\s+([^\s]+)$/m.exec(text)?.[1];
    return code === 0 && hostname && /^[a-zA-Z0-9.-]+$/.test(hostname) ? hostname : host;
  } catch { return host; }
}

/** Resolve SSH aliases before passing an explicit push destination to the GitHub CLI. */
export async function githubRepository(remote: string, hostname: (host: string) => Promise<string> = sshHostname): Promise<string> {
  let url: URL | null = null;
  try { url = new URL(remote); } catch { /* A local path or SCP-style remote is not a URL. */ }
  if (url && ['http:', 'https:', 'ssh:', 'git:'].includes(url.protocol)) {
    url.username = ''; url.password = '';
    if (url.protocol === 'ssh:') {
      const host = await hostname(url.hostname);
      return `https://${host}${url.pathname}`;
    }
    return url.toString();
  }
  const scp = /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(remote);
  if (scp) return `https://${await hostname(scp[1]!)}/${scp[2]}`;
  return remote;
}

export interface OpenedPullRequest { url: string; reused: boolean; base: string }
export interface PullRequestInput {
  repo: string;
  /** The delivered branch and the commit it was delivered at. Both come from the session, never the request. */
  branch: string;
  commit: string;
  baseBranch?: string;
  title: string;
  body: string;
}

/**
 * Push the delivered commit to origin under the delivered branch name, then open a pull request for it, or return the
 * one that is already open. The branch must still point at the delivered commit. Nothing is forced.
 */
export async function openPullRequest(input: PullRequestInput, run: GithubRunner): Promise<OpenedPullRequest> {
  const { repo, branch, commit } = input;
  if (!isDeliveryBranch(branch) || !isCommitId(commit)) throw new DeliveryError('NO_DELIVERY');
  const state = await githubState(run, repo);
  if (state === 'missing') throw new DeliveryError('GITHUB_MISSING');
  if (state === 'signed-out') throw new DeliveryError('GITHUB_SIGNED_OUT');
  const current = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (current.code !== 0 || decode(current.out).trim() !== commit) throw new DeliveryError('BRANCH_CHANGED');
  if ((await runGit(repo, ['remote', 'get-url', 'origin'])).code !== 0) throw new DeliveryError('NO_ORIGIN');
  const remote = await gitOk(repo, ['remote', 'get-url', '--push', 'origin']);
  let repository = await githubRepository(remote);
  const resolved = await run(['repo', 'view', '--json', 'url', '--', repository], { cwd: repo });
  const parsedRepo = z.object({ url: z.string().url().refine(value => new URL(value).protocol === 'https:') }).safeParse(
    await Promise.resolve().then(() => JSON.parse(resolved.out)).catch(() => null),
  );
  if (resolved.code !== 0 || !parsedRepo.success) throw new DeliveryError('GITHUB_FAILED');
  repository = parsedRepo.data.url;
  const base = await resolveBase(repo, input.baseBranch);
  const pushed = await runGit(repo, ['push', '--porcelain', '--no-verify', '--no-follow-tags', 'origin', `${commit}:refs/heads/${branch}`], { timeoutMs: 120_000 });
  if (pushed.code !== 0) throw new DeliveryError(decode(pushed.out).includes('[rejected]') ? 'PUSH_REJECTED' : 'PUSH_FAILED');

  const listed = await run(['pr', 'list', '--head', branch, '--base', base, '--state', 'open', '--limit', '5', '--json', 'url,headRefName,isCrossRepository', '--repo', repository], { cwd: repo });
  if (listed.code !== 0) throw new DeliveryError('GITHUB_FAILED');
  const parsed = listedSchema.safeParse(JSON.parse(listed.out || '[]'));
  if (!parsed.success) throw new DeliveryError('GITHUB_FAILED');
  const existing = parsed.data.find((pr) => pr.headRefName === branch && !pr.isCrossRepository);
  if (existing) return { url: existing.url, reused: true, base };

  const created = await run(['pr', 'create', '--head', branch, '--base', base, `--title=${input.title}`, '--body-file', '-', '--repo', repository], { cwd: repo, input: input.body });
  const url = created.code === 0 ? pullUrl(created.out) : undefined;
  if (!url) throw new DeliveryError('GITHUB_FAILED');
  return { url, reused: false, base };
}

const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);
/** Title and body for the pull request, from the kept step summaries. */
export function pullRequestText(summaries: string[]): { title: string; body: string } {
  const lines = summaries.slice(0, 50).map((summary) => `- ${oneLine(summary, 200)}`);
  const title = summaries.length === 1 ? oneLine(summaries[0]!, 100) : `Neat Labs edits: ${oneLine(summaries[0] ?? 'changes', 70)} and ${Math.max(summaries.length - 1, 0)} more`;
  return { title: title || 'Neat Labs edits', body: `Changes kept in the Neat Labs editor:\n\n${lines.join('\n')}\n` };
}

// ---- what the session remembers and shows ----

export interface DeliveryView {
  branch: { name: string; requested: string; commit: string; root: DeliveredBranch['root']; commits: number; files: string[]; at: string; stale: boolean } | null;
  exports: Array<ExportedPatch & { at: string }>;
  pr: { url: string; reused: boolean; base: string } | null;
}
