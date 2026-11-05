import { $ } from 'bun';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmod, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './passes';
import type { History } from './history';
import { commitAll, head, LAYOUT, makeRepo, openSession, PAGE, read, startWorker, tagOf, worktreeProvider, type TestRepo } from './test-support';

const savedHome = process.env.NEAT_HOME;
let t: TestRepo;
beforeEach(async () => { t = await makeRepo(); process.env.NEAT_HOME = t.home; });
afterEach(async () => {
  if (savedHome === undefined) delete process.env.NEAT_HOME; else process.env.NEAT_HOME = savedHome;
  await t.cleanup();
});

/** One editor run: a provider, a worker, and a session. Closing it removes the worktree, like quitting the editor. */
async function run(repo: TestRepo = t, body: Record<string, unknown> = {}) {
  const provider = worktreeProvider(repo);
  const { worker, call } = startWorker(repo, provider);
  const { session, prefix } = await openSession(call, repo, body);
  const dir = provider.dirs.get(session.id)!.dir;
  const edit = (tag: string, operations: unknown[], extra: Record<string, unknown> = {}) => call(`${prefix}/edit`, 'POST', { tag, operations, ...extra });
  const keep = (extra: Record<string, unknown> = {}) => call(`${prefix}/keep`, 'POST', extra);
  const undo = (extra: Record<string, unknown> = {}) => call(`${prefix}/undo`, 'POST', extra);
  return { session, prefix, dir, call, edit, keep, undo, close: () => worker.close(), provider };
}
type Run = Awaited<ReturnType<typeof run>>;

const setText = (tag: string, text: string) => [{ op: 'set-text', target: tag, text }];
const savedPass = async (repo: TestRepo = t) => {
  const root = join(repo.home, 'passes');
  const [hashDir] = await readdir(root);
  const files = (await readdir(join(root, hashDir!))).filter((name) => name.endsWith('.json'));
  return { dir: join(root, hashDir!), files, read: async (name: string) => JSON.parse(await readFile(join(root, hashDir!, name), 'utf8')) };
};
const h1 = tagOf(PAGE, 'app/page.tsx', '<h1');
const para = tagOf(PAGE, 'app/page.tsx', '<p ');
const list = tagOf(PAGE, 'app/page.tsx', '<ul');

/** Keep a text change to the heading, then a class change to the paragraph. */
async function keepTwo(r: Run) {
  const first = await r.edit(h1, setText(h1, 'Welcome'));
  expect(first.body.ok).toBe(true);
  expect((await r.keep()).status).toBe(200);
  const second = await r.edit(para, [{ op: 'replace-class', target: para, from: 'mt-2', to: 'mt-4' }]);
  expect(second.body.ok).toBe(true);
  expect((await r.keep()).status).toBe(200);
}

test('two kept steps are saved with hashes and patches, and come back after a restart onto the pass base', async () => {
  const base = await head(t.repo);
  const first = await run();
  await keepTwo(first);
  const saved = await savedPass();
  expect(saved.files).toHaveLength(1);
  const pass = await saved.read(saved.files[0]!);
  expect(pass.baseCommit).toBe(base);
  expect(pass.entries.map((e: { summary: string }) => e.summary)).toEqual(['Change text to "Welcome"', 'Change mt-2 to mt-4']);
  const [one, two] = pass.entries;
  expect(one.files).toEqual([{ file: 'app/page.tsx', repoFile: 'app/page.tsx', beforeHash: sha256(PAGE), afterHash: one.files[0].afterHash }]);
  expect(two.files[0].beforeHash).toBe(one.files[0].afterHash);
  expect(two.files[0].afterHash).toBe(sha256(await read(first.dir, 'app/page.tsx')));
  expect(one.patch).toContain('diff --git a/app/page.tsx b/app/page.tsx');
  expect(one.patch).toContain('+      <h1 className="text-xl">Welcome</h1>');
  expect(one.checks).toEqual([
    { name: 'syntax', status: 'passed' }, { name: 'typecheck', status: 'passed' }, { name: 'imports', status: 'passed' },
    { name: 'variants', status: 'passed' }, { name: 'lint', status: 'not-run' }, { name: 'render', status: 'not-run' },
  ]);
  await first.close();
  expect(await Bun.file(first.dir).exists()).toBe(false);

  // The repository moves on while the editor is closed. The pass still rebuilds at its own base.
  await writeFile(join(t.repo, 'NOTES.md'), 'unrelated');
  await commitAll(t.repo, 'unrelated');
  expect(await head(t.repo)).not.toBe(base);

  const second = await run();
  expect(second.session.recovery).toEqual({ restored: 2, skipped: 0, failure: null });
  expect(second.session.timeline.map((s: { summary: string; status: string; number: number }) => [s.number, s.summary, s.status])).toEqual([[1, 'Change text to "Welcome"', 'kept'], [2, 'Change mt-2 to mt-4', 'kept']]);
  const page = await read(second.dir, 'app/page.tsx');
  expect(page).toContain('<h1 className="text-xl">Welcome</h1>');
  expect(page).toContain('<p className="mt-4">World</p>');
  expect((await $`git rev-parse HEAD~2`.cwd(second.dir).quiet().text()).trim()).toBe(base);
  expect((await $`git rev-list --count ${base}..HEAD`.cwd(second.dir).quiet().text()).trim()).toBe('2');
  expect((await $`git status --porcelain -uno`.cwd(second.dir).quiet().text()).trim()).toBe('');
  // Preview additions stay out of every commit and stay hidden from git.
  const committed = (await $`git ls-tree -r --name-only HEAD`.cwd(second.dir).quiet().text()).split('\n');
  expect(committed.filter((file) => file.includes('.neat') || file.includes('neat-client') || file.startsWith('next.config') || file.startsWith('instrumentation'))).toEqual([]);

  // A third step lands in the same pass.
  const third = await second.edit(h1, setText(h1, 'Hello again'));
  expect(third.body.ok).toBe(true);
  expect((await second.keep()).status).toBe(200);
  expect(await readdir(saved.dir).then((names) => names.filter((n) => n.endsWith('.json')))).toEqual(saved.files);
  expect((await saved.read(saved.files[0]!)).entries).toHaveLength(3);
  await second.close();
}, 90_000);

test('corrupt and invalid pass files are skipped and the good pass still resumes', async () => {
  const first = await run();
  await keepTwo(first);
  await first.close();
  const saved = await savedPass();
  const good = await saved.read(saved.files[0]!);
  await writeFile(join(saved.dir, 'broken.json'), '{"version":1,"id":');
  await writeFile(join(saved.dir, 'escape.json'), JSON.stringify({ ...good, id: 'escape', entries: [{ ...good.entries[0], files: [{ ...good.entries[0].files[0], file: '../outside.txt' }] }] }));
  await writeFile(join(saved.dir, 'newest-but-bad.json'), JSON.stringify({ ...good, id: 'newest-but-bad', updatedAt: '2099-01-01T00:00:00.000Z', baseCommit: 'nope' }));
  const second = await run();
  expect(second.session.recovery).toEqual({ restored: 2, skipped: 3, failure: null });
  expect(second.session.timeline).toHaveLength(2);
  await second.close();
}, 90_000);

test('an edit is refused when the file changed behind the editor, and Keep and Undo refuse the same way', async () => {
  const r = await run();
  const file = join(r.dir, 'app/page.tsx');
  await writeFile(file, PAGE + '// changed by hand\n');
  const refused = await r.edit(h1, setText(h1, 'Welcome'));
  expect(refused.status).toBe(409);
  expect(refused.body).toEqual({ error: 'app/page.tsx differs from the last kept step. Restart the editor to rebuild it from your kept steps.', code: 'CHANGED' });
  expect(await readFile(file, 'utf8')).toBe(PAGE + '// changed by hand\n');
  await $`git checkout -- app/page.tsx`.cwd(r.dir).quiet();

  expect((await r.edit(h1, setText(h1, 'Welcome'))).body.ok).toBe(true);
  const applied = await readFile(file, 'utf8');
  await writeFile(file, applied + '// and again\n');
  const keep = await r.keep();
  expect(keep.status).toBe(409);
  expect(keep.body.code).toBe('CHANGED');
  const undo = await r.undo();
  expect(undo.status).toBe(409);
  expect(await readFile(file, 'utf8')).toBe(applied + '// and again\n');
  expect(await readdir(join(t.home, 'passes')).catch(() => [])).toEqual([]);
  // A refused undo discarded its cached project. Restoring the exact pending bytes makes retry safe.
  await writeFile(file, applied);
  const retried = await r.undo();
  expect(retried.status).toBe(200);
  expect(retried.body.pending).toBeNull();
  expect(await readFile(file, 'utf8')).toBe(PAGE);
  expect((await r.edit(h1, setText(h1, 'Recovered'))).body.ok).toBe(true);
  expect(await readFile(file, 'utf8')).toContain('Recovered</h1>');
  await r.close();
}, 60_000);

test('Undo on the newest step leaves no trace, and restarting does not bring it back', async () => {
  const r = await run();
  await keepTwo(r);
  const steps = (await r.call(r.prefix)).body.timeline!;
  const undone = await r.undo({ step: steps[1]!.id });
  expect(undone.status).toBe(200);
  expect(undone.body.timeline!.map((s) => s.status)).toEqual(['kept', 'undone']);
  expect(await read(r.dir, 'app/page.tsx')).toContain('<p className="mt-2">World</p>');
  expect((await $`git rev-list --count ${(await head(t.repo))}..HEAD`.cwd(r.dir).quiet().text()).trim()).toBe('1');
  expect((await $`git status --porcelain -uno`.cwd(r.dir).quiet().text()).trim()).toBe('');
  await r.close();

  const again = await run();
  expect(again.session.timeline.map((s: { status: string }) => s.status)).toEqual(['kept', 'undone']);
  const page = await read(again.dir, 'app/page.tsx');
  expect(page).toContain('Welcome</h1>');
  expect(page).toContain('<p className="mt-2">World</p>');
  const saved = await savedPass();
  expect((await saved.read(saved.files[0]!)).entries[1].undone.mode).toBe('dropped');
  await again.close();
}, 90_000);

test('Undo on an earlier step keeps the work after it, records a revert, and survives a restart', async () => {
  const r = await run();
  expect((await r.edit(h1, setText(h1, 'Welcome'))).body.ok).toBe(true);
  await r.keep();
  expect((await r.edit(list, [{ op: 'replace-class', target: list, from: 'gap-2', to: 'gap-4' }])).body.ok).toBe(true);
  await r.keep();
  const steps = (await r.call(r.prefix)).body.timeline!;
  const undone = await r.undo({ step: steps[0]!.id });
  expect(undone.status).toBe(200);
  expect(undone.body.timeline!.map((s) => [s.status, s.latest])).toEqual([['undone', false], ['kept', false]]);
  const page = await read(r.dir, 'app/page.tsx');
  expect(page).toContain('<h1 className="text-xl">Hello</h1>');
  expect(page).toContain('<ul className="gap-4">');
  expect((await $`git log --format=%s ${(await head(t.repo))}..HEAD`.cwd(r.dir).quiet().text()).trim().split('\n')).toEqual(['Undo: Change text to "Welcome"', 'Change gap-2 to gap-4', 'Change text to "Welcome"']);
  await r.close();

  const again = await run();
  expect(again.session.recovery).toEqual({ restored: 3, skipped: 0, failure: null });
  expect(again.session.timeline.map((s: { status: string }) => s.status)).toEqual(['undone', 'kept']);
  expect(await read(again.dir, 'app/page.tsx')).toBe(page);
  await again.close();
}, 90_000);

test('an earlier undo preserves selected tags in files it does not change', async () => {
  const r = await run();
  await r.edit(h1, setText(h1, 'Welcome')); await r.keep();
  await r.edit(list, [{ op: 'replace-class', target: list, from: 'gap-2', to: 'gap-4' }]); await r.keep();
  const steps = (await r.call(r.prefix)).body.timeline!;
  const layout = tagOf(LAYOUT, 'app/layout.tsx', '<html');
  const undone = await r.undo({ step: steps[0]!.id, tag: layout, tags: [layout, para] });
  expect(undone.status).toBe(200);
  expect(undone.body.nextTag).toBe(layout);
  expect(undone.body.moved).toEqual({ [layout]: layout, [para]: null });
  expect(await read(r.dir, 'app/layout.tsx')).toBe(LAYOUT);
  await r.close();
}, 90_000);

test('an earlier undo commits its validated snapshot despite an external rewrite immediately before staging', async () => {
  const r = await run();
  await r.edit(h1, setText(h1, 'Welcome')); await r.keep();
  await r.edit(list, [{ op: 'replace-class', target: list, from: 'gap-2', to: 'gap-4' }]); await r.keep();
  const steps = (await r.call(r.prefix)).body.timeline!;
  const expected = PAGE.replace('gap-2', 'gap-4');
  const file = join(r.dir, 'app/page.tsx');
  const realGit = Bun.which('git');
  if (!realGit) throw new Error('Git is required for the undo regression');
  const bin = join(t.temp, 'git-interceptor');
  const marker = join(bin, 'rewritten');
  await mkdir(bin);
  const shim = join(bin, 'git');
  await writeFile(shim, `#!${process.execPath}
const args = process.argv.slice(2);
if (process.cwd() === ${JSON.stringify(r.dir)} && args.includes('add') && args.includes('app/page.tsx') && !await Bun.file(${JSON.stringify(marker)}).exists()) {
  await Bun.write(${JSON.stringify(file)}, ${JSON.stringify(expected + '// external rewrite\n')});
  await Bun.write(${JSON.stringify(marker)}, 'rewritten');
}
const child = Bun.spawn([${JSON.stringify(realGit)}, ...args], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
  await chmod(shim, 0o700);
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ''}`;
  try { expect((await r.undo({ step: steps[0]!.id })).status).toBe(200); }
  finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; }
  expect(await readFile(marker, 'utf8')).toBe('rewritten');
  expect(await $`git show HEAD:app/page.tsx`.cwd(r.dir).quiet().text()).toBe(expected);
  expect(await readFile(file, 'utf8')).toBe(expected + '// external rewrite\n');
  const saved = await savedPass();
  const pass = await saved.read(saved.files[0]!);
  expect(pass.entries.at(-1).files[0].afterHash).toBe(sha256(expected));
  expect(pass.entries.at(-1).patch).not.toContain('external rewrite');
  await r.close();
  const again = await run();
  expect(again.session.recovery).toEqual({ restored: 3, skipped: 0, failure: null });
  expect(await read(again.dir, 'app/page.tsx')).toBe(expected);
  await again.close();
}, 90_000);

for (const which of ['newest', 'earlier'] as const) test(`a failed ${which} undo save restores history that was already renamed into place`, async () => {
  const { openWorktree } = await import('./git');
  const { undoStep } = await import('./history');
  const { passSchema, writePass } = await import('./passes');
  const r = await run();
  await r.edit(h1, setText(h1, 'Welcome')); await r.keep();
  await r.edit(list, [{ op: 'replace-class', target: list, from: 'gap-2', to: 'gap-4' }]); await r.keep();
  const page = await read(r.dir, 'app/page.tsx');
  const saved = await savedPass();
  const original = await saved.read(saved.files[0]!);
  const pass = passSchema.parse(original);
  const commits = (await $`git rev-list --reverse ${pass.baseCommit}..HEAD`.cwd(r.dir).quiet().text()).trim().split('\n');
  let fail = true;
  const history: History = {
    wt: await openWorktree(r.dir), pass,
    commits: new Map(pass.entries.map((entry, index) => [entry.id, commits[index]!])),
    persist: async () => {
      await writePass(pass);
      if (fail) { fail = false; throw new Error('Directory sync failed after rename'); }
    },
  };
  const entry = pass.entries[which === 'newest' ? 1 : 0]!;
  await expect(undoStep(history, entry.id, { check: () => null })).rejects.toThrow('Directory sync failed after rename');
  expect(await saved.read(saved.files[0]!)).toEqual(original);
  expect(await read(r.dir, 'app/page.tsx')).toBe(page);
  expect((await $`git rev-parse HEAD`.cwd(r.dir).quiet().text()).trim()).toBe(commits[1]!);
  await r.close();
  const again = await run();
  expect(again.session.recovery).toEqual({ restored: 2, skipped: 0, failure: null });
  expect(again.session.timeline.map(step => step.status)).toEqual(['kept', 'kept']);
  expect(await read(again.dir, 'app/page.tsx')).toBe(page);
  await again.close();
}, 90_000);

test('Undo on an earlier step is refused when a later step changed the same code, and nothing is written', async () => {
  const r = await run();
  expect((await r.edit(h1, setText(h1, 'Welcome'))).body.ok).toBe(true);
  await r.keep();
  expect((await r.edit(h1, setText(h1, 'Greetings'))).body.ok).toBe(true);
  await r.keep();
  const steps = (await r.call(r.prefix)).body.timeline!;
  const before = await read(r.dir, 'app/page.tsx');
  const refused = await r.undo({ step: steps[0]!.id });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe('CONFLICT');
  expect(refused.body.error).toBe('Later steps change the same code, so this step cannot be taken back on its own. Undo the later steps first.');
  expect(await read(r.dir, 'app/page.tsx')).toBe(before);
  expect((await r.call(r.prefix)).body.timeline!.map((s) => s.status)).toEqual(['kept', 'kept']);
  expect((await $`git status --porcelain -uno`.cwd(r.dir).quiet().text()).trim()).toBe('');
  // Taking the later one back first makes it possible.
  expect((await r.undo({ step: steps[1]!.id })).status).toBe(200);
  expect((await r.undo({ step: steps[0]!.id })).status).toBe(200);
  expect(await read(r.dir, 'app/page.tsx')).toBe(PAGE);
  await r.close();
}, 60_000);

test('Undo of a kept step is refused when the file no longer matches the history', async () => {
  const r = await run();
  await keepTwo(r);
  const steps = (await r.call(r.prefix)).body.timeline!;
  await writeFile(join(r.dir, 'app/page.tsx'), (await read(r.dir, 'app/page.tsx')) + '// by hand\n');
  const refused = await r.undo({ step: steps[1]!.id });
  expect(refused.status).toBe(409);
  expect(refused.body.code).toBe('CHANGED');
  expect((await r.call(r.prefix)).body.timeline!.map((s) => s.status)).toEqual(['kept', 'kept']);
  await r.close();
}, 60_000);

test('a saved step whose hashes no longer match stops the rebuild there and continues in a new pass', async () => {
  const r = await run();
  await keepTwo(r);
  await r.close();
  const saved = await savedPass();
  const original = await saved.read(saved.files[0]!);
  const tampered = structuredClone(original);
  tampered.entries[1].files[0].beforeHash = sha256('something else');
  await writeFile(join(saved.dir, saved.files[0]!), JSON.stringify(tampered));
  const tamperedText = await readFile(join(saved.dir, saved.files[0]!), 'utf8');

  const again = await run();
  expect(again.session.recovery).toEqual({ restored: 1, skipped: 0, failure: { summary: 'Change mt-2 to mt-4', reason: 'changed' } });
  expect(again.session.timeline.map((s: { summary: string }) => s.summary)).toEqual(['Change text to "Welcome"']);
  expect(await read(again.dir, 'app/page.tsx')).toContain('<p className="mt-2">World</p>');
  // The saved pass is untouched, and nothing is written until the next step is kept.
  expect(await readFile(join(saved.dir, saved.files[0]!), 'utf8')).toBe(tamperedText);
  expect((await readdir(saved.dir)).filter((n) => n.endsWith('.json'))).toHaveLength(1);
  const edited = await again.edit(para, [{ op: 'replace-class', target: para, from: 'mt-2', to: 'mt-8' }]);
  expect(edited.body.ok).toBe(true);
  await again.keep();
  const files = (await readdir(saved.dir)).filter((n) => n.endsWith('.json'));
  expect(files).toHaveLength(2);
  const fork = await saved.read(files.find((n) => n !== saved.files[0])!);
  expect(fork.supersedes).toBe(original.id);
  expect(fork.entries.map((e: { summary: string }) => e.summary)).toEqual(['Change text to "Welcome"', 'Change mt-2 to mt-8']);
  await again.close();
}, 90_000);

test('a pass whose base commit is gone is not resumed, and says so', async () => {
  const r = await run();
  await keepTwo(r);
  await r.close();
  const saved = await savedPass();
  const pass = await saved.read(saved.files[0]!);
  pass.baseCommit = 'f'.repeat(40);
  await writeFile(join(saved.dir, saved.files[0]!), JSON.stringify(pass));
  const again = await run();
  expect(again.session.recovery).toEqual({ restored: 0, skipped: 0, failure: { summary: 'A saved pass', reason: 'base-missing' } });
  expect(again.session.timeline).toEqual([]);
  expect(await read(again.dir, 'app/page.tsx')).toBe(PAGE);
  await again.close();
}, 60_000);

test('a fresh start ignores the saved pass', async () => {
  const r = await run();
  await keepTwo(r);
  await r.close();
  const again = await run(t, { fresh: true });
  expect(again.session.timeline).toEqual([]);
  expect(again.session.recovery).toBeNull();
  await again.close();
}, 60_000);

test('after an edit moves later elements on its line, the new tags follow and the old ones no longer match', async () => {
  const r = await run();
  const bold = tagOf(PAGE, 'app/page.tsx', '<b ');
  const italic = tagOf(PAGE, 'app/page.tsx', '<i ');
  const first = await r.edit(bold, [{ op: 'replace-class', target: bold, from: 'font-bold', to: 'font-extrabold' }], { tags: [italic] });
  expect(first.body.ok).toBe(true);
  const edited = first.body.session!.pending!.changes[0]!.after;
  expect(first.body.nextTag).toBe(bold);
  expect(first.body.moved![italic]).toBe(tagOf(edited, 'app/page.tsx', '<i '));
  expect(first.body.moved![italic]).not.toBe(italic);
  await r.keep({ tag: bold, tags: [italic] });

  const stale = await r.edit(italic, [{ op: 'replace-class', target: italic, from: 'italic', to: 'not-italic' }]);
  expect(stale.status).toBe(422);
  const moved = first.body.moved![italic]!;
  const second = await r.edit(moved, [{ op: 'replace-class', target: moved, from: 'italic', to: 'not-italic' }]);
  expect(second.body.ok).toBe(true);
  // Undoing the pending change moves the tag back to where it was.
  const back = await r.undo({ tag: moved });
  expect(back.body.nextTag).toBe(moved);
  expect(await read(r.dir, 'app/page.tsx')).toContain('<i className="italic">Italic</i>');
  await r.close();
}, 60_000);

test('Undo on the newest kept step moves a selected tag back across it', async () => {
  const r = await run();
  const bold = tagOf(PAGE, 'app/page.tsx', '<b ');
  const italic = tagOf(PAGE, 'app/page.tsx', '<i ');
  const first = await r.edit(bold, [{ op: 'replace-class', target: bold, from: 'font-bold', to: 'font-extrabold' }], { tags: [italic] });
  const shifted = first.body.moved![italic]!;
  await r.keep();
  const step = (await r.call(r.prefix)).body.timeline![0]!;
  const undone = await r.undo({ step: step.id, tag: shifted });
  expect(undone.body.nextTag).toBe(italic);
  await r.close();
}, 60_000);

test('a symlinked file or folder is never written through, and the target outside stays as it was', async () => {
  await t.cleanup();
  const outsideFile = 'export function Shared() { return <p className="mt-2">Shared</p>; }\n';
  t = await makeRepo();
  process.env.NEAT_HOME = t.home;
  const outside = join(t.temp, 'outside');
  await mkdir(join(outside, 'dir'), { recursive: true });
  await writeFile(join(outside, 'shared.tsx'), outsideFile);
  await writeFile(join(outside, 'dir/card.tsx'), outsideFile);
  await symlink(join(outside, 'shared.tsx'), join(t.repo, 'app/shared.tsx'));
  await symlink(join(outside, 'dir'), join(t.repo, 'app/linked'));
  await commitAll(t.repo, 'links');
  const r = await run();
  const linked = tagOf(outsideFile, 'app/shared.tsx', '<p ');
  const refused = await r.edit(linked, [{ op: 'replace-class', target: linked, from: 'mt-2', to: 'mt-9' }]);
  expect(refused.status).toBe(409);
  expect(refused.body).toEqual({ error: 'app/shared.tsx is, or sits behind, a symbolic link, so the editor will not write it.', code: 'SYMLINK' });
  // A linked folder is not indexed at all, so an edit there finds no element to change.
  const inFolder = tagOf(outsideFile, 'app/linked/card.tsx', '<p ');
  const missing = await r.edit(inFolder, [{ op: 'replace-class', target: inFolder, from: 'mt-2', to: 'mt-9' }]);
  expect(missing.status).toBe(422);
  expect(await readFile(join(outside, 'shared.tsx'), 'utf8')).toBe(outsideFile);
  expect(await readFile(join(outside, 'dir/card.tsx'), 'utf8')).toBe(outsideFile);
  expect((await $`git status --porcelain -uno`.cwd(r.dir).quiet().text()).trim()).toBe('');
  await r.close();
}, 60_000);

test('a root layout edit keeps its directive, never commits the preview additions, and restores on Undo and restart', async () => {
  await t.cleanup();
  const layout = "'use client';\nexport default function Layout() { return <html><body>Before</body></html>; }\n";
  const client = '// original client\n';
  t = await makeRepo({ files: { 'app/layout.tsx': layout, 'instrumentation-client.js': client, 'next.config.mjs': 'export default {};\n' } });
  process.env.NEAT_HOME = t.home;
  const body = tagOf(layout, 'app/layout.tsx', '<body>');
  const r = await run();
  expect((await r.edit(body, setText(body, 'After'))).body.ok).toBe(true);
  expect((await r.keep()).status).toBe(200);
  expect(await $`git show HEAD:app/layout.tsx`.cwd(r.dir).quiet().text()).toBe(layout.replace('Before', 'After'));
  const hidden = async (dir: string) => (await $`git ls-files -v`.cwd(dir).quiet().text()).split('\n').filter((line) => line.startsWith('S ')).map((line) => line.slice(2)).sort();
  expect(await hidden(r.dir)).toEqual(['instrumentation-client.js', 'next.config.mjs']);
  expect(await $`git show HEAD:instrumentation-client.js`.cwd(r.dir).quiet().text()).toBe(client);
  await r.close();

  const again = await run();
  expect(await read(again.dir, 'app/layout.tsx')).toBe(layout.replace('Before', 'After'));
  expect(await $`git ls-files -v`.cwd(again.dir).quiet().text()).toContain('S instrumentation-client.js');
  expect(await $`git show HEAD:instrumentation-client.js`.cwd(again.dir).quiet().text()).toBe(client);
  expect((await $`git status --porcelain -uno`.cwd(again.dir).quiet().text()).trim()).toBe('');
  expect((await $`git ls-tree -r --name-only HEAD`.cwd(again.dir).quiet().text()).split('\n').filter((f) => f.includes('neat'))).toEqual([]);
  // Pending Undo puts the layout back exactly as it was before that edit.
  const second = await again.edit(body, setText(body, 'Later'));
  expect(second.body.ok).toBe(true);
  expect((await again.undo()).status).toBe(200);
  expect(await read(again.dir, 'app/layout.tsx')).toBe(layout.replace('Before', 'After'));
  // And undoing the kept step takes it all the way back.
  const step = (await again.call(again.prefix)).body.timeline![0]!;
  expect((await again.undo({ step: step.id })).status).toBe(200);
  expect(await read(again.dir, 'app/layout.tsx')).toBe(layout);
  expect(await read(again.dir, 'app/layout.tsx')).toStartWith("'use client';");
  await again.close();
}, 90_000);

test('with --app, patches use repository paths while the editor keeps app paths, and a restart rebuilds the same files', async () => {
  await t.cleanup();
  t = await makeRepo({ app: 'apps/web' });
  process.env.NEAT_HOME = t.home;
  const r = await run();
  const result = await r.edit(h1, setText(h1, 'Welcome'));
  expect(result.body.ok).toBe(true);
  expect(result.body.session!.pending!.changes[0]!.file).toBe('app/page.tsx');
  await r.keep();
  const saved = await savedPass();
  const pass = await saved.read(saved.files[0]!);
  expect(pass.app).toBe('apps/web');
  expect(pass.entries[0].files[0]).toMatchObject({ file: 'app/page.tsx', repoFile: 'apps/web/app/page.tsx' });
  expect(pass.entries[0].patch).toContain('diff --git a/apps/web/app/page.tsx b/apps/web/app/page.tsx');
  expect((await r.call(r.prefix)).body.timeline![0]!.files).toEqual(['app/page.tsx']);
  await r.close();

  const again = await run();
  expect(again.session.recovery?.restored).toBe(1);
  expect(await read(again.dir, 'app/page.tsx')).toContain('Welcome</h1>');
  const step = again.session.timeline[0]!;
  expect((await again.undo({ step: step.id })).status).toBe(200);
  expect(await read(again.dir, 'app/page.tsx')).toBe(PAGE);
  await again.close();
}, 90_000);

test('errors from a failed request carry no machine paths', async () => {
  const r = await run();
  await rm(join(r.dir, 'app/page.tsx'));
  const failed = await r.edit(h1, setText(h1, 'Welcome'));
  const text = JSON.stringify(failed.body);
  expect(text).not.toContain(t.temp);
  expect(text).not.toContain(process.env.HOME ?? '/home');
  await r.close();
}, 60_000);

void LAYOUT;
