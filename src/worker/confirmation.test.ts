import { $ } from 'bun';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EditClient } from '../edit/model';
import type { EditOperation } from '../edit/operations';
import { ProposalStore, type NewProposal } from './confirmation';
import { makeRepo, openSession, read, startWorker, tagOf, worktreeProvider, type TestRepo } from './test-support';

const savedHome = process.env.NEAT_HOME;
let t: TestRepo;
let closers: Array<() => Promise<void>> = [];
beforeEach(() => { closers = []; });
afterEach(async () => {
  for (const close of closers) await close();
  if (savedHome === undefined) delete process.env.NEAT_HOME; else process.env.NEAT_HOME = savedHome;
  await t.cleanup();
});

const BADGE = `export function Badge({ children }: { children: string }) {
  return <span className="rounded px-2 text-sm">{children}</span>;
}
`;
const HOME = `import { Badge } from '../components/Badge';
export default function Page() {
  return (
    <main className="p-4">
      <h1 className="text-xl">Hello</h1>
      <Badge>New</Badge>
      <Badge>Sale</Badge>
    </main>
  );
}
`;
const ABOUT = `import { Badge } from '../../components/Badge';
export default function About() {
  return (
    <main>
      <h1>About</h1>
      <Badge>Team</Badge>
    </main>
  );
}
`;
const SOLO = `export function Solo({ children }: { children: string }) {
  return <em className="italic">{children}</em>;
}
`;
const FILES = { 'components/Badge.tsx': BADGE, 'components/Solo.tsx': SOLO, 'app/page.tsx': HOME, 'app/about/page.tsx': ABOUT };

/** A model client that answers each call with the next scripted operations, and counts the calls. No network. */
function scripted(replies: EditOperation[][]) {
  const state = { calls: 0 };
  const client: EditClient & { state: { calls: number } } = {
    state,
    messages: {
      parse: async () => {
        const operations = replies[Math.min(state.calls, replies.length - 1)];
        state.calls++;
        return { content: [], parsed_output: { operations }, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  };
  return client;
}

async function run(client: EditClient | null = null, confirmation?: { ttlMs?: number; now?: () => number }, files: Record<string, string> = FILES) {
  t = await makeRepo({ files });
  process.env.NEAT_HOME = t.home;
  const provider = worktreeProvider(t);
  const { worker, call } = startWorker(t, provider, { editClient: client, confirmation });
  closers.push(() => worker.close());
  const { session, prefix } = await openSession(call, t);
  const dir = provider.dirs.get(session.id)!.dir;
  return { call, prefix, dir };
}
type Run = Awaited<ReturnType<typeof run>>;

const badgeSpan = tagOf(BADGE, 'components/Badge.tsx', '<span');
const homeBadge = tagOf(HOME, 'app/page.tsx', '<Badge>New');
const widen: EditOperation[] = [{ op: 'replace-class', target: badgeSpan, from: 'text-sm', to: 'text-lg' }];
const ask = (r: Run, extra: Record<string, unknown> = {}) => r.call(`${r.prefix}/ask`, 'POST', { tag: homeBadge, route: '/', instruction: 'Make badges bigger', ...extra });
const confirm = (r: Run, proposalId: string | undefined, extra: Record<string, unknown> = {}) => r.call(`${r.prefix}/confirm`, 'POST', { proposalId, allowSharedComponent: true, ...extra });

test('an Ask for a shared component makes one model call, then confirms the saved operations without another', async () => {
  const client = scripted([widen]);
  const r = await run(client);
  const first = await ask(r);
  expect(first.status).toBe(422);
  expect(first.body.ok).toBe(false);
  expect(client.state.calls).toBe(1);
  expect(first.body.confirm?.map((c) => c.component)).toEqual(['Badge']);
  const proposal = first.body.proposal!;
  expect(proposal.id).toMatch(/^[0-9a-f]{32}$/);
  expect(proposal.kind).toBe('ask');
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);

  // The model script would answer differently on a second call; the replay must not make one.
  const done = await confirm(r, proposal.id, { tags: [homeBadge] });
  expect(done.status).toBe(200);
  expect(client.state.calls).toBe(1);
  expect(done.body.session?.pending?.kind).toBe('ask');
  expect(done.body.session?.pending?.changes.map((c) => c.file)).toEqual(['components/Badge.tsx']);
  expect(done.body.session?.proposal).toBeNull();
  expect(done.body.moved?.[homeBadge]).toBe(homeBadge);
  expect(await read(r.dir, 'components/Badge.tsx')).toContain('text-lg');
  const kinds = done.body.session?.pending?.checks.map((c) => `${c.name}:${c.status}`);
  expect(kinds).toContain('typecheck:passed');
  expect(kinds).toContain('render:not-run');
  expect(kinds).toContain('lint:not-run');
});

test('the proposal lists the routes and call sites from the extracted usage, with relative paths', async () => {
  const r = await run(scripted([widen]));
  const { body } = await ask(r);
  const [impact] = body.proposal!.components;
  expect(impact).toMatchObject({ component: 'Badge', file: 'components/Badge.tsx', line: 1, uses: 3, moreSites: 0 });
  expect(impact!.routes.map((route) => [route.pattern, route.page])).toEqual([['/', 'app/page.tsx'], ['/about', 'app/about/page.tsx']]);
  expect(impact!.sites.map((site) => `${site.file}:${site.line}`).sort()).toEqual(['app/about/page.tsx:6', 'app/page.tsx:6', 'app/page.tsx:7']);
  expect(JSON.stringify(body.proposal)).not.toContain(r.dir);
  expect(JSON.stringify(body.proposal)).not.toContain('operations');
});

test('a direct edit inside a shared definition asks for the same confirmation and replays the saved operations', async () => {
  const r = await run();
  const operations = [{ op: 'replace-class', target: badgeSpan, from: 'px-2', to: 'px-4' }];
  const first = await r.call(`${r.prefix}/edit`, 'POST', { tag: badgeSpan, operations, label: 'Padding: 2 to 4' });
  expect(first.status).toBe(422);
  expect(first.body.proposal).toMatchObject({ kind: 'direct', instruction: 'Padding: 2 to 4' });
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
  const done = await confirm(r, first.body.proposal!.id);
  expect(done.status).toBe(200);
  expect(done.body.session?.pending).toMatchObject({ kind: 'direct', instruction: 'Padding: 2 to 4' });
  expect(await read(r.dir, 'components/Badge.tsx')).toContain('px-4');
});

test('a client cannot widen scope by sending allow with an Ask or a direct edit', async () => {
  const r = await run(scripted([widen]));
  const direct = await r.call(`${r.prefix}/edit`, 'POST', { tag: badgeSpan, allow: ['components/Badge.tsx:1'], operations: [{ op: 'replace-class', target: badgeSpan, from: 'px-2', to: 'px-4' }] });
  expect(direct.status).toBe(422);
  const asked = await ask(r, { allow: ['components/Badge.tsx:1', 'components/Badge.tsx'] });
  expect(asked.status).toBe(422);
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('a page-local Ask needs no confirmation', async () => {
  const h1 = tagOf(HOME, 'app/page.tsx', '<h1');
  const r = await run(scripted([[{ op: 'replace-class', target: h1, from: 'text-xl', to: 'text-2xl' }]]));
  const local = await ask(r, { tag: h1 });
  expect(local.status).toBe(200);
  expect(local.body.session?.pending?.changes.map((c) => c.file)).toEqual(['app/page.tsx']);
  expect(local.body.session?.proposal).toBeNull();
});

test('a component used once on one route needs no confirmation', async () => {
  const page = HOME.replace('<Badge>Sale</Badge>', '<Solo>Only</Solo>').replace('<Badge>New</Badge>', '').replace("import { Badge } from '../components/Badge';", "import { Solo } from '../components/Solo';");
  const r = await run(null, undefined, { ...FILES, 'app/page.tsx': page, 'app/about/page.tsx': ABOUT.replace('<Badge>Team</Badge>', '').replace("import { Badge } from '../../components/Badge';\n", '') });
  const em = tagOf(SOLO, 'components/Solo.tsx', '<em');
  const result = await r.call(`${r.prefix}/edit`, 'POST', { tag: em, operations: [{ op: 'replace-class', target: em, from: 'italic', to: 'not-italic' }] });
  expect(result.status).toBe(200);
  expect(result.body.session?.proposal).toBeNull();
});

test('cancel writes nothing and spends the proposal', async () => {
  const client = scripted([widen]);
  const r = await run(client);
  const { body } = await ask(r);
  const cancelled = await r.call(`${r.prefix}/cancel`, 'POST', { proposalId: body.proposal!.id });
  expect(cancelled.body).toMatchObject({ ok: true, cancelled: true });
  expect(cancelled.body.session?.proposal).toBeNull();
  expect(cancelled.body.session?.pending).toBeNull();
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
  expect(((await $`git status --porcelain -uno`.cwd(r.dir).quiet().text()).trim())).toBe('');
  const late = await confirm(r, body.proposal!.id);
  expect(late.status).toBe(404);
  expect(late.body.code).toBe('UNKNOWN_PROPOSAL');
  expect(client.state.calls).toBe(1);
});

test('confirming needs allowSharedComponent: true and the proposal ID', async () => {
  const r = await run(scripted([widen]));
  const { body } = await ask(r);
  expect((await r.call(`${r.prefix}/confirm`, 'POST', { proposalId: body.proposal!.id })).status).toBe(400);
  expect((await r.call(`${r.prefix}/confirm`, 'POST', { proposalId: body.proposal!.id, allowSharedComponent: 'yes' })).status).toBe(400);
  expect((await r.call(`${r.prefix}/confirm`, 'POST', { allowSharedComponent: true })).status).toBe(400);
  expect((await confirm(r, 'f'.repeat(32))).status).toBe(404);
  // The proposal survives the refused attempts.
  expect((await confirm(r, body.proposal!.id)).status).toBe(200);
});

test('an external change to the shared file, the selection file or a consumer makes the proposal stale', async () => {
  for (const [file, text] of [
    ['components/Badge.tsx', BADGE.replace('rounded', 'rounded-full')],
    ['app/page.tsx', HOME.replace('Hello', 'Welcome')],
    ['app/about/page.tsx', ABOUT.replace('About', 'About us')],
  ] as const) {
    const client = scripted([widen]);
    const r = await run(client);
    const { body } = await ask(r);
    await writeFile(join(r.dir, file), text);
    const stale = await confirm(r, body.proposal!.id);
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_PROPOSAL');
    expect(client.state.calls).toBe(1);
    expect(await read(r.dir, file)).toBe(text);
    expect(await read(r.dir, 'components/Badge.tsx')).not.toContain('text-lg');
    // Spent: a retry cannot succeed on the same ID.
    expect((await confirm(r, body.proposal!.id)).status).toBe(404);
    await closers.pop()!();
    await t.cleanup();
  }
});

test('another change invalidates the proposal', async () => {
  const r = await run(scripted([widen]));
  const { body } = await ask(r);
  const h1 = tagOf(HOME, 'app/page.tsx', '<h1');
  const other = await r.call(`${r.prefix}/edit`, 'POST', { tag: h1, operations: [{ op: 'set-text', target: h1, text: 'Hi' }] });
  expect(other.status).toBe(200);
  expect(other.body.session?.proposal).toBeNull();
  await r.call(`${r.prefix}/keep`, 'POST');
  const late = await confirm(r, body.proposal!.id);
  expect(late.status).toBe(404);
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('an expired proposal is refused and cannot be confirmed later', async () => {
  let now = 1_000;
  const r = await run(scripted([widen]), { ttlMs: 500, now: () => now });
  const { body } = await ask(r);
  expect(body.proposal!.expiresAt).toBe(1_500);
  now = 1_500;
  const view = await r.call(r.prefix);
  expect(view.body.proposal).toBeNull();
  const late = await confirm(r, body.proposal!.id);
  expect(late.status).toBe(409);
  expect(late.body.code).toBe('EXPIRED_PROPOSAL');
  expect((await confirm(r, body.proposal!.id)).status).toBe(404);
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('a confirmation that would fail the checks is never offered, and nothing is written', async () => {
  const bad: EditOperation[] = [{ op: 'set-prop', target: badgeSpan, name: 'className', value: { expression: 'missingName' } }];
  const client = scripted([bad]);
  const r = await run(client);
  const result = await ask(r);
  expect(result.status).toBe(422);
  expect(result.body.proposal).toBeNull();
  expect(client.state.calls).toBe(3);
  expect(result.body.errors?.some((e) => e.includes('typecheck'))).toBe(true);
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('Keep after a confirmed shared change commits it and a later confirm cannot reuse the proposal', async () => {
  const r = await run(scripted([widen]));
  const { body } = await ask(r);
  await confirm(r, body.proposal!.id);
  const kept = await r.call(`${r.prefix}/keep`, 'POST');
  expect(kept.status).toBe(200);
  expect((await confirm(r, body.proposal!.id)).status).toBe(404);
});

const proposal = (overrides: Partial<NewProposal> = {}): NewProposal => ({ kind: 'ask', tag: 'app/page.tsx:1:1', instruction: 'x', operations: [], confirm: [], impact: [], snapshot: 'a', ...overrides });

test('a proposal store spends a proposal once, expires it, and replaces it with the next', () => {
  let now = 0;
  const store = new ProposalStore(() => now, 100);
  const first = store.create(proposal());
  const second = store.create(proposal({ snapshot: 'b' }));
  expect(store.take(first.id, 'a')).toEqual({ ok: false, reason: 'unknown' });
  expect(store.take(second.id, 'a')).toEqual({ ok: false, reason: 'stale' });
  expect(store.take(second.id, 'b')).toEqual({ ok: false, reason: 'unknown' });
  const third = store.create(proposal());
  now = 100;
  expect(store.peek()).toBeUndefined();
  expect(store.take(third.id, 'a')).toEqual({ ok: false, reason: 'expired' });
  const fourth = store.create(proposal());
  store.clear();
  expect(store.cancel(fourth.id)).toBe(false);
});

test('a saved proposal cannot be changed after it is created', () => {
  const ops: EditOperation[] = [{ op: 'set-text', target: 'app/page.tsx:1:1', text: 'a' }];
  const store = new ProposalStore();
  const saved = store.create(proposal({ operations: ops }));
  ops[0] = { op: 'set-text', target: 'app/page.tsx:1:1', text: 'changed' };
  expect(saved.operations[0]).toMatchObject({ text: 'a' });
  expect(() => { (saved as { id: string }).id = 'x'; }).toThrow();
});

test('new untracked source files invalidate a saved proposal', async () => {
  const r = await run(scripted([widen]));
  const first = await ask(r);
  await writeFile(join(r.dir, 'components/New.tsx'), 'export function New() { return <p>New consumer</p>; }\n');
  const result = await confirm(r, first.body.proposal!.id);
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('STALE_PROPOSAL');
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('a new page updates sharing before an ordinary edit', async () => {
  const single = HOME.replace('      <Badge>Sale</Badge>\n', '');
  const r = await run(null, undefined, { 'components/Badge.tsx': BADGE, 'app/page.tsx': single });
  await r.call(`${r.prefix}/inspect`, 'POST', { tag: badgeSpan });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(r.dir, 'app/extra'));
  await writeFile(join(r.dir, 'app/extra/page.tsx'), ABOUT);
  const result = await r.call(`${r.prefix}/edit`, 'POST', { tag: badgeSpan, operations: widen });
  expect(result.status).toBe(422);
  expect(result.body.proposal?.components[0]?.component).toBe('Badge');
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});

test('compiler configuration changes invalidate a saved proposal', async () => {
  const r = await run(scripted([widen]));
  const first = await ask(r);
  await writeFile(join(r.dir, 'tsconfig.json'), '{"compilerOptions":{"strict":false,"jsx":"preserve"}}');
  const result = await confirm(r, first.body.proposal!.id);
  expect(result.status).toBe(409);
  expect(result.body.code).toBe('STALE_PROPOSAL');
  expect(await read(r.dir, 'components/Badge.tsx')).toBe(BADGE);
});
