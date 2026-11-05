import { $ } from 'bun';
import { z } from 'zod';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorker } from './server';
import { slugify, type CommandResult, type GithubRunner } from './delivery';
import { commitAll, head, makeRepo, openSession, ORIGIN, PAGE, tagOf, worktreeProvider, type TestRepo } from './test-support';

const savedHome = process.env.NEAT_HOME;
let t: TestRepo;
let scratch: string;
beforeEach(async () => {
  t = await makeRepo();
  process.env.NEAT_HOME = t.home;
  scratch = await mkdtemp(join(tmpdir(), 'neat-deliver-test-'));
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.NEAT_HOME; else process.env.NEAT_HOME = savedHome;
  await t.cleanup();
  await rm(scratch, { recursive: true, force: true });
});

interface GhCall { args: string[]; input?: string }
interface Stubs { repo: CommandResult; auth: CommandResult; list: CommandResult; create: CommandResult }
const READY: Stubs = {
  repo: { code: 0, out: '{"url":"https://github.com/example/app"}' },
  auth: { code: 0, out: '' },
  list: { code: 0, out: '[]' },
  create: { code: 0, out: 'https://github.com/example/app/pull/7\n' },
};
/** A GitHub runner that records what it was asked and answers from a script. It never leaves the process. */
function fakeGithub(stubs: Partial<Stubs> = {}) {
  const calls: GhCall[] = [];
  const answers = { ...READY, ...stubs };
  const run: GithubRunner = async (args, options) => {
    calls.push({ args, input: options.input });
    if (args[0] === 'auth') return answers.auth;
    if (args[0] === 'repo' && args[1] === 'view') return answers.repo;
    if (args[0] === 'pr' && args[1] === 'list') return answers.list;
    if (args[0] === 'pr' && args[1] === 'create') return answers.create;
    return { code: 1, out: '' };
  };
  const writes = () => calls.filter((c) => c.args[0] === 'pr' && c.args[1] === 'create');
  return { run, calls, writes };
}

const deliverySchema = z.object({
  branch: z.object({ name: z.string(), requested: z.string(), commit: z.string(), root: z.object({ kind: z.enum(['pass', 'head']), commit: z.string() }), commits: z.number(), files: z.array(z.string()), at: z.string(), stale: z.boolean() }).nullable(),
  exports: z.array(z.object({ name: z.string(), bytes: z.number(), commits: z.number(), files: z.array(z.string()), at: z.string() })),
  pr: z.object({ url: z.string(), reused: z.boolean(), base: z.string() }).nullable(),
});
const timelineSchema = z.array(z.object({ id: z.string(), summary: z.string(), status: z.string() }));
const bodySchema = z.object({
  error: z.string().optional(), id: z.string().optional(), code: z.string().optional(), file: z.string().optional(), github: z.string().nullable().optional(),
  delivery: deliverySchema.nullable().optional(), timeline: timelineSchema.optional(),
  bases: z.object({ advanced: z.boolean(), pass: z.object({ commit: z.string() }), head: z.object({ commit: z.string(), branch: z.string().nullable() }).nullable() }).nullable().optional(),
  sessions: z.array(z.object({ delivery: deliverySchema.nullable(), timeline: timelineSchema })).optional(),
});

async function run(options: { durable?: boolean; repo?: TestRepo; github?: GithubRunner; beforeInstall?: () => Promise<void> } = {}) {
  const repo = options.repo ?? t;
  const provider = { ...worktreeProvider(repo), ...(options.durable === false ? { durable: false } : {}) };
  const worker = createWorker({
    repo: repo.repo, app: repo.app === '.' ? undefined : repo.app, origin: ORIGIN, shell: new Map(), provider, editClient: null,
    delivery: { github: options.github, tempRoot: scratch, beforeInstall: options.beforeInstall },
  });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { host: '127.0.0.1:44317' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    const raw = new Uint8Array(await res.arrayBuffer());
    let json: z.infer<typeof bodySchema> = {};
    try { json = bodySchema.parse(JSON.parse(new TextDecoder().decode(raw))); } catch { /* a download */ }
    return { status: res.status, json, raw, headers: res.headers };
  };
  const { prefix } = await openSession(async (path, method, body) => {
    const r = await call(path, method, body);
    return { status: r.status, body: { id: r.json.id } };
  }, repo);
  const dir = provider.dirs.get(prefix.split('/').pop()!)!.dir;
  const edit = async (tag: string, operations: unknown[]) => {
    expect((await call(`${prefix}/edit`, 'POST', { tag, operations })).status).toBe(200);
  };
  const keep = async () => expect((await call(`${prefix}/keep`, 'POST', {})).status).toBe(200);
  const delivery = `${prefix}/delivery`;
  return { call, prefix, dir, edit, keep, delivery, close: () => worker.close(), provider, edited: async (tag: string, op: unknown[]) => { await edit(tag, op); await keep(); } };
}
type Run = Awaited<ReturnType<typeof run>>;

const h1 = tagOf(PAGE, 'app/page.tsx', '<h1');
const para = tagOf(PAGE, 'app/page.tsx', '<p ');
const list = tagOf(PAGE, 'app/page.tsx', '<ul');
const widen = [{ op: 'replace-class', target: list, from: 'gap-2', to: 'gap-4' }];
const setText = (text: string) => [{ op: 'set-text', target: h1, text }];

async function keepTwo(r: Run) {
  await r.edited(h1, setText('Welcome'));
  await r.edited(para, [{ op: 'replace-class', target: para, from: 'mt-2', to: 'mt-4' }]);
}

/** Everything a branch creation must leave alone in the person's checkout. */
async function snapshot(repo: string) {
  const git = async (...args: string[]) => (await $`git ${args}`.env({ ...process.env, GIT_OPTIONAL_LOCKS: '0' }).cwd(repo).quiet().text());
  return {
    head: (await git('rev-parse', 'HEAD')).trim(),
    symbolic: (await $`git symbolic-ref -q HEAD`.cwd(repo).quiet().nothrow().text()).trim(),
    status: await git('status', '--porcelain=v2', '--branch', '--untracked-files=all'),
    index: await git('ls-files', '--stage'),
    staged: await git('diff', '--cached'),
    unstaged: await git('diff'),
    branches: (await git('for-each-ref', '--format=%(refname)', 'refs/heads')).trim().split('\n').filter(Boolean),
    indexFile: await readFile(join(repo, '.git/index')),
  };
}
const worktrees = async (repo: string) => (await $`git worktree list --porcelain`.cwd(repo).quiet().text()).split('\n').filter((l) => l.startsWith('worktree '));
const leftovers = async () => (await readdir(scratch)).filter((name) => name.startsWith('neat-deliver-'));
const adminRecords = async (repo: string) => readdir(join(repo, '.git/worktrees')).catch(() => [] as string[]);
const show = async (repo: string, ref: string, file: string) => (await $`git show ${ref}:${file}`.cwd(repo).quiet().text());
const create = (r: Run, body: Record<string, unknown> = {}) => r.call(`${r.delivery}/branch`, 'POST', body);

test('slugify keeps branch names to lowercase words', () => {
  expect(slugify('Make the Hero BIGGER!!')).toBe('make-the-hero-bigger');
  expect(slugify('../../etc/passwd')).toBe('etc-passwd');
  expect(slugify('--refs/heads/main--')).toBe('refs-heads-main');
  expect(slugify('日本語')).toBe('');
  expect(slugify('a'.repeat(80))).toHaveLength(48);
});

test('Create branch adds neat/<slug> with the whole series, authors, and messages, and leaves a dirty checkout alone', async () => {
  const r = await run();
  await keepTwo(r);
  // A dirty checkout: staged, unstaged, and untracked work, on a named branch.
  await writeFile(join(t.repo, 'app/layout.tsx'), (await readFile(join(t.repo, 'app/layout.tsx'), 'utf8')) + '// staged\n');
  await $`git add app/layout.tsx`.cwd(t.repo).quiet();
  await writeFile(join(t.repo, 'app/page.tsx'), PAGE + '// unstaged\n');
  await writeFile(join(t.repo, 'scratch.txt'), 'untracked');
  const before = await snapshot(t.repo);
  const base = await head(t.repo);

  const made = await create(r, { slug: 'Hero Copy' });
  expect(made.status).toBe(201);
  const branch = made.json.delivery!.branch!;
  expect(branch).toMatchObject({ name: 'neat/hero-copy', requested: 'neat/hero-copy', commits: 2, files: ['app/page.tsx'], stale: false, root: { kind: 'pass', commit: base } });

  const after = await snapshot(t.repo);
  expect(after.branches).toEqual([...before.branches, 'refs/heads/neat/hero-copy'].sort());
  expect({ ...after, branches: 0 }).toEqual({ ...before, branches: 0 });
  expect(await readFile(join(t.repo, 'scratch.txt'), 'utf8')).toBe('untracked');

  const log = (await $`git log --reverse --format=%an%x09%ae%x09%s ${base}..neat/hero-copy`.cwd(t.repo).quiet().text()).trim().split('\n');
  expect(log).toEqual(['Neat\tsandbox@neatlabs.design\tChange text to "Welcome"', 'Neat\tsandbox@neatlabs.design\tChange mt-2 to mt-4']);
  expect(await show(t.repo, 'neat/hero-copy', 'app/page.tsx')).toContain('<h1 className="text-xl">Welcome</h1>');
  expect(await show(t.repo, 'neat/hero-copy', 'app/page.tsx')).toContain('mt-4');
  expect((await $`git rev-parse neat/hero-copy^{tree}`.cwd(t.repo).quiet().text()).trim()).toBe((await $`git rev-parse HEAD^{tree}`.cwd(r.dir).quiet().text()).trim());
  expect(await leftovers()).toEqual([]);
  expect((await worktrees(t.repo)).filter((line) => line.includes('neat-deliver'))).toEqual([]);
  expect((await worktrees(t.repo)).filter((line) => line.endsWith(t.repo))).toHaveLength(1);
  await r.close();
});

test('the delivered branch carries no preview injection, and the session still replays after it', async () => {
  const r = await run();
  await keepTwo(r);
  const made = await create(r);
  expect(made.status).toBe(201);
  const names = (await $`git diff --name-only ${await head(t.repo)} neat/${made.json.delivery!.branch!.name.slice(5)}`.cwd(t.repo).quiet().text()).trim().split('\n');
  expect(names).toEqual(['app/page.tsx']);
  await r.close();
  // Quit and reopen: the pass is still there, not closed by delivery.
  const again = await run();
  const listed = await again.call('/api/editor/sessions');
  expect(listed.json.sessions![0]!.timeline.map((s: { summary: string }) => s.summary)).toEqual(['Change text to "Welcome"', 'Change mt-2 to mt-4']);
  await again.close();
});

test('a taken name gets the next numeric suffix and the existing branch is not moved', async () => {
  await $`git branch neat/hero-copy`.cwd(t.repo).quiet();
  const old = (await $`git rev-parse neat/hero-copy`.cwd(t.repo).quiet().text()).trim();
  const r = await run();
  await keepTwo(r);
  const first = await create(r, { slug: 'hero-copy' });
  expect(first.json.delivery!.branch).toMatchObject({ name: 'neat/hero-copy-2', requested: 'neat/hero-copy' });
  const second = await create(r, { slug: 'hero-copy' });
  expect(second.json.delivery!.branch!.name).toBe('neat/hero-copy-3');
  expect((await $`git rev-parse neat/hero-copy`.cwd(t.repo).quiet().text()).trim()).toBe(old);
  await r.close();
});

test('a plain branch called neat blocks neat/<slug>, and the answer is a fixed message', async () => {
  await $`git branch neat`.cwd(t.repo).quiet();
  const r = await run();
  await keepTwo(r);
  const made = await create(r, { slug: 'x' });
  expect(made.status).toBe(409);
  expect(made.json).toEqual({ error: 'No free branch name was found for that slug. Choose another.', code: 'BRANCH_NAME_TAKEN' });
  expect(await leftovers()).toEqual([]);
  await r.close();
});

test('an advanced checkout can still deliver on the pass base, or rebase onto the current HEAD', async () => {
  const r = await run();
  await keepTwo(r);
  const base = await head(t.repo);
  await writeFile(join(t.repo, 'NOTES.md'), 'newer');
  await commitAll(t.repo, 'newer work');
  const tip = await head(t.repo);
  const info = await r.call(r.delivery);
  expect(info.json.bases).toMatchObject({ advanced: true, pass: { commit: base }, head: { commit: tip, branch: expect.any(String) } });

  const onBase = await create(r, { slug: 'on-base' });
  expect(onBase.json.delivery!.branch!.root).toEqual({ kind: 'pass', commit: base });
  expect((await $`git merge-base neat/on-base ${tip}`.cwd(t.repo).quiet().text()).trim()).toBe(base);

  const rebased = await create(r, { slug: 'on-head', base: 'head' });
  expect(rebased.status).toBe(201);
  expect(rebased.json.delivery!.branch!.root).toEqual({ kind: 'head', commit: tip });
  expect((await $`git rev-parse neat/on-head~2`.cwd(t.repo).quiet().text()).trim()).toBe(tip);
  expect(await show(t.repo, 'neat/on-head', 'NOTES.md')).toBe('newer');
  expect(await show(t.repo, 'neat/on-head', 'app/page.tsx')).toContain('Welcome');
  expect(await head(t.repo)).toBe(tip);
  await r.close();
});

test('a detached checkout delivers on the pass base and on its detached commit', async () => {
  const r = await run();
  await keepTwo(r);
  await writeFile(join(t.repo, 'NOTES.md'), 'newer');
  await commitAll(t.repo, 'newer work');
  await $`git checkout -q --detach`.cwd(t.repo).quiet();
  const before = await snapshot(t.repo);
  expect((await r.call(r.delivery)).json.bases!.head!.branch).toBeNull();
  expect((await create(r, { slug: 'detached', base: 'head' })).status).toBe(201);
  const after = await snapshot(t.repo);
  expect(after.symbolic).toBe('');
  expect({ ...after, branches: 0 }).toEqual({ ...before, branches: 0 });
  await r.close();
});

test('a conflict on the current HEAD creates no branch and no leftover worktree, and the pass base still works', async () => {
  const r = await run();
  await keepTwo(r);
  await writeFile(join(t.repo, 'app/page.tsx'), PAGE.replace('<h1 className="text-xl">Hello</h1>', '<h1 className="text-xl">Goodbye</h1>'));
  await commitAll(t.repo, 'conflicting rewrite');
  const before = await snapshot(t.repo);
  const refs = await $`git for-each-ref`.cwd(t.repo).quiet().text();

  const conflict = await create(r, { slug: 'clash', base: 'head' });
  expect(conflict.status).toBe(409);
  expect(conflict.json).toEqual({ error: 'The kept steps do not apply cleanly on that base. Nothing was created. Try the other base.', code: 'CONFLICT' });
  expect(await $`git for-each-ref`.cwd(t.repo).quiet().text()).toBe(refs);
  expect(await snapshot(t.repo)).toEqual(before);
  expect(await leftovers()).toEqual([]);
  expect(await adminRecords(t.repo)).toEqual(expect.not.arrayContaining(['neat-deliver']));
  expect((await worktrees(t.repo)).filter((line) => line.includes('neat-deliver'))).toEqual([]);

  expect((await create(r, { slug: 'clash' })).status).toBe(201);
  await r.close();
});

test('the checkout moving while the branch is built refuses the delivery and creates nothing', async () => {
  let moved = false;
  const r = await run({
    beforeInstall: async () => {
      if (moved) return;
      moved = true;
      await writeFile(join(t.repo, 'MOVED.md'), 'x');
      await commitAll(t.repo, 'moved during delivery');
    },
  });
  await keepTwo(r);
  const refs = await $`git for-each-ref refs/heads`.cwd(t.repo).quiet().text();
  const raced = await create(r, { slug: 'race', base: 'head' });
  expect(raced.status).toBe(409);
  expect(raced.json.code).toBe('HEAD_MOVED');
  const after = await $`git for-each-ref refs/heads`.cwd(t.repo).quiet().text();
  expect(after.replace(/[0-9a-f]{40}/g, '').split('\n').sort()).toEqual(refs.replace(/[0-9a-f]{40}/g, '').split('\n').sort());
  expect(await $`git branch --list neat/race`.cwd(t.repo).quiet().text()).toBe('');
  expect(await leftovers()).toEqual([]);
  expect((await create(r, { slug: 'race', base: 'head' })).status).toBe(201);
  await r.close();
});

test('refuses with no kept steps, with steps that cancel out, and while a change or proposal is waiting', async () => {
  const r = await run();
  expect(await create(r)).toMatchObject({ status: 422, json: { code: 'NO_COMMITS' } });
  expect((await r.call(`${r.delivery}/export`, 'POST', {})).json.code).toBe('NO_COMMITS');

  await r.edit(h1, setText('Pending'));
  expect(await create(r)).toMatchObject({ status: 409, json: { code: 'PENDING_CHANGE' } });
  expect((await r.call(`${r.delivery}/export`, 'POST', {})).json.code).toBe('PENDING_CHANGE');
  await r.keep();
  // Undo the only step: it is the newest, so it leaves no commit at all.
  const step = (await r.call(r.prefix)).json.timeline![0]!.id;
  expect((await r.call(`${r.prefix}/undo`, 'POST', { step })).status).toBe(200);
  expect(await create(r)).toMatchObject({ status: 422, json: { code: 'NO_COMMITS' } });

  // Two steps, the first taken back by a later revert step: commits exist but the net change is empty.
  await r.edited(h1, setText('A'));
  await r.edited(list, widen);
  const ids = (await r.call(r.prefix)).json.timeline!.filter((s: { status: string }) => s.status === 'kept').map((s: { id: string }) => s.id);
  expect((await r.call(`${r.prefix}/undo`, 'POST', { step: ids[0] })).status).toBe(200);
  expect((await r.call(`${r.prefix}/undo`, 'POST', { step: ids[1] })).status).toBe(200);
  expect(await create(r)).toMatchObject({ status: 422, json: { code: 'NO_CHANGES' } });
  expect(await $`git branch --list ${'neat/*'}`.cwd(t.repo).quiet().text()).toBe('');
  await r.close();
});

test('a reverted middle step stays in the series and the branch matches the session', async () => {
  const r = await run();
  await r.edited(h1, setText('One'));
  await r.edited(list, widen);
  const first = (await r.call(r.prefix)).json.timeline![0]!.id;
  expect((await r.call(`${r.prefix}/undo`, 'POST', { step: first })).status).toBe(200);
  const made = await create(r, { slug: 'with-revert' });
  expect(made.json.delivery!.branch!.commits).toBe(3);
  const text = await show(t.repo, 'neat/with-revert', 'app/page.tsx');
  expect(text).toContain('<h1 className="text-xl">Hello</h1>');
  expect(text).toContain('gap-4');
  await r.close();
});

test('user hooks and signing do not run for a delivery', async () => {
  const r = await run();
  await keepTwo(r);
  // The person's hooks and signing are installed after the session exists, as they would be in any repository.
  const marker = join(scratch, 'hook-ran');
  await mkdir(join(t.repo, '.git/hooks'), { recursive: true });
  for (const hook of ['post-checkout', 'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'reference-transaction', 'post-commit']) {
    await writeFile(join(t.repo, '.git/hooks', hook), `#!/bin/sh\necho ${hook} >> '${marker}'\nexit 1\n`, { mode: 0o755 });
  }
  await $`git config commit.gpgsign true`.cwd(t.repo).quiet();
  await $`git config gpg.program /bin/false`.cwd(t.repo).quiet();
  await $`git config user.name ${'Real Person'}`.cwd(t.repo).quiet();
  await $`git config user.email person@example.com`.cwd(t.repo).quiet();
  expect((await create(r, { slug: 'quiet' })).status).toBe(201);
  expect(await Bun.file(marker).exists()).toBe(false);
  // The person's identity commits it, and the session's author stays.
  expect((await $`git log -1 --format=%an,%cn,%ce neat/quiet`.cwd(t.repo).quiet().text()).trim()).toBe('Neat,Real Person,person@example.com');
  await r.close();
});

test('an --app monorepo delivers repo-relative paths and keeps the rest of the repository out', async () => {
  const mono = await makeRepo({ app: 'apps/web', files: {} });
  await writeFile(join(mono.repo, 'README.md'), 'root');
  await commitAll(mono.repo, 'root file');
  process.env.NEAT_HOME = mono.home;
  const r = await run({ repo: mono });
  const page = await readFile(join(r.dir, 'app/page.tsx'), 'utf8');
  const tag = tagOf(page, 'app/page.tsx', '<h1');
  await r.edited(tag, [{ op: 'set-text', target: tag, text: 'Monorepo' }]);
  const made = await create(r, { slug: 'mono' });
  expect(made.status).toBe(201);
  expect(made.json.delivery!.branch!.files).toEqual(['apps/web/app/page.tsx']);
  expect(await show(mono.repo, 'neat/mono', 'apps/web/app/page.tsx')).toContain('Monorepo');
  expect(await show(mono.repo, 'neat/mono', 'README.md')).toBe('root');
  const exported = await r.call(`${r.delivery}/export`, 'POST', {});
  const file = await r.call(`${r.delivery}/exports/${exported.json.file}`);
  expect(new TextDecoder().decode(file.raw)).toContain('diff --git a/apps/web/app/page.tsx b/apps/web/app/page.tsx');
  await r.close();
  await mono.cleanup();
});

test('line endings and binary files in the series survive a branch', async () => {
  const crlf = await makeRepo({ files: { 'notes.txt': 'one\r\ntwo\r\n', 'blob.bin': 'x' } });
  process.env.NEAT_HOME = crlf.home;
  const r = await run({ repo: crlf });
  await r.edited(h1, setText('Done'));
  expect((await create(r, { slug: 'eol' })).status).toBe(201);
  expect(await show(crlf.repo, 'neat/eol', 'notes.txt')).toBe('one\r\ntwo\r\n');
  await r.close();
  await crlf.cleanup();
});

test('export writes a .patch under NEAT_HOME/exports, serves it as an attachment, and it applies on its own', async () => {
  const r = await run();
  await keepTwo(r);
  const base = await head(t.repo);
  const before = await snapshot(t.repo);
  const exported = await r.call(`${r.delivery}/export`, 'POST', { slug: 'My Patch' });
  expect(exported.status).toBe(201);
  const name = exported.json.file!;
  expect(name).toMatch(/^neat-my-patch-\d{8}T\d{6}Z-[0-9a-f]{8}\.patch$/);
  expect(await snapshot(t.repo)).toEqual(before);
  expect((await readdir(join(t.home, 'exports')))).toEqual([name]);
  expect((await lstat(join(t.home, 'exports', name))).mode & 0o777).toBe(0o600);

  const download = await r.call(`${r.delivery}/exports/${name}`);
  expect(download.status).toBe(200);
  expect(download.headers.get('content-disposition')).toBe(`attachment; filename="${name}"`);
  expect(download.headers.get('x-content-type-options')).toBe('nosniff');
  const onDisk = new Uint8Array(await readFile(join(t.home, 'exports', name)));
  expect(download.raw).toEqual(onDisk);

  // The file applies by itself on a fresh clone of the base, with authors and messages intact.
  const clone = join(scratch, 'clone');
  await $`git clone -q ${t.repo} ${clone}`.quiet();
  await $`git checkout -q --detach ${base}`.cwd(clone).quiet();
  await $`git -c user.name=Reviewer -c user.email=reviewer@example.com am --3way ${join(t.home, 'exports', name)}`.cwd(clone).quiet();
  expect((await $`git log --reverse --format=%an%x09%s ${base}..HEAD`.cwd(clone).quiet().text()).trim()).toBe('Neat\tChange text to "Welcome"\nNeat\tChange mt-2 to mt-4');
  expect(await readFile(join(clone, 'app/page.tsx'), 'utf8')).toContain('Welcome');
  await r.close();
});

test('export refuses a symlinked export folder, serves only names it wrote, and never reads other files', async () => {
  const outside = join(scratch, 'outside');
  await mkdir(outside);
  await mkdir(t.home, { recursive: true });
  await symlink(outside, join(t.home, 'exports'));
  const r = await run();
  await keepTwo(r);
  const blocked = await r.call(`${r.delivery}/export`, 'POST', {});
  expect(blocked).toMatchObject({ status: 409, json: { code: 'EXPORT_UNSAFE' } });
  expect(await readdir(outside)).toEqual([]);
  await rm(join(t.home, 'exports'));

  const ok = await r.call(`${r.delivery}/export`, 'POST', {});
  const name = ok.json.file!;
  for (const bad of ['..%2f..%2fpasswd', 'neat-x-20260101T000000Z-deadbeef.patch', encodeURIComponent('/etc/passwd'), '.patch']) {
    expect((await r.call(`${r.delivery}/exports/${bad}`)).status).toBe(404);
  }
  // A link planted over a real export name is not followed.
  await rm(join(t.home, 'exports', name));
  await writeFile(join(outside, 'secret'), 'secret');
  await symlink(join(outside, 'secret'), join(t.home, 'exports', name));
  expect((await r.call(`${r.delivery}/exports/${name}`)).status).toBe(404);
  await r.close();
});

test('errors never carry paths, environment values, or git output', async () => {
  const r = await run();
  await keepTwo(r);
  await writeFile(join(t.repo, 'app/page.tsx'), PAGE.replace('Hello', 'Other'));
  await commitAll(t.repo, 'conflict');
  const conflict = await create(r, { base: 'head' });
  const text = JSON.stringify(conflict.json);
  for (const leak of [t.repo, t.temp, scratch, t.home, process.env.HOME ?? '/nonexistent-home', 'fatal', 'error:', 'patch failed']) expect(text).not.toContain(leak);
  await r.close();
});

test('branch, export, and a repeated branch never push or call the GitHub tool beyond reading its status', async () => {
  const remote = join(scratch, 'origin.git');
  await $`git init -q --bare ${remote}`.quiet();
  await $`git remote add origin ${remote}`.cwd(t.repo).quiet();
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'quiet' });
  await r.call(`${r.delivery}/export`, 'POST', {});
  const status = await r.call(r.delivery);
  expect(status.json.github).toBe('ready');
  expect(gh.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual(['auth status']);
  expect(await $`git for-each-ref`.cwd(remote).quiet().text()).toBe('');
  await r.close();
});

test('Open pull request pushes only the delivered commit, then creates the pull request with structured arguments', async () => {
  const remote = join(scratch, 'origin.git');
  await $`git init -q --bare ${remote}`.quiet();
  await $`git remote add origin ${remote}`.cwd(t.repo).quiet();
  await $`git branch -M main`.cwd(t.repo).quiet();
  await $`git push -q origin main`.cwd(t.repo).quiet();
  await $`git fetch -q origin`.cwd(t.repo).quiet();
  const gh = fakeGithub();
  await $`git remote add upstream https://github.com/other/upstream.git`.cwd(t.repo).quiet();
  await $`git config remote.upstream.gh-resolved base`.cwd(t.repo).quiet();
  const r = await run({ github: gh.run });
  await r.edited(h1, setText('Title; $(touch pwned)'));
  const made = await create(r, { slug: 'for-review' });
  const commit = made.json.delivery!.branch!.commit;
  const before = await snapshot(t.repo);

  // The request cannot name a branch or a ref; only a validated base branch is accepted.
  expect((await r.call(`${r.delivery}/pr`, 'POST', { branch: 'main', baseBranch: 'no-such' })).json.code).toBe('BASE_UNKNOWN');
  expect(await $`git for-each-ref`.cwd(remote).quiet().text()).not.toContain('neat/');
  expect(gh.writes()).toEqual([]);

  const opened = await r.call(`${r.delivery}/pr`, 'POST', { branch: 'main' });
  expect(opened.status).toBe(201);
  expect(opened.json.delivery!.pr).toEqual({ url: 'https://github.com/example/app/pull/7', reused: false, base: 'main' });
  const remoteRefs = (await $`git for-each-ref --format=${'%(refname) %(objectname)'}`.cwd(remote).quiet().text()).trim().split('\n');
  expect(remoteRefs).toContain(`refs/heads/neat/for-review ${commit}`);
  expect(remoteRefs).toHaveLength(2);
  expect(gh.calls.map((c) => c.args[0] + ' ' + c.args[1])).toEqual(['auth status', 'repo view', 'auth status', 'repo view', 'pr list', 'pr create']);
  for (const call of gh.calls.filter(c => c.args[0] === 'pr')) expect(call.args[call.args.indexOf('--repo') + 1]).toBe('https://github.com/example/app');
  expect(gh.calls.find(c => c.args[0] === 'repo')?.args.slice(2)).toEqual(['--json', 'url', '--', remote]);
  const create_ = gh.writes()[0]!;
  expect(create_.args.slice(0, 5)).toEqual(['pr', 'create', '--head', 'neat/for-review', '--base']);
  expect(create_.args).toContain('--base');
  expect(create_.args[create_.args.indexOf('--base') + 1]).toBe('main');
  expect(create_.args.find((a) => a.startsWith('--title='))).toBe('--title=Change text to "Title; $(touch pwned)"');
  expect(create_.input).toContain('- Change text to "Title; $(touch pwned)"');
  expect(await Bun.file(join(t.repo, 'pwned')).exists()).toBe(false);
  expect(await snapshot(t.repo)).toEqual(before);
  await r.close();
});

test('explicit GitHub destinations resolve SSH aliases and remove URL credentials', async () => {
  const { githubRepository } = await import('./delivery');
  const alias = async (host: string) => host === 'work-alias' ? 'github.com' : host;
  expect(await githubRepository('git@work-alias:owner/repo.git', alias)).toBe('https://github.com/owner/repo.git');
  expect(await githubRepository('work-alias:owner/repo.git', alias)).toBe('https://github.com/owner/repo.git');
  expect(await githubRepository('ssh://git@work-alias:2222/owner/repo.git', alias)).toBe('https://github.com/owner/repo.git');
  expect(await githubRepository('https://user:fake-password@github.com/owner/repo.git', alias)).toBe('https://github.com/owner/repo.git');
  expect(await githubRepository('/path/to/origin.git', alias)).toBe('/path/to/origin.git');
});

test('an existing open pull request for the delivered branch is reused', async () => {
  const remote = join(scratch, 'origin.git');
  await $`git init -q --bare ${remote}`.quiet();
  await $`git remote add origin ${remote}`.cwd(t.repo).quiet();
  await $`git branch -M main`.cwd(t.repo).quiet();
  await $`git push -q origin main`.cwd(t.repo).quiet();
  await $`git fetch -q origin`.cwd(t.repo).quiet();
  const existing = JSON.stringify([
    { url: 'https://github.com/fork/app/pull/3', headRefName: 'neat/reuse', isCrossRepository: true },
    { url: 'https://github.com/example/app/pull/4', headRefName: 'neat/reuse', isCrossRepository: false },
  ]);
  const gh = fakeGithub({ list: { code: 0, out: existing } });
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'reuse' });
  const opened = await r.call(`${r.delivery}/pr`, 'POST', {});
  expect(opened.json.delivery!.pr).toEqual({ url: 'https://github.com/example/app/pull/4', reused: true, base: 'main' });
  expect(gh.writes()).toEqual([]);
  await r.close();
});

test('Open pull request refuses without a delivery, without GitHub, when signed out, and without an origin', async () => {
  const gh = fakeGithub({ auth: { code: 1, out: '' } });
  const r = await run({ github: gh.run });
  await keepTwo(r);
  expect((await r.call(`${r.delivery}/pr`, 'POST', {})).json.code).toBe('NO_DELIVERY');
  await create(r, { slug: 'x' });
  expect((await r.call(r.delivery)).json.github).toBe('signed-out');
  expect((await r.call(`${r.delivery}/pr`, 'POST', {})).json.code).toBe('GITHUB_SIGNED_OUT');
  await r.close();

  const missing = await run({ github: fakeGithub({ auth: { code: 127, out: '' } }).run });
  await missing.call(`${missing.delivery}/branch`, 'POST', { slug: 'y' });
  expect((await missing.call(`${missing.delivery}/pr`, 'POST', {})).json.code).toBe('GITHUB_MISSING');
  await missing.close();

  const gh2 = fakeGithub();
  const noOrigin = await run({ github: gh2.run });
  await noOrigin.call(`${noOrigin.delivery}/branch`, 'POST', { slug: 'z' });
  expect((await noOrigin.call(`${noOrigin.delivery}/pr`, 'POST', {})).json.code).toBe('NO_ORIGIN');
  expect(gh2.writes()).toEqual([]);
  await noOrigin.close();
});

test('a branch rewritten after delivery is not pushed, and a rejected push creates no pull request', async () => {
  const remote = join(scratch, 'origin.git');
  await $`git init -q --bare ${remote}`.quiet();
  await $`git remote add origin ${remote}`.cwd(t.repo).quiet();
  await $`git branch -M main`.cwd(t.repo).quiet();
  await $`git push -q origin main`.cwd(t.repo).quiet();
  await $`git fetch -q origin`.cwd(t.repo).quiet();
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'moved' });
  await $`git update-ref refs/heads/neat/moved main`.cwd(t.repo).quiet();
  expect((await r.call(`${r.delivery}/pr`, 'POST', {})).json.code).toBe('BRANCH_CHANGED');
  expect(await $`git for-each-ref refs/heads/neat`.cwd(remote).quiet().text()).toBe('');

  // The remote already holds that name with other history: a normal push is refused, so no pull request follows.
  await create(r, { slug: 'taken' });
  await writeFile(join(t.repo, 'N.md'), 'n');
  await commitAll(t.repo, 'extra on main');
  await $`git push -q origin main:refs/heads/neat/taken`.cwd(t.repo).quiet();
  const rejected = await r.call(`${r.delivery}/pr`, 'POST', {});
  expect(rejected.json.code).toBe('PUSH_REJECTED');
  expect(gh.writes()).toEqual([]);
  await r.close();
});

test('the delivery view survives a browser reload and a new delivery clears the old pull request', async () => {
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'first' });
  await r.call(`${r.delivery}/export`, 'POST', {});
  const listed = await r.call('/api/editor/sessions');
  expect(listed.json.sessions![0]!.delivery!.branch!.name).toBe('neat/first');
  expect(listed.json.sessions![0]!.delivery!.exports).toHaveLength(1);
  await r.edited(h1, setText('Later'));
  expect((await r.call(r.prefix)).json.delivery!.branch!.stale).toBe(true);
  await r.close();
});

for (const useProcess of [false, true]) test(`exports stay directory-bound during swaps with process fallback ${useProcess}`, async () => {
  const { readExport, exportSeries } = await import('./delivery');
  const { rename } = await import('node:fs/promises');
  const r = await run();
  await keepTwo(r);
  const exported = await r.call(`${r.delivery}/export`, 'POST', {});
  const name = exported.json.file!;
  const original = join(t.home, 'exports');
  const parked = join(t.home, 'parked');
  const outside = join(scratch, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, name), 'outside secret');
  const safe = await readFile(join(original, name));
  const read = await readExport(name, { useProcess, beforeFile: async () => { await rename(original, parked); await symlink(outside, original); } });
  expect(read).toEqual(new Uint8Array(safe));
  expect(await readFile(join(outside, name), 'utf8')).toBe('outside secret');
  await rm(original); await rename(parked, original);
  const commits = (await $`git rev-list --reverse ${await head(t.repo)}..HEAD`.cwd(r.dir).quiet().text()).trim().split('\n');
  const saved = await exportSeries({ repo: t.repo, sandboxRoot: r.dir, baseCommit: await head(t.repo), expectedCommits: commits }, {
    slug: 'pinned', useProcess, beforeFile: async () => { await rename(original, parked); await symlink(outside, original); },
  });
  expect((await readFile(join(parked, saved.name), 'utf8'))).toContain('Change text');
  expect(await readdir(outside)).toEqual([name]);
  await r.close();
});

test('the export helper refuses a directory swapped before startup without loading its preloads', async () => {
  const { readExport } = await import('./delivery');
  const { rename } = await import('node:fs/promises');
  const r = await run();
  await keepTwo(r);
  const exported = await r.call(`${r.delivery}/export`, 'POST', {});
  const outside = join(scratch, 'outside');
  await mkdir(outside);
  const marker = join(outside, 'executed');
  await writeFile(join(outside, 'bunfig.toml'), 'preload = ["./preload.ts"]\n');
  await writeFile(join(outside, 'preload.ts'), `await Bun.write(${JSON.stringify(marker)}, 'executed');`);
  await expect(readExport(exported.json.file!, {
    useProcess: true,
    beforeStart: async () => {
      await rename(join(t.home, 'exports'), join(t.home, 'parked'));
      await symlink(outside, join(t.home, 'exports'));
    },
  })).rejects.toMatchObject({ code: 'EXPORT_MISSING' });
  expect(await Bun.file(marker).exists()).toBe(false);
  expect((await readdir(outside)).sort()).toEqual(['bunfig.toml', 'preload.ts']);
  await r.close();
});

test('PR pushes ignore configured tag following', async () => {
  const remote = join(scratch, 'origin.git');
  await $`git init -q --bare ${remote}`.quiet();
  await $`git remote add origin ${remote}`.cwd(t.repo).quiet();
  await $`git branch -M main`.cwd(t.repo).quiet();
  await $`git push -q origin main`.cwd(t.repo).quiet();
  await $`git fetch -q origin`.cwd(t.repo).quiet();
  await $`git -c user.name=Test -c user.email=test@example.com tag -a private-tag -m private`.cwd(t.repo).quiet();
  await $`git config push.followTags true`.cwd(t.repo).quiet();
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'only-branch' });
  expect((await r.call(`${r.delivery}/pr`, 'POST', {})).status).toBe(201);
  expect(await $`git for-each-ref --format=${'%(refname)'} refs/tags`.cwd(remote).quiet().text()).toBe('');
  expect(await $`git for-each-ref --format=${'%(refname)'} refs/heads`.cwd(remote).quiet().text()).toContain('refs/heads/neat/only-branch');
  await r.close();
});

test('a stale delivery cannot open a PR describing newer edits', async () => {
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await keepTwo(r);
  await create(r, { slug: 'older' });
  await r.edited(h1, setText('Newer'));
  const result = await r.call(`${r.delivery}/pr`, 'POST', {});
  expect(result.status).toBe(409);
  expect(result.json.code).toBe('BRANCH_CHANGED');
  expect(gh.calls).toEqual([]);
  await r.close();
});

test('the PR endpoint refuses while a shared proposal is waiting', async () => {
  const badge = 'export function Badge() { return <span className="p-2">Shared</span>; }\n';
  const page = "import { Badge } from '../components/Badge'; " + PAGE.replace('</main>', '<Badge /><Badge /></main>');
  await mkdir(join(t.repo, 'components'));
  await writeFile(join(t.repo, 'components/Badge.tsx'), badge);
  await writeFile(join(t.repo, 'app/page.tsx'), page);
  await commitAll(t.repo, 'shared component');
  const gh = fakeGithub();
  const r = await run({ github: gh.run });
  await r.edited(h1, setText('Welcome'));
  await create(r, { slug: 'before-proposal' });
  const span = tagOf(badge, 'components/Badge.tsx', '<span');
  expect((await r.call(`${r.prefix}/edit`, 'POST', { tag: span, operations: [{ op: 'replace-class', target: span, from: 'p-2', to: 'p-4' }] })).status).toBe(422);
  const result = await r.call(`${r.delivery}/pr`, 'POST', {});
  expect(result.status).toBe(409);
  expect(result.json.code).toBe('PENDING_PROPOSAL');
  expect(gh.calls).toEqual([]);
  await r.close();
});

test('providers without durable passes cannot create a branch or patch', async () => {
  const r = await run({ durable: false });
  await keepTwo(r);
  for (const action of ['branch', 'export']) {
    const result = await r.call(`${r.delivery}/${action}`, 'POST', {});
    expect(result.status).toBe(409);
    expect(result.json.code).toBe('DELIVERY_UNAVAILABLE');
  }
  expect((await $`git branch --list ${'neat/*'}`.cwd(t.repo).quiet().text()).trim()).toBe('');
  await r.close();
});
