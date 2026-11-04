import { expect, test } from 'bun:test';
import { createWorker } from './server';
import type { SandboxProvider } from '../sandbox/docker';

const origin = 'http://127.0.0.1:44317';
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => new Request(origin + path, { method, headers: { host: '127.0.0.1:44317', ...headers }, body: body ? JSON.stringify(body) : undefined });
test('serves shell, arbitrary repo API, and sessions in-process without hosted auth', async () => {
  const stopped: string[] = [];
  const provider: SandboxProvider = {
    async start(id, repo, opts) { expect(repo).toBe('/chosen/repo'); expect(opts.editorOrigin).toBe(origin); return { id, dir: '/session', port: 4401, previewUrl: 'http://127.0.0.1:4401' }; },
    async state() { return 'ready'; }, async logs() { return 'preview log'; },
    async stop(info) { stopped.push(info.id); }, async runJob() { throw new Error('not used'); },
  };
  const shell = new Map([['/', { body: '<html>editor</html>', type: 'text/html' }], ['/editor', { body: '<html>editor</html>', type: 'text/html' }]]);
  const worker = createWorker({ repo: '/chosen/repo', origin, shell, provider });
  for (const path of ['/', '/editor']) expect(await (await worker.fetch(request(path))).text()).toBe('<html>editor</html>');
  const fixtures = await (await worker.fetch(request('/api/editor/fixtures'))).json();
  expect(fixtures.fixtures).toEqual(['/chosen/repo']);
  expect((await worker.fetch(request('/api/editor/sessions', 'POST', { fixture: 'orbit-studio' }))).status).toBe(400);
  const opened = await (await worker.fetch(request('/api/editor/sessions', 'POST', { fixture: '/chosen/repo' }))).json();
  expect(opened.fixture).toBe('/chosen/repo');
  const ready = await (await worker.fetch(request(`/api/editor/sessions/${opened.id}`))).json();
  expect(ready.state).toBe('ready');
  expect((await worker.fetch(request('/missing'))).status).toBe(404);
  expect((await worker.fetch(request('/api/editor/sessions', 'POST', {}, { origin: 'https://other.example' }))).status).toBe(403);
  expect((await worker.fetch(request('/', 'GET', undefined, { host: 'other.example' }))).status).toBe(403);
  await worker.close(); expect(stopped).toEqual([opened.id]);
});

test('shutdown waits for an in-flight session start before teardown', async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stopped: string[] = [];
  const provider: SandboxProvider = {
    async start(id) { entered?.(); await gate; return { id, dir: '/session', port: 4401, previewUrl: 'http://127.0.0.1:4401' }; },
    async state() { return 'ready'; }, async logs() { return ''; },
    async stop(info) { stopped.push(info.id); }, async runJob() { throw new Error('not used'); },
  };
  const worker = createWorker({ repo: '/chosen/repo', origin, shell: new Map(), provider });
  const opening = worker.fetch(request('/api/editor/sessions', 'POST', { fixture: '/chosen/repo' }));
  await started;
  const closing = worker.close();
  release?.();
  const session = await (await opening).json();
  await closing;
  expect(stopped).toEqual([session.id]);
});

test('Keep stages a user root-layout edit after Next 14 injection without committing the injected import', async () => {
  const { $ } = await import('bun');
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { prepareWorktree, removeWorktree } = await import('../sandbox/worktree');
  const { prepareTaggedProject } = await import('../tagging/inject');
  const temp = await mkdtemp(join(tmpdir(), 'neat-keep-layout-'));
  const repo = join(temp, 'repo'), dir = join(temp, 'session');
  await mkdir(join(repo, 'app'), { recursive: true });
  const original = "'use client';\nexport default function Layout() { return <html><body>Before</body></html>; }";
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    await writeFile(join(repo, 'app/layout.tsx'), original);
    await writeFile(join(repo, 'package.json'), '{"dependencies":{"next":"14.2.35"}}');
    await $`git init -q ${repo}`.quiet(); await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    const provider: SandboxProvider = {
      async start(id) {
        await prepareWorktree(repo, dir, origin);
        const tagged = await prepareTaggedProject(dir, '// bridge', '14.2.35');
        for (const file of tagged.injectedPaths) await $`git update-index --skip-worktree -- ${file}`.cwd(dir).quiet().nothrow();
        return { id, dir, port: 4401, previewUrl: 'http://127.0.0.1:4401' };
      },
      async state() { return 'ready'; }, async logs() { return ''; },
      async stop() { await removeWorktree(dir); }, async runJob() { throw new Error('unused'); },
    };
    worker = createWorker({ repo, origin, shell: new Map(), provider });
    const opened = await (await worker.fetch(request('/api/editor/sessions', 'POST', { fixture: repo }))).json();
    await worker.fetch(request(`/api/editor/sessions/${opened.id}`));
    const prefix = `/api/editor/sessions/${opened.id}`;
    const layoutLines = (await readFile(join(dir, 'app/layout.tsx'), 'utf8')).split('\n');
    const bodyLine = layoutLines.findIndex(line => line.includes('<body>')) + 1;
    const bodyColumn = layoutLines[bodyLine - 1]!.indexOf('<body>') + 1;
    const edit = await worker.fetch(request(`${prefix}/edit`, 'POST', { tag: `app/layout.tsx:${bodyLine}:${bodyColumn}`, operations: [{ op: 'set-text', target: `app/layout.tsx:${bodyLine}:${bodyColumn}`, text: 'After' }] }));
    const edited = await edit.json();
    expect(edited.ok).toBe(true);
    expect(edit.status).toBe(200);
    const kept = await worker.fetch(request(`${prefix}/keep`, 'POST'));
    expect(kept.status).toBe(200);
    const committed = await $`git show HEAD:app/layout.tsx`.cwd(dir).quiet().text();
    expect(committed.trim()).toBe(original.replace('Before', 'After'));
    expect(committed).toStartWith("'use client';");
    expect(committed).not.toContain('neat-client');
    expect(await readFile(join(repo, 'app/layout.tsx'), 'utf8')).toBe(original);
  } finally { await worker?.close(); await rm(temp, { recursive: true, force: true }); }
}, 30000);

test.skipIf(process.getuid?.() === 0)('unreadable env errors return a fixed response without source or session paths', async () => {
  const { $ } = await import('bun');
  const { chmod, mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { createWorktreeProvider } = await import('../sandbox/worktree');
  const temp = await mkdtemp('/tmp/neat-private-error-');
  const repo = join(temp, 'repo'), home = join(temp, 'sessions');
  let worker: ReturnType<typeof createWorker> | undefined;
  try {
    await mkdir(repo); await writeFile(join(repo, 'base'), 'base');
    await $`git init -q ${repo}`.quiet(); await $`git add .`.cwd(repo).quiet();
    await $`git -c user.name=Test -c user.email=test@example.com commit -qm base`.cwd(repo).quiet();
    await writeFile(join(repo, '.env.local'), 'SECRET=do-not-expose'); await chmod(join(repo, '.env.local'), 0);
    worker = createWorker({ repo, origin, shell: new Map(), provider: createWorktreeProvider({ homeDir: home }) });
    const response = await worker.fetch(request('/api/editor/sessions', 'POST', { fixture: repo }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Worker request failed.', code: 'WORKER_REQUEST_FAILED' });
    expect(await $`git worktree list --porcelain`.cwd(repo).quiet().text()).not.toContain(home);
  } finally { await worker?.close(); await chmod(join(repo, '.env.local'), 0o600).catch(() => {}); await rm(temp, { recursive: true, force: true }); }
});
