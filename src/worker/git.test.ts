import { $ } from 'bun';
import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWorktree, previewPatch, readApp, Refusal, requireState, writeApp } from './git';
import { sha256 } from './passes';

let temp = '';
afterEach(async () => { if (temp) await rm(temp, { recursive: true, force: true }); temp = ''; });

async function repo(files: Record<string, string>) {
  temp = await realpath(await mkdtemp(join(tmpdir(), 'neat-git-')));
  const root = join(temp, 'repo');
  await mkdir(root);
  for (const [file, text] of Object.entries(files)) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), text); }
  await $`git init -q ${root}`.quiet(); await $`git add .`.cwd(root).quiet();
  await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(root).quiet();
  return { root, wt: await openWorktree(root) };
}

test('a write is refused when the file, or any folder above it, is a symlink, and the outside file stays as it was', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'page\n' });
  const outside = join(temp, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'secret.txt'), 'outside');
  await symlink(join(outside, 'secret.txt'), join(root, 'app/link.tsx'));
  await symlink(outside, join(root, 'app/folder'));
  for (const file of ['app/link.tsx', 'app/folder/secret.txt']) {
    const refused = await writeApp(wt, [{ file: 'app/page.tsx', text: 'changed\n' }, { file, text: 'overwritten' }]).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Refusal);
    expect((refused as Refusal).code).toBe('symlink');
    // Nothing was written before the refusal, not even the plain file listed first.
    expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('page\n');
  }
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('outside');
  expect(await readApp(wt, 'app/missing.tsx')).toBeNull();
});

test('a write replaces the file in place and keeps the rest of the folder', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'page\n', 'app/other.tsx': 'other\n' });
  await writeApp(wt, [{ file: 'app/page.tsx', text: 'changed\n' }]);
  expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('changed\n');
  expect(await readFile(join(root, 'app/other.tsx'), 'utf8')).toBe('other\n');
  expect((await $`git status --porcelain`.cwd(root).quiet().text()).trim()).toBe('M app/page.tsx');
});

test('a rewritten file keeps its permissions, so no mode change shows up in git', async () => {
  const { root, wt } = await repo({ 'app/run.tsx': 'one\n' });
  await chmod(join(root, 'app/run.tsx'), 0o755);
  await $`git add -A`.cwd(root).quiet();
  await $`git -c user.name=Test -c user.email=test@example.com commit -qm exec`.cwd(root).quiet();
  await writeApp(wt, [{ file: 'app/run.tsx', text: 'two\n' }]);
  expect((await stat(join(root, 'app/run.tsx'))).mode & 0o777).toBe(0o755);
  expect((await $`git diff --summary`.cwd(root).quiet().text()).trim()).toBe('');
});

test('state checks compare the disk and the commit with the hash that was recorded', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'page\n' });
  await requireState(wt, [{ file: 'app/page.tsx', hash: sha256('page\n') }]);
  await writeFile(join(root, 'app/page.tsx'), 'edited\n');
  const disk = await requireState(wt, [{ file: 'app/page.tsx', hash: sha256('page\n') }]).catch((error: unknown) => error);
  expect((disk as Refusal).code).toBe('changed');
  // The disk matches the new hash but the commit does not, unless the check is told the file may be ahead of it.
  const ahead = await requireState(wt, [{ file: 'app/page.tsx', hash: sha256('edited\n') }]).catch((error: unknown) => error);
  expect((ahead as Refusal).code).toBe('changed');
  await requireState(wt, [{ file: 'app/page.tsx', hash: sha256('edited\n') }], false);
});

test('a saved patch that creates, renames, or names other files is not applied', async () => {
  const { wt } = await repo({ 'app/page.tsx': 'one\ntwo\n', 'app/b.tsx': 'b\n' });
  const create = 'diff --git a/app/new.tsx b/app/new.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/app/new.tsx\n@@ -0,0 +1 @@\n+x\n';
  const edit = 'diff --git a/app/page.tsx b/app/page.tsx\n--- a/app/page.tsx\n+++ b/app/page.tsx\n@@ -1,2 +1,2 @@\n-one\n+uno\n two\n';
  for (const [patch, files] of [[create, ['app/new.tsx']], [edit, ['app/b.tsx']]] as const) {
    const refused = await previewPatch(wt, patch, { reverse: false, repoFiles: [...files] }).catch((error: unknown) => error);
    expect((refused as Refusal).code).toBe('unsafe');
  }
  expect((await previewPatch(wt, edit, { reverse: false, repoFiles: ['app/page.tsx'] })).get('app/page.tsx')).toBe('uno\ntwo\n');
  const stale = await previewPatch(wt, edit.replace('-one', '-zero'), { reverse: false, repoFiles: ['app/page.tsx'] }).catch((error: unknown) => error);
  expect((stale as Refusal).code).toBe('conflict');
});

test('commits use the saved snapshot, exclude unrelated staged files, and never run repository hooks', async () => {
  const { wt, root } = await repo({ 'app/page.tsx': 'base\n', 'other.txt': 'other\n' });
  const { commitFiles, stage, stagedPatch } = await import('./git');
  await writeFile(join(root, 'app/page.tsx'), 'kept\n');
  await stage(wt, ['app/page.tsx']);
  const patch = await stagedPatch(wt, ['app/page.tsx']);
  await writeFile(join(root, 'app/page.tsx'), 'external\n');
  await writeFile(join(root, 'other.txt'), 'unrelated\n');
  await $`git add other.txt`.cwd(root).quiet();
  const hooks = join(root, '.git/hooks');
  for (const name of ['pre-commit', 'prepare-commit-msg', 'commit-msg', 'post-commit']) {
    await writeFile(join(hooks, name), '#!/bin/sh\nprintf executed > hook-ran\nexit 1\n', { mode: 0o755 });
  }
  await commitFiles(wt, 'Keep text', ['app/page.tsx'], patch);
  expect(await $`git show HEAD:app/page.tsx`.cwd(root).quiet().text()).toBe('kept\n');
  expect(await $`git show HEAD:other.txt`.cwd(root).quiet().text()).toBe('other\n');
  expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('external\n');
  expect(await $`git diff --cached --name-only`.cwd(root).quiet().text()).toBe('other.txt\n');
  expect(await readFile(join(root, 'hook-ran'), 'utf8').catch(() => 'absent')).toBe('absent');
});

test('permissions never follow a destination symlink swapped on replacement', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'page\n' });
  const { watch, unlinkSync, symlinkSync } = await import('node:fs');
  const target = join(root, 'app/page.tsx');
  const outside = join(temp, 'outside');
  await writeFile(outside, 'private\n', { mode: 0o600 });
  await chmod(target, 0o644);
  let swapped = false;
  const watcher = watch(join(root, 'app'), (event, filename) => {
    if (event === 'rename' && filename === 'page.tsx' && !swapped) {
      swapped = true;
      unlinkSync(target);
      symlinkSync(outside, target);
    }
  });
  try {
    await writeApp(wt, [{ file: 'app/page.tsx', text: 'changed\n' }]);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    expect(swapped).toBe(true);
    expect((await stat(outside)).mode & 0o777).toBe(0o600);
    expect(await readFile(outside, 'utf8')).toBe('private\n');
  } finally { watcher.close(); }
});

test('snapshot patches use validated text even if the working file changes first', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'base\n' });
  const { snapshotPatch, commitFiles } = await import('./git');
  await writeFile(join(root, 'app/page.tsx'), 'external\n');
  const patch = await snapshotPatch(wt, [{ file: 'app/page.tsx', after: 'validated\n' }]);
  await commitFiles(wt, 'Keep validated text', ['app/page.tsx'], patch);
  expect(await $`git show HEAD:app/page.tsx`.cwd(root).quiet().text()).toBe('validated\n');
  expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('external\n');
});

test('CRLF files compare and replay in checkout representation', async () => {
  const { root, wt } = await repo({ 'app/page.tsx': 'base\n', '.gitattributes': '*.tsx text eol=crlf\n' });
  const { headText, snapshotPatch, commitFiles } = await import('./git');
  await rm(join(root, 'app/page.tsx'));
  await $`git checkout-index --force --all`.cwd(root).quiet();
  expect(await readFile(join(root, 'app/page.tsx'), 'utf8')).toBe('base\r\n');
  expect(await headText(wt, 'app/page.tsx')).toBe('base\r\n');
  await requireState(wt, [{ file: 'app/page.tsx', hash: sha256('base\r\n') }]);
  const patch = await snapshotPatch(wt, [{ file: 'app/page.tsx', after: 'kept\r\n' }]);
  expect((await previewPatch(wt, patch, { reverse: false, repoFiles: ['app/page.tsx'] })).get('app/page.tsx')).toBe('kept\r\n');
  await commitFiles(wt, 'Keep CRLF text', ['app/page.tsx'], patch);
  expect(await headText(wt, 'app/page.tsx')).toBe('kept\r\n');
});
