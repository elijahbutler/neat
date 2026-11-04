import { z } from 'zod';
import { $ } from 'bun';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, open, stat, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createServer } from 'node:net';
import { prepareTaggedProject, resolveNextVersion, sandboxWrite } from '../tagging/inject';
import { bridgeSource } from './bridge';
import { dockerProvider, type SandboxInfo, type SandboxProvider } from './docker';
import { detectPackageManager, installCommand } from './extract-job';
export { detectPackageManager } from './extract-job';

interface TrackedProcess {
  proc: ChildProcess;
  dir: string;
  port: number;
  lines: string[];
  exited: boolean;
}

const processSchema = z.object({ pid: z.number().int().positive(), start: z.string().min(1) });
const sessionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/), repo: z.string(), dir: z.string(), appDir: z.string(), marker: z.string(),
  owner: processSchema, preview: processSchema.nullable(),
});
type SessionRecord = z.infer<typeof sessionSchema>;
const sessionHome = () => join(process.env.NEAT_HOME ?? join(homedir(), '.neat'), 'sessions');
const recordPath = (home: string, id: string) => join(home, '.registry', `${id}.json`);

/** Linux boot identity plus kernel start ticks; ps supplies the portable macOS fallback. */
export async function processIdentity(pid: number): Promise<string | null> {
  try { process.kill(pid, 0); } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return null;
    throw error;
  }
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null);
    if (!stat) return null;
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    return `${boot}:${stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]}`;
  }
  const start = (await $`ps -p ${pid} -o lstart=`.quiet().nothrow().text()).trim();
  return start || null;
}
async function persistSession(home: string, record: SessionRecord) {
  await mkdir(join(home, '.registry'), { recursive: true });
  const path = recordPath(home, record.id);
  await writeFile(path + '.tmp', JSON.stringify(record), { mode: 0o600 });
  await rename(path + '.tmp', path);
}
async function editExclude(path: string, edit: (contents: string) => string) {
  const lock = path + '.neat-lock';
  await mkdir(dirname(path), { recursive: true });
  let handle;
  for (let attempt = 0; !handle; attempt++) {
    try {
      handle = await open(lock, 'wx', 0o600);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      const owner = processSchema.safeParse(await readFile(lock, 'utf8').then(JSON.parse).catch(() => null));
      const stale = owner.success ? await processIdentity(owner.data.pid) !== owner.data.start
        : Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 30_000;
      if (stale) await rm(lock, { force: true });
      else if (attempt >= 200) throw new Error('Exclude file is busy');
      else await Bun.sleep(10);
    }
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, start: await processIdentity(process.pid) }));
    const contents = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
    await writeFile(path, edit(contents));
  } finally { await handle.close(); await rm(lock, { force: true }); }
}
async function removeExcludeMarker(path: string, marker: string) {
  if (!existsSync(path)) return;
  await editExclude(path, contents => {
    const lines = contents.split('\n');
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === marker) {
        const end = lines.indexOf(`# End ${marker}`, i + 1);
        // An incomplete or nested block is user content, not ours to remove.
        if (end >= 0 && !lines.slice(i + 1, end).some(line => line.startsWith('# Neat '))) {
          i = end; continue;
        }
      }
      kept.push(lines[i]!);
    }
    return kept.join('\n');
  });
}
const manifestSchema = z.object({ id: z.string(), app: z.string(), env: z.array(z.string()) });
const manifestName = '.neat-session.json';
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
}
async function validateRecovery(home: string, record: SessionRecord) {
  const root = await realpath(home);
  const expected = join(root, record.id);
  if (resolve(record.dir) !== expected || await realpath(record.dir) !== expected) throw new Error('Invalid session directory');
  if (await realpath(join(expected, manifestName)) !== join(expected, manifestName)) throw new Error('Invalid session marker');
  const manifest = manifestSchema.parse(JSON.parse(await readFile(join(expected, manifestName), 'utf8')));
  const app = resolve(expected, manifest.app);
  if (manifest.id !== record.id || !inside(expected, app) || resolve(record.appDir) !== app || await realpath(app) !== app) throw new Error('Invalid session app');
  for (const file of manifest.env) {
    const path = resolve(expected, file);
    if (!inside(expected, path) || await realpath(path) !== path) throw new Error('Invalid session env copy');
  }
  const listed = await $`git worktree list --porcelain`.cwd(record.repo).quiet().text();
  if (!listed.split('\n').includes(`worktree ${expected}`)) throw new Error('Unregistered session worktree');
  return `# Neat ${expected}`;
}
/** Reclaim only recorded sessions whose worker no longer owns its recorded process identity. */
export async function reclaimSessions(home = sessionHome()): Promise<void> {
  const registry = join(home, '.registry');
  for (const file of await readdir(registry).catch(() => [])) {
    if (file.endsWith('.corrupt')) continue;
    const abandoned = /\.claim-(\d+)-[a-f0-9-]+$/.exec(file);
    if (!file.endsWith('.json') && !abandoned) continue;
    if (abandoned && await processIdentity(Number(abandoned[1])).catch(() => 'unknown')) continue;
    const source = join(registry, file);
    const claim = `${recordPath(home, file.split('.json')[0]!)}.claim-${process.pid}-${crypto.randomUUID()}`;
    try { await rename(source, claim); } catch { continue; }
    let keep = true;
    try {
      let record: SessionRecord;
      try { record = sessionSchema.parse(JSON.parse(await readFile(claim, 'utf8'))); }
      catch {
        await rename(claim, `${source}.corrupt`);
        keep = false;
        console.warn('Skipping corrupt Neat session record.');
        continue;
      }
      if (file.split('.json')[0] !== record.id) throw new Error('Invalid record filename');
      if (await processIdentity(record.owner.pid) === record.owner.start) continue;
      const marker = await validateRecovery(home, record);
      if (record.preview && await processIdentity(record.preview.pid) === record.preview.start) {
        const group = (await $`ps -p ${record.preview.pid} -o pgid=`.quiet().nothrow().text()).trim();
        if (Number(group) === record.preview.pid) {
          try { process.kill(-record.preview.pid, 'SIGTERM'); } catch { /* Already exited. */ }
          await Bun.sleep(600);
          // The recorded group was verified before TERM. Kill remaining descendants too.
          try { process.kill(-record.preview.pid, 'SIGKILL'); } catch { /* Already exited. */ }
        }
      }
      await removeExcludeMarker(await excludePath(record.repo), marker);
      const removed = await $`git worktree remove --force ${record.dir}`.cwd(record.repo).quiet().nothrow();
      if (removed.exitCode !== 0 && existsSync(record.dir)) throw new Error(`Cannot reclaim session ${record.id}: ${removed.stderr}`);
      await $`git worktree prune`.cwd(record.repo).quiet();
      await rm(claim, { force: true });
      keep = false;
    } catch { console.warn('Neat session recovery failed; skipping record.'); }
    finally { if (keep) await rename(claim, recordPath(home, file.split('.json')[0]!)).catch(() => undefined); }
  }
}

const MAX_LOG_LINES = 500;
const processes = new Map<string, TrackedProcess>();
const excludes = new Map<string, { path: string; blocks: string[] }>();
async function excludeFiles(dir: string, patterns: string[]) {
  const path = await excludePath(dir);
  const marker = `# Neat ${dir}`;
  const block = `${marker}\n${patterns.join('\n')}\n# End ${marker}\n`;
  await mkdir(dirname(path), { recursive: true });
  await editExclude(path, contents => contents + (contents && !contents.endsWith('\n') ? '\n' : '') + block);
  const entry = excludes.get(dir) ?? { path, blocks: [] };
  entry.blocks.push(block); excludes.set(dir, entry);
}


function appendLogs(entry: TrackedProcess, chunk: Buffer | string): void {
  const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    entry.lines.push(line);
    if (entry.lines.length > MAX_LOG_LINES) entry.lines.shift();
  }
}

async function terminateProcess(entry: TrackedProcess): Promise<void> {
  const pid = entry.proc.pid;
  if (!pid) return;
  try { process.kill(-pid, 'SIGTERM'); } catch { return; }
  // Kill the whole process group even if the Next CLI parent already exited.
  await Bun.sleep(600);
  try { process.kill(-pid, 'SIGKILL'); } catch { /* The process group already stopped. */ }
  if (!entry.exited) await new Promise<void>(resolve => entry.proc.once('close', () => resolve()));
}

/** Probe TCP, including listeners which do not speak HTTP. The caller must bind promptly. */
export async function allocatePort(from = 4100, available: (port: number) => Promise<boolean> = portAvailable): Promise<number> {
  for (let port = from; port <= 65535; port++) {
    if (![...processes.values()].some(p => p.port === port) && await available(port)) return port;
  }
  throw new Error('No free loopback port.');
}
async function portAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
export async function excludePath(dir: string): Promise<string> {
  const path = (await $`git rev-parse --git-path info/exclude`.cwd(dir).quiet().text()).trim();
  return isAbsolute(path) ? path : resolve(dir, path);
}
export async function copyEnvFiles(source: string, target: string): Promise<string[]> {
  const copied: string[] = [];
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith('.env')) continue;
    const tracked = await $`git ls-files --error-unmatch -- ${entry.name}`.cwd(source).quiet().nothrow();
    if (tracked.exitCode === 0) continue;
    await copyFile(join(source, entry.name), join(target, entry.name));
    copied.push(entry.name);
  }
  return copied;
}
/** Whether the repo root holds a package workspace. pnpm declares one in pnpm-workspace.yaml, not in package.json. */
export function isWorkspaceRoot(root: string, packageJson: { workspaces?: unknown }): boolean {
  return Boolean(packageJson.workspaces) || existsSync(join(root, 'pnpm-workspace.yaml'));
}

export async function matchingLockfiles(source: string, target: string): Promise<boolean> {
  const locks = ['bun.lock', 'bun.lockb', 'pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'];
  const present = locks.filter(file => existsSync(join(source, file)) || existsSync(join(target, file)));
  if (!present.length) return false;
  for (const file of present) {
    if (!existsSync(join(source, file)) || !existsSync(join(target, file))) return false;
    if (!(await readFile(join(source, file))).equals(await readFile(join(target, file)))) return false;
  }
  return true;
}

export async function prepareWorktree(repo: string, dir: string, editorOrigin: string, app = '.'): Promise<string> {
  const gitRoot = (await $`git rev-parse --show-toplevel`.cwd(repo).quiet().text()).trim();
  const prefix = relative(gitRoot, repo);
  await mkdir(dirname(dir), { recursive: true });
  await $`git worktree add --detach ${dir} HEAD`.cwd(repo).quiet();
  const appDir = resolve(dir, prefix, app);
  try {
    const env = await copyEnvFiles(repo, join(dir, prefix));
    if (app !== '.') env.push(...(await copyEnvFiles(resolve(repo, app), appDir)).map(file => join(app, file)));
    await writeFile(join(dir, manifestName), JSON.stringify({ id: dir.split('/').at(-1), app: relative(dir, appDir), env: env.map(file => join(prefix, file)) }), { flag: 'wx', mode: 0o600 });
    await excludeFiles(dir, [manifestName, '.neat/', 'node_modules/', '.next/', '.next-neat/', '*.tsbuildinfo', 'next-env.d.ts', ...env.map(file => '/' + join(prefix, file))]);
    return appDir;
  } catch (error) {
    await removeWorktree(dir);
    throw error;
  }
}
export async function removeWorktree(dir: string): Promise<void> {
  const exclusion = excludes.get(dir);
  if (exclusion) {
    await editExclude(exclusion.path, contents => {
      for (const block of exclusion.blocks) contents = contents.replace(block, '');
      return contents;
    });
    excludes.delete(dir);
  }
  const common = (await $`git rev-parse --path-format=absolute --git-common-dir`.cwd(dir).quiet().text()).trim();
  await $`git --git-dir=${common} worktree remove --force ${dir}`.quiet();
  await $`git --git-dir=${common} worktree prune`.quiet();
}

export function createWorktreeProvider(options: { homeDir?: string; app?: string; webpack?: boolean } = {}): SandboxProvider {
  return {
    async start(id, repo, { editorOrigin }) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Invalid session id.');
      const home = options.homeDir ?? sessionHome();
      await reclaimSessions(home);
      const dir = join(home, id);
      const start = await processIdentity(process.pid);
      if (!start) throw new Error('Cannot identify session worker process.');
      const record: SessionRecord = { id, repo: resolve(repo), dir, appDir: resolve(dir, options.app ?? '.'), marker: `# Neat ${dir}`, owner: { pid: process.pid, start }, preview: null };
      await persistSession(home, record);
      try {
        const appDir = await prepareWorktree(resolve(repo), dir, editorOrigin, options.app);
        record.appDir = appDir;
        await persistSession(home, record);
        const sourceApp = resolve(repo, options.app ?? '.');
        const moduleRoots: Array<[string, string]> = [[resolve(repo), resolve(appDir, relative(sourceApp, resolve(repo)))], [sourceApp, appDir]];
        for (const [source, target] of moduleRoots) {
          if (existsSync(join(source, 'node_modules')) && !existsSync(join(target, 'node_modules')) && await matchingLockfiles(source, target)) {
            // Reuse installed dependencies with copy-on-write where supported. Turbopack rejects symlinks
            // escaping its filesystem root, so a symlink here would require forcing webpack.
            await cp(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true, verbatimSymlinks: true, mode: 2 });
          }
        }
        const repoDir = resolve(appDir, relative(sourceApp, resolve(repo)));
        const installRoot = existsSync(join(repoDir, 'package.json')) ? repoDir : appDir;
        if (!existsSync(join(appDir, 'node_modules', '.bin', 'next')) && !existsSync(join(installRoot, 'node_modules', '.bin', 'next'))) {
          const manager = detectPackageManager(await readdir(installRoot));
          if (!manager) throw new Error('No supported lockfile found. Install dependencies in the source repo first.');
          // Use Bun for this launcher's own execution; preserve the target lockfile's package manager.
          await $`${installCommand(manager, await readdir(installRoot))}`.cwd(installRoot).quiet();
        }
        if (!existsSync(join(appDir, 'node_modules')) && existsSync(join(installRoot, 'node_modules'))) await symlink(join(installRoot, 'node_modules'), join(appDir, 'node_modules'), 'dir');
        const tagged = await prepareTaggedProject(appDir, bridgeSource(editorOrigin));
        // A nested standalone app must not inherit an ancestor Next app's proxy/middleware.
        // Preserve an explicit user root; workspace repos keep their workspace root.
        const packageJson = JSON.parse(await readFile(join(installRoot, 'package.json'), 'utf8'));
        const turboRoot = isWorkspaceRoot(installRoot, packageJson) ? installRoot : appDir;
        const configFile = join(appDir, tagged.configPath);
        const configText = await readFile(configFile, 'utf8');
        const rooted = `async (phase, context) => { const config = typeof __neatOriginalConfig === 'function' ? await __neatOriginalConfig(phase, context) : __neatOriginalConfig; return { ...config, turbopack: { ...config.turbopack, root: config.turbopack?.root ?? ${JSON.stringify(turboRoot)} } }; }`;
        // Next can be hoisted to the workspace root, so resolve it the way Node does from the app.
        if (Number((await resolveNextVersion(appDir)).split('.')[0]) >= 16) await sandboxWrite(appDir, configFile, configText.replace('withNeatTagging(__neatOriginalConfig,', `withNeatTagging(${rooted},`));
        const injected = [...tagged.injectedPaths.map(file => join(appDir, file)), join(appDir, 'next-env.d.ts'), join(appDir, 'tsconfig.json')];
        await excludeFiles(dir, injected.map(file => '/' + relative(dir, file).replaceAll('\\', '/')));
        for (const file of injected) await $`git update-index --skip-worktree -- ${relative(dir, file)}`.cwd(dir).quiet().nothrow();
        const port = await allocatePort();
        const next = existsSync(join(appDir, 'node_modules', '.bin', 'next')) ? join(appDir, 'node_modules', '.bin', 'next') : join(installRoot, 'node_modules', '.bin', 'next');
        const args = ['dev', ...(options.webpack ? ['--webpack'] : []), '-H', '127.0.0.1', '-p', String(port)];
        const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1' };
        for (const key of ['PATH', 'HOME', 'TMPDIR', 'USER', 'LANG']) if (process.env[key]) env[key] = process.env[key];
        const proc = spawn(next, args, { cwd: appDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env });
        const entry: TrackedProcess = { proc, dir, port, lines: [], exited: false };
        processes.set(id, entry);
        proc.stdout?.on('data', chunk => appendLogs(entry, chunk));
        proc.stderr?.on('data', chunk => appendLogs(entry, chunk));
        proc.once('close', () => { entry.exited = true; });
        await new Promise<void>((resolve, reject) => { proc.once('spawn', resolve); proc.once('error', reject); });
        if (proc.pid) {
          const previewStart = await processIdentity(proc.pid);
          if (previewStart) record.preview = { pid: proc.pid, start: previewStart };
        }
        await persistSession(home, record);
        return { id, dir: appDir, port, previewUrl: `http://127.0.0.1:${port}` };
      } catch (error) {
        const entry = processes.get(id);
        if (entry) { await terminateProcess(entry); processes.delete(id); }
        if (existsSync(join(dir, '.git'))) await removeWorktree(dir);
        await rm(recordPath(home, id), { force: true });
        throw error;
      }
    },
    async state(info) {
      const entry = processes.get(info.id);
      if (!entry) return 'stopped';
      if (entry.exited) return 'failed';
      return await fetch(info.previewUrl, { signal: AbortSignal.timeout(2000) }).then(r => r.status < 500, () => false) ? 'ready' : 'starting';
    },
    async logs(info, lines = 80) { return processes.get(info.id)?.lines.slice(-lines).join('\n') ?? ''; },
    async stop(info) {
      const entry = processes.get(info.id);
      if (!entry) return;
      await terminateProcess(entry);
      await removeWorktree(entry.dir);
      processes.delete(info.id);
      await rm(recordPath(options.homeDir ?? sessionHome(), info.id), { force: true });
    },
    runJob: spec => dockerProvider.runJob(spec),
  };
}
export const worktreeProvider = createWorktreeProvider();
