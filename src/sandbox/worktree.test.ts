import { $ } from 'bun';
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allocatePort, detectPackageManager, excludePath, isWorkspaceRoot, matchingLockfiles, prepareWorktree, removeWorktree } from './worktree';

for (const [lock, manager] of [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']] as const) {
  test(`detects ${lock}`, () => { expect(detectPackageManager([lock])).toBe(manager); });
}
test('no lockfile has no manager', () => { expect(detectPackageManager(['package.json'])).toBeNull(); });
test('port allocation skips busy candidates without using the network', async () => {
  const tried: number[] = [];
  expect(await allocatePort(44300, async port => { tried.push(port); return port === 44302; })).toBe(44302);
  expect(tried).toEqual([44300, 44301, 44302]);
});
test('real detached worktree resolves excludes, copies untracked env, and cleans up registration', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neat-worktree-'));
  const repo = join(temp, 'repo'), session = join(temp, 'session');
  await mkdir(join(repo, 'apps/web'), { recursive: true });
  try {
    await $`git init -q ${repo}`.quiet();
    await writeFile(join(repo, 'base'), 'base');
    await writeFile(join(repo, '.env.tracked'), 'TRACKED=committed');
    await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    await writeFile(join(repo, '.env.tracked'), 'TRACKED=dirty');
    await writeFile(join(repo, '.env.local'), 'SECRET=local');
    // Keep the app directory in the commit, like a real workspace.
    await writeFile(join(repo, 'apps/web/package.json'), '{}');
    await $`git add apps`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm app`.cwd(repo).quiet();
    await writeFile(join(repo, 'apps/web/.env.development'), 'APP=local');
    const originalExclude = await readFile(await excludePath(repo), 'utf8');
    await prepareWorktree(repo, session, 'http://127.0.0.1:44317', 'apps/web');
    try {
      expect((await stat(join(session, '.git'))).isFile()).toBe(true);
      expect(await excludePath(session)).toBe(await excludePath(repo));
      expect(await readFile(join(session, '.env.local'), 'utf8')).toBe('SECRET=local');
      expect(await readFile(join(session, '.env.tracked'), 'utf8')).toBe('TRACKED=committed');
      expect(await readFile(join(session, 'apps/web/.env.development'), 'utf8')).toBe('APP=local');
      expect((await $`git status --porcelain`.cwd(session).quiet().text()).trim()).toBe('');
      expect((await $`git rev-parse --abbrev-ref HEAD`.cwd(session).quiet().text()).trim()).toBe('HEAD');
    } finally { await removeWorktree(session); }
    expect(await readFile(await excludePath(repo), 'utf8')).toBe(originalExclude);
    expect(await $`git worktree list --porcelain`.cwd(repo).quiet().text()).not.toContain(session);
  } finally { await rm(temp, { recursive: true, force: true }); }
});
test('dependencies are reusable only when lockfile contents match', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neat-lock-'));
  try {
    const source = join(temp, 'source'), target = join(temp, 'target');
    await mkdir(source); await mkdir(target);
    expect(await matchingLockfiles(source, target)).toBe(false);
    await writeFile(join(source, 'bun.lock'), 'one'); await writeFile(join(target, 'bun.lock'), 'one');
    expect(await matchingLockfiles(source, target)).toBe(true);
    await writeFile(join(target, 'bun.lock'), 'two');
    expect(await matchingLockfiles(source, target)).toBe(false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('dead worker recovery removes its real worktree, env copy, exclude blocks, and registry only', async () => {
  const { reclaimSessions, processIdentity } = await import('./worktree');
  const temp = await mkdtemp(join(tmpdir(), 'neat-recovery-'));
  const repo = join(temp, 'repo'), home = join(temp, 'sessions');
  await mkdir(repo); await mkdir(join(home, '.registry'), { recursive: true });
  try {
    await $`git init -q ${repo}`.quiet();
    await writeFile(join(repo, 'base'), 'base');
    await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    await writeFile(join(repo, '.env.local'), 'PRIVATE=secret');
    const before = await readFile(await excludePath(repo), 'utf8');
    const start = await processIdentity(process.pid);
    for (const id of ['dead', 'alive']) {
      const dir = join(home, id);
      await prepareWorktree(repo, dir, 'http://localhost:4317');
      await writeFile(join(home, '.registry', `${id}.json`), JSON.stringify({ id, repo, dir, appDir: dir, marker: `# Neat ${dir}`, owner: { pid: id === 'dead' ? 2147483647 : process.pid, start }, preview: null }));
    }
    await reclaimSessions(home);
    const listing = await $`git worktree list --porcelain`.cwd(repo).quiet().text();
    expect(listing).not.toContain(join(home, 'dead'));
    expect(listing).toContain(join(home, 'alive'));
    expect(await Bun.file(join(home, 'dead/.env.local')).exists()).toBe(false);
    expect(await Bun.file(join(home, '.registry/dead.json')).exists()).toBe(false);
    expect(await Bun.file(join(home, '.registry/alive.json')).exists()).toBe(true);
    const exclude = await readFile(await excludePath(repo), 'utf8');
    expect(exclude).not.toContain(`# Neat ${join(home, 'dead')}`);
    expect(exclude).toContain(`# Neat ${join(home, 'alive')}`);
    // Recovery must also tolerate a reused live owner pid with a different start time.
    const path = join(home, '.registry/alive.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    record.owner.start = 'old-start-time';
    await writeFile(path, JSON.stringify(record));
    await reclaimSessions(home);
    expect(await readFile(await excludePath(repo), 'utf8')).toBe(before);
    expect(await $`git worktree list --porcelain`.cwd(repo).quiet().text()).not.toContain(home);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a tracked absolute symlink in a real worktree cannot rewrite its source', async () => {
  const { symlink } = await import('node:fs/promises');
  const { prepareTaggedProject } = await import('../tagging/inject');
  const temp = await mkdtemp(join(tmpdir(), 'neat-link-worktree-'));
  const repo = join(temp, 'repo'), dir = join(temp, 'session');
  await mkdir(join(repo, 'app'), { recursive: true });
  try {
    const original = 'export default {};\n';
    await writeFile(join(repo, 'original.mjs'), original);
    await symlink(join(repo, 'original.mjs'), join(repo, 'next.config.mjs'));
    await writeFile(join(repo, 'app/layout.tsx'), 'export default function Layout() { return <html />; }');
    await $`git init -q ${repo}`.quiet();
    await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    await prepareWorktree(repo, dir, 'http://localhost:4317');
    try {
      await prepareTaggedProject(dir, '// bridge', '14.2.35');
      expect(await readFile(join(repo, 'original.mjs'), 'utf8')).toBe(original);
      expect((await $`git status --porcelain`.cwd(repo).quiet().text()).trim()).toBe('');
    } finally { await removeWorktree(dir); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('recovery kills a verified leftover preview group and leaves a mismatched pid alone', async () => {
  const { spawn } = await import('node:child_process');
  const { reclaimSessions, processIdentity } = await import('./worktree');
  const temp = await mkdtemp(join(tmpdir(), 'neat-orphan-'));
  const repo = join(temp, 'repo'), home = join(temp, 'sessions');
  const proc = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
  const pid = proc.pid!;
  try {
    await mkdir(repo); await mkdir(join(home, '.registry'), { recursive: true });
    await $`git init -q ${repo}`.quiet();
    await writeFile(join(repo, 'base'), 'base');
    await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    const start = await processIdentity(pid);
    expect(start).not.toBeNull();
    for (const [id, identity] of [['mismatch', 'wrong-start'], ['verified', start]]) {
      const dir = join(home, id!);
      await prepareWorktree(repo, dir, 'http://localhost:4317');
      await writeFile(join(home, '.registry', `${id}.json`), JSON.stringify({ id, repo, dir, appDir: dir, marker: `# Neat ${dir}`, owner: { pid: 2147483647, start: 'dead' }, preview: { pid, start: identity } }));
      await reclaimSessions(home);
      if (id === 'mismatch') expect(await processIdentity(pid)).toBe(start);
    }
    expect(await processIdentity(pid)).toBeNull();
  } finally {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* Recovery already stopped it. */ }
    await rm(temp, { recursive: true, force: true });
  }
});

test('recovery refuses forged paths and exclude markers without touching user work', async () => {
  const { reclaimSessions } = await import('./worktree');
  const temp = await mkdtemp('/tmp/neat-forged-');
  const repo = join(temp, 'repo'), home = join(temp, 'sessions'), victim = join(temp, 'victim');
  try {
    await mkdir(repo); await mkdir(join(home, '.registry'), { recursive: true });
    await $`git init -q ${repo}`.quiet();
    await writeFile(join(repo, 'base'), 'base'); await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    await $`git worktree add --detach ${victim} HEAD`.cwd(repo).quiet();
    await writeFile(join(victim, 'uncommitted'), 'keep');
    const exclude = await excludePath(repo);
    const contents = '# user\nkeep-me\n# End # user\n'; await writeFile(exclude, contents);
    await writeFile(join(home, '.registry/forged.json'), JSON.stringify({ id: 'forged', repo, dir: victim, appDir: victim, marker: '# user', owner: { pid: 2147483647, start: 'dead' }, preview: null }));
    await reclaimSessions(home);
    expect(await Bun.file(join(victim, 'uncommitted')).text()).toBe('keep');
    expect(await readFile(exclude, 'utf8')).toBe(contents);
    expect(await $`git worktree list --porcelain`.cwd(repo).quiet().text()).toContain(victim);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a corrupt registry file never prevents recovery of other records', async () => {
  const { reclaimSessions } = await import('./worktree');
  const temp = await mkdtemp('/tmp/neat-corrupt-');
  try {
    await mkdir(join(temp, '.registry')); await writeFile(join(temp, '.registry/bad.json'), '{');
    await expect(reclaimSessions(temp)).resolves.toBeUndefined();
    expect(await Bun.file(join(temp, '.registry/bad.json.corrupt')).text()).toBe('{');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('concurrent recovery claims a dead session once without cleanup warnings', async () => {
  const { reclaimSessions } = await import('./worktree');
  const { spyOn } = await import('bun:test');
  const temp = await mkdtemp('/tmp/neat-concurrent-');
  const repo = join(temp, 'repo'), home = join(temp, 'sessions'), dir = join(home, 'dead');
  const warnings = spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await mkdir(repo); await mkdir(join(home, '.registry'), { recursive: true });
    await $`git init -q ${repo}`.quiet(); await writeFile(join(repo, 'base'), 'base');
    await $`git add .`.cwd(repo).quiet(); await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    const before = await readFile(await excludePath(repo), 'utf8');
    await prepareWorktree(repo, dir, 'http://localhost:4317');
    await writeFile(join(home, '.registry/dead.json'), JSON.stringify({ id: 'dead', repo, dir, appDir: dir, marker: '# user', owner: { pid: 2147483647, start: 'dead' }, preview: null }));
    await Promise.all([reclaimSessions(home), reclaimSessions(home)]);
    expect(warnings).not.toHaveBeenCalled();
    expect(await readFile(await excludePath(repo), 'utf8')).toBe(before);
    expect(await $`git worktree list --porcelain`.cwd(repo).quiet().text()).not.toContain(dir);
  } finally { warnings.mockRestore(); await rm(temp, { recursive: true, force: true }); }
});

test('valid recovery ignores a forged marker and preserves incomplete exclude blocks', async () => {
  const { reclaimSessions } = await import('./worktree');
  const temp = await mkdtemp('/tmp/neat-exclude-');
  const repo = join(temp, 'repo'), home = join(temp, 'sessions'), dir = join(home, 'dead');
  try {
    await mkdir(repo); await mkdir(join(home, '.registry'), { recursive: true });
    await $`git init -q ${repo}`.quiet(); await writeFile(join(repo, 'base'), 'base');
    await $`git add .`.cwd(repo).quiet(); await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    const path = await excludePath(repo);
    const user = '# user\nprivate-user-pattern\n# End # user\n\n';
    await writeFile(path, user);
    await prepareWorktree(repo, dir, 'http://localhost:4317');
    const incomplete = `# Neat ${dir}\nuser-authored-tail\n`;
    await writeFile(path, (await readFile(path, 'utf8')) + incomplete);
    await writeFile(join(home, '.registry/dead.json'), JSON.stringify({ id: 'dead', repo, dir, appDir: dir, marker: '# user', owner: { pid: 2147483647, start: 'dead' }, preview: null }));
    await reclaimSessions(home);
    expect(await readFile(path, 'utf8')).toBe(user + incomplete);
    expect(await Bun.file(join(home, '.registry/dead.json')).exists()).toBe(false);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a pnpm workspace counts as a workspace root without a package.json workspaces field', async () => {
  const root = await mkdtemp(join(tmpdir(), 'neat-ws-'));
  try {
    expect(isWorkspaceRoot(root, {})).toBe(false);
    expect(isWorkspaceRoot(root, { workspaces: ['apps/*'] })).toBe(true);
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    expect(isWorkspaceRoot(root, {})).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a worktree can start at an earlier commit, and a base that is not a commit hash is refused', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'neat-base-'));
  const repo = join(temp, 'repo'), session = join(temp, 'session');
  await mkdir(repo);
  try {
    await $`git init -q ${repo}`.quiet();
    await writeFile(join(repo, 'file'), 'first');
    await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm first`.cwd(repo).quiet();
    const first = (await $`git rev-parse HEAD`.cwd(repo).quiet().text()).trim();
    await writeFile(join(repo, 'file'), 'second');
    await $`git -c user.name=Test -c user.email=test@example.com commit -qam second`.cwd(repo).quiet();
    await expect(prepareWorktree(repo, session, 'http://127.0.0.1:44317', '.', '--help')).rejects.toThrow('Invalid base commit.');
    await prepareWorktree(repo, session, 'http://127.0.0.1:44317', '.', first);
    try {
      expect(await readFile(join(session, 'file'), 'utf8')).toBe('first');
      expect((await $`git rev-parse HEAD`.cwd(session).quiet().text()).trim()).toBe(first);
    } finally { await removeWorktree(session); }
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('generated local lockfiles are reused only when the sandbox manifest matches', async () => {
  const { copyLocalLocks } = await import('./worktree');
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'neat-lock-copy-'));
  try {
    const source = join(temp, 'source'), target = join(temp, 'target');
    await mkdir(source); await mkdir(target);
    await writeFile(join(source, 'package.json'), '{"dependencies":{"next":"latest"}}');
    await writeFile(join(target, 'package.json'), '{"dependencies":{"next":"latest"}}');
    await writeFile(join(source, 'bun.lock'), 'generated lock');
    await writeFile(join(source, 'bun.lockb'), new Uint8Array([0, 255, 1, 128]));
    await copyLocalLocks(source, target);
    expect(await readFile(join(target, 'bun.lock'), 'utf8')).toBe('generated lock');
    expect([...await readFile(join(target, 'bun.lockb'))]).toEqual([0, 255, 1, 128]);
    await rm(join(target, 'bun.lock'));
    await rm(join(target, 'bun.lockb'));
    await writeFile(join(source, 'package.json'), '{"dependencies":{"next":"17"}}');
    await copyLocalLocks(source, target);
    expect(await readFile(join(target, 'bun.lock'), 'utf8').catch(() => 'missing')).toBe('missing');
    await writeFile(join(target, 'bun.lock'), 'committed lock');
    await copyLocalLocks(source, target);
    expect(await readFile(join(target, 'bun.lock'), 'utf8')).toBe('committed lock');
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('a pnpm workspace reuses package-local links only with matching manifests and a matching root lock', async () => {
  const { reuseWorkspaceDependencies } = await import('./worktree');
  const { mkdtemp, mkdir, writeFile, readFile, symlink, realpath, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const temp = await mkdtemp(join(tmpdir(), 'neat-pnpm-links-'));
  try {
    const source = join(temp, 'source'), target = join(temp, 'target');
    for (const root of [source, target]) {
      await mkdir(join(root, 'apps/web'), { recursive: true });
      await mkdir(join(root, 'packages/ui'), { recursive: true });
      await writeFile(join(root, 'package.json'), '{"private":true}');
      await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
      await writeFile(join(root, 'apps/web/package.json'), '{"name":"web"}');
      await writeFile(join(root, 'packages/ui/package.json'), '{"name":"ui"}');
    }
    await mkdir(join(source, 'node_modules/.pnpm/next/node_modules/next'), { recursive: true });
    await writeFile(join(source, 'node_modules/.pnpm/next/node_modules/next/package.json'), '{"version":"16.2.6"}');
    await mkdir(join(source, 'apps/web/node_modules'));
    await symlink('../../../node_modules/.pnpm/next/node_modules/next', join(source, 'apps/web/node_modules/next'));
    await mkdir(join(source, 'packages/ui/node_modules'));
    await writeFile(join(source, 'packages/ui/node_modules/helper.js'), 'export const ready = true;');
    await reuseWorkspaceDependencies(source, target);
    expect(await readFile(join(target, 'apps/web/node_modules/next/package.json'), 'utf8')).toBe('{"version":"16.2.6"}');
    expect(await realpath(join(target, 'apps/web/node_modules/next'))).toStartWith(target);
    expect(await readFile(join(target, 'packages/ui/node_modules/helper.js'), 'utf8')).toBe('export const ready = true;');
    await rm(join(target, 'packages/ui/node_modules'), { recursive: true });
    await writeFile(join(target, 'packages/ui/package.json'), '{"name":"changed"}');
    await reuseWorkspaceDependencies(source, target);
    expect(await readFile(join(target, 'packages/ui/node_modules/helper.js'), 'utf8').catch(() => 'missing')).toBe('missing');
    const outside = join(temp, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'package.json'), '{"name":"ui"}');
    await rm(join(target, 'packages/ui'), { recursive: true });
    await symlink(outside, join(target, 'packages/ui'));
    await reuseWorkspaceDependencies(source, target);
    expect(await readFile(join(outside, 'node_modules/helper.js'), 'utf8').catch(() => 'missing')).toBe('missing');
  } finally { await rm(temp, { recursive: true, force: true }); }
});
