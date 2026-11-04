import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPass, isSafeRelative, latestOpenPass, loadPasses, passesHome, repoHash, sha256, writePass, type Pass } from './passes';

const saved = process.env.NEAT_HOME;
let home = '';
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'neat-store-')); process.env.NEAT_HOME = home; });
afterEach(async () => {
  if (saved === undefined) delete process.env.NEAT_HOME; else process.env.NEAT_HOME = saved;
  await rm(home, { recursive: true, force: true });
});

const base = 'a'.repeat(40);
const entry = (id: string): Pass['entries'][number] => ({
  kind: 'edit', source: 'direct', tag: 'app/page.tsx:1:1', id, summary: 'Change text', createdAt: new Date().toISOString(),
  files: [{ file: 'app/page.tsx', repoFile: 'app/page.tsx', beforeHash: sha256('a'), afterHash: sha256('b') }],
  patch: 'diff --git a/app/page.tsx b/app/page.tsx\n', checks: [{ name: 'syntax', status: 'passed' }, { name: 'lint', status: 'not-run' }], spans: [],
});

test('a pass is stored under NEAT_HOME by repository hash, with only the final file left behind', async () => {
  const pass = createPass({ repo: '/work/repo', app: '.', baseCommit: base });
  pass.entries.push(entry('step-1'));
  await writePass(pass);
  const dir = join(passesHome(), repoHash('/work/repo'));
  expect(passesHome()).toBe(join(home, 'passes'));
  expect(await readdir(dir)).toEqual([`${pass.id}.json`]);
  expect(JSON.parse(await readFile(join(dir, `${pass.id}.json`), 'utf8')).entries[0].id).toBe('step-1');
  const loaded = await loadPasses('/work/repo');
  expect(loaded).toEqual({ passes: [pass], skipped: 0 });
  expect((await loadPasses('/work/other')).passes).toEqual([]);
});

test('a rewrite replaces the file whole, and an old file is never half-written', async () => {
  const pass = createPass({ repo: '/work/repo', app: '.', baseCommit: base });
  await writePass(pass);
  for (let i = 0; i < 20; i++) { pass.entries.push(entry(`step-${i}`)); await Promise.all([writePass(pass), loadPasses('/work/repo')]); }
  const loaded = await loadPasses('/work/repo');
  expect(loaded.skipped).toBe(0);
  expect(loaded.passes[0]!.entries).toHaveLength(20);
  expect((await readdir(join(passesHome(), repoHash('/work/repo')))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});

test('unusable files are skipped: bad JSON, wrong shape, a path that climbs out, a renamed file, and a link', async () => {
  const good = createPass({ repo: '/work/repo', app: '.', baseCommit: base });
  good.entries.push(entry('one'));
  await writePass(good);
  const dir = join(passesHome(), repoHash('/work/repo'));
  const text = JSON.parse(await readFile(join(dir, `${good.id}.json`), 'utf8'));
  await writeFile(join(dir, 'a.json'), '{"version":1');
  await writeFile(join(dir, 'b.json'), '[]');
  await writeFile(join(dir, 'c.json'), JSON.stringify({ ...text, id: 'c', entries: [{ ...text.entries[0], files: [{ ...text.entries[0].files[0], repoFile: '../../etc/passwd' }] }] }));
  await writeFile(join(dir, 'wrong-name.json'), JSON.stringify({ ...text, id: 'other' }));
  await writeFile(join(home, 'elsewhere.json'), JSON.stringify({ ...text, id: 'linked' }));
  await symlink(join(home, 'elsewhere.json'), join(dir, 'linked.json'));
  await mkdir(join(dir, 'folder.json'));
  const loaded = await loadPasses('/work/repo');
  expect(loaded.passes.map((p) => p.id)).toEqual([good.id]);
  expect(loaded.skipped).toBe(6);
});

test('the latest open pass for the app is the one that resumes', () => {
  const make = (id: string, patch: Partial<Pass>): Pass => ({ ...createPass({ repo: '/r', app: '.', baseCommit: base }), id, ...patch });
  const passes = [
    make('old', { updatedAt: '2026-01-01T00:00:00.000Z' }),
    make('newest-closed', { updatedAt: '2026-03-01T00:00:00.000Z', status: 'closed' }),
    make('other-app', { updatedAt: '2026-04-01T00:00:00.000Z', app: 'apps/web' }),
    make('newest', { updatedAt: '2026-02-01T00:00:00.000Z' }),
  ];
  expect(latestOpenPass(passes, '.')?.id).toBe('newest');
  expect(latestOpenPass(passes, 'apps/web')?.id).toBe('other-app');
  expect(latestOpenPass([], '.')).toBeUndefined();
});

test('only plain relative paths inside the repository are accepted', () => {
  expect(['app/page.tsx', 'apps/web/app/[id]/page.tsx'].map(isSafeRelative)).toEqual([true, true]);
  expect(['', '.', '/etc/passwd', '../x', 'a/../../x', 'a//b', 'a\\b', './a', 'a/./b'].map(isSafeRelative)).toEqual(new Array(9).fill(false));
});
