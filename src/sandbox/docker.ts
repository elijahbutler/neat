import { $ } from 'bun';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { prepareTaggedProject, resolveNextVersion } from '../tagging/inject';
import { bridgeSource } from './bridge';
import { COPY_SKIP as SKIP, runDockerJob, type JobResult, type JobSpec } from './job';

export type { JobResult, JobSpec, JobStep, JobStepResult } from './job';

export const SANDBOX_IMAGE = 'neat-sandbox:dev';
const HOME = join(homedir(), '.neat', 'sandboxes');
const PORTS = { from: 4100, to: 4199 };

export interface SandboxInfo {
  id: string;
  /** The working copy on this machine. The container mounts it at the same path. */
  dir: string;
  previewUrl: string;
  port: number;
}

export type SandboxState = 'starting' | 'ready' | 'stopped' | 'failed';

/** What a sandbox backend has to do. The docker one runs on this Mac now and on the sandbox server later. */
export interface SandboxStartOptions {
  editorOrigin: string;
  /** Check out this commit instead of the repository's HEAD. Providers that can't (Docker copies the working tree) ignore it. */
  baseCommit?: string;
  /**
   * Runs once the working copy and its preview additions are ready and before the preview process starts, so kept
   * changes can be put back. `root` is the repository root of the working copy and `appDir` the app inside it.
   */
  restore?: (dirs: { root: string; appDir: string }) => Promise<void>;
}

export interface SandboxProvider {
  /** Whether the working copy is a worktree of the user's repository at a known commit, so a pass can be rebuilt on it. */
  readonly durable?: boolean;
  start(id: string, repo: string, opts: SandboxStartOptions): Promise<SandboxInfo>;
  state(info: SandboxInfo): Promise<SandboxState>;
  logs(info: SandboxInfo, lines?: number): Promise<string>;
  stop(info: SandboxInfo): Promise<void>;
  /**
   * Run a short job: a fresh working directory, one container per step with memory, CPU and time limits, no
   * published ports, and only the variables each step names. Everything is removed before this returns.
   */
  runJob(spec: JobSpec): Promise<JobResult>;
}

const container = (id: string) => `neat-sb-${id}`;

async function freePort(): Promise<number> {
  const psText = await $`docker ps --format {{.Ports}}`.quiet().nothrow().text();
  const used = new Set(psText.match(/:(\d+)->/g)?.map((m) => Number(m.slice(1, -2))) ?? []);
  for (let port = PORTS.from; port <= PORTS.to; port++) {
    if (used.has(port)) continue;
    const taken = await fetch(`http://127.0.0.1:${port}`).then(() => true, () => false);
    if (!taken) return port;
  }
  throw new Error('No free preview port between 4100 and 4199. Stop some sessions.');
}

/**
 * Copy the repo into a working directory, commit it as the session's base, then add what the preview needs: the
 * tagging loader, the rewritten next.config, and the editor bridge. Those additions are excluded from git, so the
 * session's commits only ever contain the user's edits.
 */
export async function prepare(repo: string, dir: string, editorOrigin: string): Promise<void> {
  const version = await resolveNextVersion(repo);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(repo, dir, { recursive: true, filter: (src) => !SKIP.test(src.slice(repo.length)) });
  await $`git init -q -b session && git add -A && git -c user.name=Neat -c user.email=sandbox@neatlabs.design commit -q -m base`.cwd(dir).quiet();

  // Same path inside and out, so the absolute paths the tagging config was written with resolve in the container.
  const tagged = await prepareTaggedProject(dir, bridgeSource(editorOrigin), version);
  const excluded = ['/node_modules/', '/.next/', ...tagged.injectedPaths.map((file) => '/' + file)];
  const excludePath = (await $`git rev-parse --path-format=absolute --git-path info/exclude`.cwd(dir).quiet().text()).trim();
  await writeFile(excludePath, excluded.join('\n') + '\n');
  // Rewritten tracked files (the next.config wrapper, an existing instrumentation-client) stay out of every commit.
  for (const file of tagged.injectedPaths) await $`git update-index --skip-worktree -- ${file}`.cwd(dir).quiet().nothrow();
}

async function removeCopy(dir: string): Promise<void> {
  async function writable(path: string): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info?.isDirectory() || info.isSymbolicLink()) return;
    await chmod(path, info.mode | 0o700);
    for (const name of await readdir(path)) await writable(join(path, name));
  }
  await writable(dir);
  await rm(dir, { recursive: true, force: true });
}

export const dockerProvider: SandboxProvider = {
  async start(id, repo, { editorOrigin }) {
    const dir = join(HOME, id);
    try {
      await prepare(repo, dir, editorOrigin);
      const port = await freePort();
      // Same path inside and out, so the absolute paths the tagging config was written with resolve in the container.
      // node_modules is installed inside the container (Linux binaries) but lives on the mount, so the worker can read
      // library types for typechecking edits.
      const args = [
        'run', '-d', '--init', '--name', container(id), '--label', `neat.sandbox=${id}`,
        '--memory', '4g', '--cpus', '2', '-p', `127.0.0.1:${port}:3000`, '-v', `${dir}:${dir}`, '-w', dir,
        SANDBOX_IMAGE, 'sh', '-c', 'bun install --frozen-lockfile && exec node_modules/.bin/next dev -H 0.0.0.0 -p 3000',
      ];
      await $`docker ${args}`.quiet();
      return { id, dir, port, previewUrl: `http://127.0.0.1:${port}` };
    } catch (error) {
      await $`docker rm -f ${container(id)}`.quiet().nothrow().catch(() => undefined);
      try { await removeCopy(dir); }
      catch { console.warn('Docker sandbox cleanup failed; preserving the startup error.'); }
      throw error;
    }
  },

  async state(info) {
    const status = (await $`docker inspect -f {{.State.Status}} ${container(info.id)}`.quiet().nothrow().text()).trim();
    if (!status) return 'stopped';
    if (status === 'exited' || status === 'dead') return 'failed';
    const ok = await fetch(info.previewUrl, { signal: AbortSignal.timeout(15_000) }).then((r) => r.status < 500, () => false);
    return ok ? 'ready' : 'starting';
  },

  async logs(info, lines = 80) {
    const out = await $`docker logs --tail ${lines} ${container(info.id)}`.quiet().nothrow();
    return out.stdout.toString() + out.stderr.toString();
  },

  async stop(info) {
    await $`docker rm -f ${container(info.id)}`.quiet().nothrow();
    await removeCopy(info.dir);
  },

  runJob: (spec) => runDockerJob(SANDBOX_IMAGE, spec),
};

/** Remove every sandbox container and working copy on this machine, for example after the worker restarts. */
export async function stopAllSandboxes(): Promise<void> {
  const ids = (await $`docker ps -aq --filter label=neat.sandbox`.quiet().nothrow().text()).split('\n').filter(Boolean);
  if (ids.length) await $`docker rm -f ${ids}`.quiet().nothrow();
  await rm(HOME, { recursive: true, force: true });
}
