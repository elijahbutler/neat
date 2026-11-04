// Standalone loopback editor server. The local path never loads the hosted Next app or auth providers.
import { createEditClient, resolveEditModel, MODEL_SETUP_NOTE } from '../edit/model';
import { buildShell } from './shell';
import { allocatePort, createWorktreeProvider, reclaimSessions } from '../sandbox/worktree';
import type { SandboxProvider } from '../sandbox/docker';
import { $ } from 'bun';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Node, type Project } from 'ts-morph';
import { createCatalogueClient, type CatalogueReference } from '../catalogue/client';
import { buildLibrary } from '../catalogue/library';
import { proposeEdit } from '../edit/agent';
import { panelOptions } from '../edit/classes';
import { directEdit } from '../edit/direct';
import { buildRepoIndex, findJsxAt, loadEditProject, resolveSelection, type RepoIndex } from '../edit/index';
import type { FileChange } from '../edit/operations';
import { styleSource } from '../edit/properties';
import { textSource } from '../edit/text';
import { extractDesignSystem } from '../extract/profile';
import { projectPath } from '../extract/project';
import { dockerProvider, type SandboxInfo, type SandboxState } from '../sandbox/docker';
import { exclusive, SessionBusyError, type Lockable } from './lock';

export interface WorkerOptions { repo: string; app?: string; port?: number; docker?: boolean }
export function createWorker(options: WorkerOptions & { origin: string; shell: Map<string, { body: string | Blob; type: string }>; provider: SandboxProvider }) {
const { provider } = options;
const EDITOR_ORIGIN = options.origin;
const config = resolveEditModel();
const MODEL = config?.model ?? 'No model configured';
const FIXTURES = [options.repo];
/** `direct` changes come from a control in the editor, `ask` changes from the model. Both wait for Keep or Undo. */
interface Pending { kind: 'ask' | 'direct'; instruction: string; tag: string; changes: FileChange[]; reference?: CatalogueReference }
interface Session extends Lockable {
  id: string;
  fixture: string;
  info: SandboxInfo;
  state: SandboxState;
  project?: Project;
  index?: RepoIndex;
  pending?: Pending;
  history: Array<{ instruction: string; files: string[]; commit: string }>;
}

const sessions = new Map<string, Session>();
let starting: Promise<SandboxInfo> | undefined;
let closing = false;
const catalogue = createCatalogueClient();
const client = config ? createEditClient(config) : null;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (status: number, message: string) => json({ error: message }, status);

function view(s: Session) {
  return {
    id: s.id, fixture: s.fixture, state: s.state, previewUrl: s.info.previewUrl,
    pending: s.pending
      ? { kind: s.pending.kind, instruction: s.pending.instruction, changes: s.pending.changes, reference: s.pending.reference && { id: s.pending.reference.id, revision: s.pending.reference.revision, catalogueVersion: s.pending.reference.catalogueVersion } }
      : null,
    history: s.history,
  };
}

/** Load the working copy for inspection and editing once dependencies are installed, and after every edit. */
function refresh(s: Session): RepoIndex {
  s.project ??= loadEditProject(s.info.dir);
  s.index = buildRepoIndex(extractDesignSystem(s.info.dir, { project: s.project, commit: s.id }), s.project, s.info.dir);
  return s.index;
}

function sourceFile(s: Session, file: string) {
  return s.project!.getSourceFiles().find((sf) => projectPath(s.info.dir, sf.getFilePath()) === file);
}

async function writeChanges(s: Session, changes: FileChange[], which: 'before' | 'after') {
  for (const change of changes) {
    await writeFile(join(s.info.dir, change.file), change[which]);
    sourceFile(s, change.file)?.replaceWithText(change[which]);
  }
  refresh(s);
}

interface Ancestor { src: string | null; inst: string | null; childIndex: number }

/**
 * When the click lands inside a component that doesn't pass its source tag to the DOM, find the instance that
 * rendered it: the first tagged ancestor outside the component's file, and its JSX child at the same position as the
 * DOM child that contains the click. Gives up rather than guess when the parent's children include expressions.
 */
function findInstance(s: Session, componentName: string, componentFile: string, ancestors: Ancestor[]) {
  for (const ancestor of ancestors) {
    const src = ancestor.src;
    if (!src || src.startsWith(`${componentFile}:`)) continue;
    const found = findJsxAt(s.project!, s.info.dir, src);
    const element = found && Node.isJsxOpeningElement(found.opening) ? found.opening.getParent() : null;
    if (!element || !Node.isJsxElement(element)) return null;
    const children = element.getJsxChildren().filter((c) => !(Node.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces()));
    if (children.some((c) => !Node.isJsxElement(c) && !Node.isJsxSelfClosingElement(c))) return null;
    const child = children[ancestor.childIndex];
    const opening = child && (Node.isJsxElement(child) ? child.getOpeningElement() : Node.isJsxSelfClosingElement(child) ? child : null);
    if (!opening || opening.getTagNameNode().getText() !== componentName) return null;
    const { line, column } = found!.sf.getLineAndColumnAtPos(opening.getStart());
    return { tag: `${found!.file}:${line}:${column}`, file: found!.file, line };
  }
  return null;
}

async function inspect(s: Session, tag: string, route: string, ancestors: Ancestor[] = []) {
  const index = s.index ?? refresh(s);
  const selection = resolveSelection(s.project!, s.info.dir, index, tag);
  if (!selection) return null;
  const sf = sourceFile(s, selection.source.file)!;
  const opening = sf.getDescendantAtPos(sf.compilerNode.getPositionOfLineAndCharacter(selection.source.line - 1, selection.source.column - 1));
  const el = opening?.getFirstAncestor((n) => n.getKindName() === 'JsxOpeningElement' || n.getKindName() === 'JsxSelfClosingElement') ?? opening;
  const className = /className=(?:"([^"]*)"|\{`([^`]*)`\})/.exec(el?.getText() ?? '');
  const instance = selection.component ? findInstance(s, selection.component.name, selection.component.source.file, ancestors) : null;
  // Show the code the user will be changing: the instance on the page when there is one.
  const shown = instance ? { file: instance.file, line: instance.line } : { file: selection.source.file, line: selection.source.line };
  const shownLines = sourceFile(s, shown.file)!.getFullText().split('\n');
  const from = Math.max(0, shown.line - 4);
  return {
    instance: instance && { ...instance, name: selection.component!.name },
    tag,
    route,
    element: selection.tag,
    file: selection.source.file,
    line: selection.source.line,
    component: selection.component ? { name: selection.component.name, file: selection.component.source.file, line: selection.component.source.line, variants: selection.component.variants, uses: selection.component.uses } : null,
    instanceOf: index.components.find((c) => c.name === (instance ? selection.component!.name : selection.tag)) ?? null,
    classes: (className?.[1] ?? className?.[2] ?? '').split(/\s+/).filter(Boolean),
    parents: selection.parents.slice(0, 6),
    // For the property panel: the element an edit targets, whether its classes can be changed, and the choices.
    style: styleSource(s.project!, s.info.dir, instance?.tag ?? tag),
    options: panelOptions(index.profile),
    source: shownLines.slice(from, shown.line + 3).map((text, i) => ({ line: from + i + 1, text })),
  };
}

/**
 * Whether the text of a double-clicked element can be edited in place, and which source tag the edit should target.
 * Text a component receives as children is edited where the component is used, when that text is written there.
 */
function editableText(s: Session, tag: string, ancestors: Ancestor[]) {
  const index = s.index ?? refresh(s);
  const source = textSource(s.project!, s.info.dir, index, tag);
  if (source.editable || source.reason !== 'prop') return source;
  const component = resolveSelection(s.project!, s.info.dir, index, tag)?.component;
  const instance = component ? findInstance(s, component.name, component.source.file, ancestors) : null;
  if (!instance) return source;
  const atInstance = source.prop === 'children' ? textSource(s.project!, s.info.dir, index, instance.tag) : null;
  return atInstance?.editable ? atInstance : textSource(s.project!, s.info.dir, index, tag, { file: instance.file, line: instance.line });
}

const strings = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

/** Ask, direct edits, keep, and undo, run one at a time per session. */
async function change(s: Session, action: 'ask' | 'edit' | 'keep' | 'undo', body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  if (action === 'edit') {
    // The direct-edit path: operations from a control, applied with the same scope and checks as an Ask, no model.
    if (s.pending) return fail(409, 'Keep or undo the last change first.');
    const tag = String(body.tag ?? '');
    // Load the project before reading it: an edit can be the first request a session gets, ahead of any inspect.
    const index = s.index ?? refresh(s);
    const result = directEdit(s.project!, s.info.dir, index, { tag, operations: body.operations, allow: strings(body.allow), label: typeof body.label === 'string' ? body.label : undefined });
    if (!result.ok) return json(result, 422);
    await writeChanges(s, result.changes, 'after');
    s.pending = { kind: 'direct', instruction: result.summary, tag, changes: result.changes };
    return json({ ok: true, session: view(s) });
  }
  if (action === 'ask') {
    if (!client) return fail(503, MODEL_SETUP_NOTE);
    if (s.pending) return fail(409, 'Keep or undo the last change first.');
    const instruction = String(body.instruction ?? '').trim();
    if (!instruction) return fail(400, 'Say what to change.');
    // A catalogue pick arrives as { id, revision } from the library listing and is pinned to that revision.
    let reference: CatalogueReference | undefined;
    const picked = body.reference as { id?: unknown; revision?: unknown } | undefined;
    if (picked) {
      if (typeof picked.id !== 'string' || typeof picked.revision !== 'string') return fail(400, 'A catalogue reference needs an id and the revision you picked.');
      const resolved = await catalogue.resolve(picked.id, picked.revision);
      if (!resolved.ok) return fail(resolved.status, 'Catalogue reference unavailable.');
      reference = resolved.reference;
    }
    const index = s.index ?? refresh(s);
    // The selection is the scope. `allow` carries wider targets the person confirmed after a needs-confirmation reply.
    const allow = strings(body.allow);
    const outcome = await proposeEdit({ signal, client, model: MODEL, project: s.project!, root: s.info.dir, index, route: String(body.route ?? '/'), tag: String(body.tag ?? ''), instruction, reference, allow });
    if (!outcome.changes) return json({ ok: false, attempts: outcome.attempts, errors: outcome.errors, confirm: outcome.confirm }, 422);
    await writeChanges(s, outcome.changes, 'after');
    s.pending = { kind: 'ask', instruction, tag: String(body.tag), changes: outcome.changes, reference };
    return json({ ok: true, attempts: outcome.attempts, usage: outcome.usage, session: view(s) });
  }
  if (!s.pending) return fail(409, 'There is no change waiting to be kept or undone.');
  if (action === 'keep') {
    const files = s.pending.changes.map((c) => c.file);
    await $`git add -- ${files}`.cwd(s.info.dir).quiet();
    await $`git -c user.name=Neat -c user.email=sandbox@neatlabs.design commit -q -m ${s.pending.instruction}`.cwd(s.info.dir).quiet();
    const commit = (await $`git rev-parse --short HEAD`.cwd(s.info.dir).quiet().text()).trim();
    s.history.push({ instruction: s.pending.instruction, files, commit });
  } else {
    await writeChanges(s, s.pending.changes, 'before');
  }
  s.pending = undefined;
  return json(view(s));
}

async function handle(req: Request): Promise<Response> {
  if (req.headers.get('origin') && req.headers.get('origin') !== EDITOR_ORIGIN) return fail(403, 'Wrong editor origin.');
  if (req.headers.get('sec-fetch-site') === 'cross-site') return fail(403, 'Cross-site request refused.');
  const url = new URL(req.url);
  const asset = options.shell.get(url.pathname);
  if (asset && req.method === 'GET') return new Response(asset.body, { headers: { 'content-type': asset.type } });
  if (!url.pathname.startsWith('/api/editor/')) return fail(404, 'Not found.');
  const parts = url.pathname.slice('/api/editor/'.length).split('/').filter(Boolean);
  const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};

  if (parts[0] === 'fixtures') return json({ fixtures: FIXTURES, model: MODEL, modelReady: client !== null, modelSetupNote: MODEL_SETUP_NOTE });
  if (parts[0] !== 'sessions') return fail(404, 'Not found.');

  if (parts.length === 1) {
    if (req.method === 'GET') return json({ sessions: [...sessions.values()].map(view) });
    const fixture = String(body.fixture ?? '');
    if (!FIXTURES.includes(fixture)) return fail(400, 'Unknown repository.');
    const id = randomBytes(4).toString('hex');
    if (sessions.size) return json(view([...sessions.values()][0]!));
    if (closing) return fail(503, 'Editor is shutting down.');
    if (starting) return fail(409, 'A preview is already starting.');
    starting = provider.start(id, options.repo, { editorOrigin: EDITOR_ORIGIN });
    let info: SandboxInfo;
    try { info = await starting; } finally { starting = undefined; }
    const session: Session = { id, fixture, info, state: 'starting', history: [] };
    sessions.set(id, session);
    return json(view(session), 201);
  }

  const s = sessions.get(parts[1]!);
  if (!s) return fail(404, 'No such session. It may have stopped when the worker restarted.');
  const action = parts[2];

  if (!action && req.method === 'GET') {
    s.state = await provider.state(s.info);
    return json(view(s));
  }
  if (!action && req.method === 'DELETE') {
    await provider.stop(s.info);
    sessions.delete(s.id);
    return json({ ok: true });
  }
  if (action === 'preview' && req.method === 'GET') {
    const target = new URL('/' + parts.slice(3).join('/') + url.search, s.info.previewUrl);
    const response = await fetch(target);
    const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response(response.body, { status: response.status, headers });
  }
  if (action === 'logs') return json({ logs: await provider.logs(s.info, 120) });
  if (s.state !== 'ready') return fail(409, 'The preview is still starting.');

  if (action === 'library') {
    const index = s.index ?? refresh(s);
    const state = await catalogue.read();
    return json(buildLibrary(index.components, state.status === 'unavailable' ? { status: 'unavailable', reason: 'Catalogue unavailable.' } : state));
  }

  if (action === 'inspect') {
    const result = await inspect(s, String(body.tag ?? ''), String(body.route ?? '/'), Array.isArray(body.ancestors) ? (body.ancestors as Ancestor[]) : []);
    return result ? json(result) : fail(404, 'That element is no longer in the code. Click it again.');
  }

  if (action === 'text') {
    return json(editableText(s, String(body.tag ?? ''), Array.isArray(body.ancestors) ? (body.ancestors as Ancestor[]) : []));
  }

  if (action === 'ask' || action === 'edit' || action === 'keep' || action === 'undo') {
    try {
      return await exclusive(s, () => change(s, action, body, req.signal));
    } catch (error) {
      if (error instanceof SessionBusyError) return fail(409, error.message);
      throw error;
    }
  }
  return fail(404, 'Not found.');
}

return {
  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('host') !== new URL(EDITOR_ORIGIN).host) return fail(403, 'Wrong editor host.');
    try { return await handle(req); }
    catch (error) {
      // Filesystem metadata helps diagnosis without printing arbitrary messages or env contents.
      console.error('Worker request failed.', {
        name: error instanceof Error ? error.name : 'UnknownError',
        code: error && typeof error === 'object' && 'code' in error ? error.code : undefined,
        path: error && typeof error === 'object' && 'path' in error ? error.path : undefined,
        dest: error && typeof error === 'object' && 'dest' in error ? error.dest : undefined,
      });
      return json({ error: 'Worker request failed.', code: 'WORKER_REQUEST_FAILED' }, 500);
    }
  },
  async close() { closing = true; await starting?.catch(() => undefined); await Promise.all([...sessions.values()].map(s => provider.stop(s.info))); sessions.clear(); },
};
}

export async function startWorker(options: WorkerOptions) {
  await reclaimSessions();
  const port = await allocatePort(options.port ?? 4317);
  const origin = `http://127.0.0.1:${port}`;
  const shell = await buildShell();
  const provider = options.docker ? dockerProvider : createWorktreeProvider({ app: options.app });
  const worker = createWorker({ ...options, origin, shell, provider });
  const server = Bun.serve({ hostname: '127.0.0.1', port, idleTimeout: 120, fetch: worker.fetch });
  let stopping = false;
  const close = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop(true);
    await worker.close();
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  };
  const onSignal = () => { void close().then(() => process.exit(0)); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const response = await worker.fetch(new Request(`${origin}/api/editor/sessions`, { method: 'POST', headers: { host: new URL(origin).host, 'content-type': 'application/json' }, body: JSON.stringify({ fixture: options.repo }) }));
    if (!response.ok) throw new Error(await response.text());
    console.log(`Editor: ${origin}/editor`);
    return { server, close, origin };
  } catch (error) { await close(); throw error; }
}
