// Shared by the worker tests: a throwaway git repository holding a small Next app, and a sandbox provider that builds
// real worktrees of it without starting a preview server.
import { $ } from 'bun';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prepareWorktree, removeWorktree } from '../sandbox/worktree';
import type { SandboxInfo, SandboxProvider } from '../sandbox/docker';
import { prepareTaggedProject } from '../tagging/inject';
import type { TimelineStep } from './history';
import type { EditClient } from '../edit/model';
import type { ProposalView } from './confirmation';
import { createWorker } from './server';

export const ORIGIN = 'http://127.0.0.1:44317';
export const PAGE = `export default function Page() {
  return (
    <main className="p-4">
      <h1 className="text-xl">Hello</h1>
      <p className="mt-2">World</p>
      <ul className="gap-2">
        <li>One</li>
        <li>Two</li>
        <li>Three</li>
      </ul>
      <footer className="pt-8">
        <b className="font-bold">Bold</b><i className="italic">Italic</i>
      </footer>
    </main>
  );
}
`;
export const LAYOUT = "'use client';\nexport default function Layout({ children }: { children: React.ReactNode }) { return <html><body>{children}</body></html>; }\n";

/** The parts of the worker's JSON replies the tests read. */
export interface ApiBody {
  ok?: boolean; error?: string; code?: string; id?: string; message?: string;
  nextTag?: string | null; moved?: Record<string, string | null>;
  timeline?: TimelineStep[];
  pending?: { kind: string; instruction: string; changes: Array<{ file: string; before: string; after: string }>; checks: Array<{ name: string; status: string }> } | null;
  recovery?: { restored: number; skipped: number; failure: { summary: string; reason: string } | null } | null;
  pass?: { id: string; base: string; durable: boolean };
  session?: ApiBody;
  proposal?: ProposalView | null;
  confirm?: Array<{ allow: string; component: string; file: string; line: number; uses: number }>;
  errors?: string[];
  cancelled?: boolean;
  usage?: { calls: number };
}

/** A session as the worker lists it. */
export interface SessionView {
  id: string;
  timeline: TimelineStep[];
  recovery: NonNullable<ApiBody['recovery']> | null;
  pass: NonNullable<ApiBody['pass']>;
}

export interface TestRepo { temp: string; repo: string; app: string; home: string; cleanup: () => Promise<void> }

const commit = (cwd: string, message: string) => $`git -c user.name=Test -c user.email=test@example.com commit -qm ${message}`.cwd(cwd).quiet();

/** A repository with one Next 14 app. With `app`, the app lives in that subdirectory of the repository. */
export async function makeRepo(options: { app?: string; files?: Record<string, string> } = {}): Promise<TestRepo> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'neat-pass-')));
  const repo = join(temp, 'repo');
  const app = options.app ?? '.';
  const appDir = join(repo, app);
  await mkdir(join(appDir, 'app'), { recursive: true });
  await writeFile(join(appDir, 'package.json'), '{"name":"example","dependencies":{"next":"14.2.35"}}');
  await writeFile(join(appDir, 'app/layout.tsx'), LAYOUT);
  await writeFile(join(appDir, 'app/page.tsx'), PAGE);
  for (const [file, text] of Object.entries(options.files ?? {})) {
    await mkdir(dirname(join(appDir, file)), { recursive: true });
    await writeFile(join(appDir, file), text);
  }
  await $`git init -q ${repo}`.quiet();
  await $`git add .`.cwd(repo).quiet();
  await commit(repo, 'base');
  return { temp, repo, app, home: join(temp, 'neat-home'), cleanup: () => rm(temp, { recursive: true, force: true }) };
}

export const head = async (repo: string) => (await $`git rev-parse HEAD`.cwd(repo).quiet().text()).trim();
export const commitAll = async (repo: string, message: string) => { await $`git add -A`.cwd(repo).quiet(); await commit(repo, message); };

/** Worktree sessions with the Next 14 preview additions applied and hidden from git, as the real provider does. */
export function worktreeProvider(t: TestRepo): SandboxProvider & { dirs: Map<string, SandboxInfo> } {
  const dirs = new Map<string, SandboxInfo>();
  const roots = new Map<string, string>();
  return {
    durable: true,
    dirs,
    async start(id, repo, { baseCommit, restore }) {
      const dir = join(t.temp, 'sessions', id);
      const appDir = await prepareWorktree(repo, dir, ORIGIN, t.app, baseCommit);
      const tagged = await prepareTaggedProject(appDir, '// bridge', '14.2.35');
      const root = (await $`git rev-parse --show-toplevel`.cwd(dir).quiet().text()).trim();
      for (const file of tagged.injectedPaths) await $`git update-index --skip-worktree -- ${join(appDir, file)}`.cwd(dir).quiet().nothrow();
      if (restore) await restore({ root: await realpath(root), appDir: await realpath(appDir) });
      const info = { id, dir: appDir, port: 4401, previewUrl: 'http://127.0.0.1:4401' };
      dirs.set(id, info); roots.set(id, dir);
      return info;
    },
    async state() { return 'ready'; },
    async logs() { return ''; },
    async stop(info) { const dir = roots.get(info.id); if (dir) await removeWorktree(dir); dirs.delete(info.id); roots.delete(info.id); },
    async runJob() { throw new Error('unused'); },
  };
}

export function startWorker(t: TestRepo, provider: SandboxProvider, extra: { editClient?: EditClient | null; confirmation?: { ttlMs?: number; now?: () => number } } = {}) {
  const worker = createWorker({ repo: t.repo, app: t.app === '.' ? undefined : t.app, origin: ORIGIN, shell: new Map(), provider, ...extra });
  const call = async (path: string, method = 'GET', body?: unknown) => {
    const res = await worker.fetch(new Request(ORIGIN + path, { method, headers: { host: '127.0.0.1:44317' }, body: body === undefined ? undefined : JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as ApiBody };
  };
  return { worker, call };
}

/** Open a session and wait for the provider to call it ready. */
export async function openSession(call: ReturnType<typeof startWorker>['call'], t: TestRepo, body: Record<string, unknown> = {}) {
  const opened = await call('/api/editor/sessions', 'POST', { fixture: t.repo, ...body });
  await call(`/api/editor/sessions/${opened.body.id}`);
  return { session: opened.body as SessionView, prefix: `/api/editor/sessions/${opened.body.id}` };
}

/** The `file:line:column` tag of the first element whose opening text starts with `needle`. */
export function tagOf(text: string, file: string, needle: string): string {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`${needle} not found in ${file}`);
  const before = text.slice(0, at);
  return `${file}:${before.split('\n').length}:${at - (before.lastIndexOf('\n') + 1) + 1}`;
}

export const read = (dir: string, file: string) => readFile(join(dir, file), 'utf8');
