'use client';

import { Check, Loader2, Monitor, MousePointer2, Smartphone, Square, Tablet, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PanelOptions } from '../../edit/classes';
import type { EditOperation } from '../../edit/operations';
import type { StyleSource } from '../../edit/properties';
import { textEditTracker, textOperation } from './direct';
import { PropertyPanel } from './PropertyPanel';

interface FileChange { file: string; before: string; after: string }
interface Session {
  id: string;
  fixture: string;
  state: 'starting' | 'ready' | 'stopped' | 'failed';
  previewUrl: string;
  pending: { kind: 'ask' | 'direct'; instruction: string; changes: FileChange[] } | null;
  history: Array<{ instruction: string; files: string[]; commit: string }>;
}
interface Target { src: string | null; inst: string | null; element: string; text: string; ancestors: Array<{ src: string | null; inst: string | null; childIndex: number }> }
/** The worker's answer to a double-click: edit this source tag, or a message saying where the text lives. */
type TextAnswer = { editable: true; target: string } | { editable: false; message: string };
interface Inspection {
  tag: string;
  /** The JSX instance that rendered the clicked component, when the click landed inside one. Edits target this. */
  instance: { tag: string; file: string; line: number; name: string } | null;
  element: string;
  file: string;
  line: number;
  component: { name: string; file: string; line: number; uses: number } | null;
  instanceOf: { name: string; source: { file: string; line: number }; variants: Array<{ prop: string; options: string[]; defaultValue?: string }>; uses: number } | null;
  classes: string[];
  parents: Array<{ tag: string; props: string; line: number }>;
  source: Array<{ line: number; text: string }>;
  /** The element the property panel edits, and whether its classes are a plain list. Null if it left the code. */
  style: StyleSource | null;
  options: PanelOptions;
}

const WIDTHS = { desktop: null, tablet: 834, phone: 390 } as const;
type Width = keyof typeof WIDTHS;

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`/api/editor/${path}`, {
    method: init?.method ?? (init?.body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json' },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok && data.error) throw new Error(data.error);
  return data;
}

/** Line diff for small files: longest common subsequence, then walk it. */
function diffLines(before: string, after: string): Array<{ kind: ' ' | '+' | '-'; text: string }> {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: Array<{ kind: ' ' | '+' | '-'; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { out.push({ kind: ' ', text: a[i]! }); i++; j++; }
    // Removals before additions, the way diffs usually read.
    else if (i < a.length && (j >= b.length || dp[i + 1]![j]! >= dp[i]![j + 1]!)) out.push({ kind: '-', text: a[i++]! });
    else out.push({ kind: '+', text: b[j++]! });
  }
  // Keep two lines of context around changes.
  return out.filter((line, k) => line.kind !== ' ' || out.slice(Math.max(0, k - 2), k + 3).some((l) => l.kind !== ' '));
}

export function EditorApp() {
  const [fixtures, setFixtures] = useState<string[]>([]);
  const [model, setModel] = useState<{ name: string; ready: boolean; setupNote: string } | null>(null);
  const [fixture, setFixture] = useState('orbit-studio');
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [width, setWidth] = useState<Width>('desktop');
  const [selecting, setSelecting] = useState(true);
  const [route, setRoute] = useState('/');
  const [target, setTarget] = useState<Target | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [instruction, setInstruction] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // What a direct edit did or why it didn't happen. Shown above the inspector.
  const [notice, setNotice] = useState<string | null>(null);
  // The page element being typed in (`key`, as the preview knows it) and the source tag its text is written at.
  const [textEdit] = useState(textEditTracker);
  const [editing, setEditing] = useState(false);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api<{ fixtures: string[]; model: string; modelReady: boolean; modelSetupNote: string }>('fixtures')
      .then((d) => { setFixtures(d.fixtures); setFixture(d.fixtures[0] ?? ''); setModel({ name: d.model, ready: d.modelReady, setupNote: d.modelSetupNote }); })
      .catch((e: Error) => setError(e.message));
    api<{ sessions: Session[] }>('sessions').then(d => { if (d.sessions[0]) setSession(d.sessions[0]); }).catch((e: Error) => setError(e.message));
  }, []);

  // Poll while the sandbox installs and boots.
  useEffect(() => {
    if (!session || session.state !== 'starting') return;
    const timer = setInterval(async () => {
      try {
        const next = await api<Session>(`sessions/${session.id}`);
        setSession(next);
        if (next.state === 'failed') setLogs((await api<{ logs: string }>(`sessions/${session.id}/logs`)).logs);
      } catch (e) { setError((e as Error).message); }
    }, 1000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [started]);

  const post = useCallback((message: object) => {
    if (session) frame.current?.contentWindow?.postMessage(message, new URL(session.previewUrl).origin);
  }, [session]);

  const inspect = useCallback(async (tag: string, at: string, ancestors: Target['ancestors']) => {
    if (!session) return;
    try { setInspection(await api<Inspection>(`sessions/${session.id}/inspect`, { body: { tag, route: at, ancestors } })); }
    catch (e) { setInspection(null); setAskError((e as Error).message); }
  }, [session]);

  /** Send operations from a control to the worker. They apply without the model and wait for Keep or Undo. */
  const directEdit = useCallback(async (tag: string, operations: EditOperation[], label?: string): Promise<boolean> => {
    if (!session) return false;
    setEditing(true);
    try {
      const res = await api<{ ok: boolean; session?: Session; message?: string }>(`sessions/${session.id}/edit`, { body: { tag, operations, label } });
      if (!res.ok || !res.session) { setNotice(res.message ?? "That change couldn't be made."); return false; }
      // The selection stays, so the panel is back on the same element once the change is kept or undone.
      setNotice(null); setSession(res.session);
      return true;
    } catch (e) { setNotice((e as Error).message); return false; }
    finally { setEditing(false); }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const origin = new URL(session.previewUrl).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || !e.data || typeof e.data.type !== 'string') return;
      if (e.data.type === 'neat:text-request') {
        const t = e.data.target as Target;
        const key = t.inst ?? t.src;
        if (!key) return;
        if (session.pending) { setNotice('Keep or undo the last change first.'); return; }
        // A second double-click can land before this one is answered. Answers to anything but the newest are dropped.
        const ticket = textEdit.ask();
        api<TextAnswer>(`sessions/${session.id}/text`, { body: { tag: key, route: e.data.route, ancestors: t.ancestors } })
          .then((answer) => {
            if (!answer.editable) { if (textEdit.isLatest(ticket)) setNotice(answer.message); return; }
            if (!textEdit.answer(ticket, key, answer.target)) return;
            setNotice(null);
            post({ type: 'neat:text-edit', key });
          })
          .catch((err: Error) => { if (textEdit.isLatest(ticket)) setNotice(err.message); });
      }
      if (e.data.type === 'neat:text-commit') {
        const key = String(e.data.key ?? '');
        const tag = textEdit.commit(key);
        const operation = tag ? textOperation(tag, String(e.data.text ?? '')) : null;
        // The page already shows the typed text. Put the old text back if the edit isn't made, whatever the reason.
        void (tag && operation ? directEdit(tag, [operation]) : Promise.resolve(false)).then((ok) => { if (!ok) post({ type: 'neat:text-revert', key }); });
        if (!tag) setNotice("That text change wasn't saved. Double-click the text and try again.");
      }
      if (e.data.type === 'neat:text-cancel') {
        textEdit.cancel(String(e.data.key ?? ''));
        if (e.data.reason === 'preformatted') setNotice("This text keeps its spaces and line breaks exactly as written, so it can't be edited on the page. Ask for the change instead.");
        if (e.data.reason === 'empty') setNotice("Text can't be empty. To remove this element, ask for it.");
        if (e.data.reason === 'mixed') setNotice('This element holds other elements, not only text. Double-click the text itself, or ask for the change.');
      }
      if (e.data.type === 'neat:route' || e.data.type === 'neat:ready') setRoute(e.data.route);
      if (e.data.type === 'neat:ready') post({ type: 'neat:mode', selecting });
      if (e.data.type === 'neat:select') {
        const t = e.data.target as Target;
        setTarget(t);
        setAskError(null);
        setNotice(null);
        // A component's instance tag points at where it's used, which is what an edit should change.
        const tag = t.inst ?? t.src;
        if (tag) void inspect(tag, e.data.route, t.ancestors);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, selecting, inspect, post, directEdit, textEdit]);

  useEffect(() => { post({ type: 'neat:mode', selecting }); }, [selecting, post]);

  async function start() {
    setError(null); setLogs(null); setTarget(null); setInspection(null); setNotice(null);
    try { setSession(await api<Session>('sessions', { body: { fixture } })); }
    catch (e) { setError((e as Error).message); }
  }

  async function stop() {
    if (!session) return;
    await api(`sessions/${session.id}`, { method: 'DELETE' }).catch(() => undefined);
    setSession(null); setTarget(null); setInspection(null);
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!session || !inspection || !instruction.trim() || asking) return;
    setAsking(true); setAskError(null); setStarted(Date.now());
    try {
      const res = await api<{ ok: boolean; session?: Session; errors?: string[]; confirm?: Array<{ component: string; uses: number }> }>(`sessions/${session.id}/ask`, { body: { tag: inspection.instance?.tag ?? inspection.tag, route, instruction } });
      const shared = res.confirm?.[0];
      // The worker refuses changes to a shared component until someone confirms them. That step isn't built yet.
      if (shared) setAskError(`That would change ${shared.component} everywhere it is used (${shared.uses} ${shared.uses === 1 ? 'place' : 'places'}). The editor can't confirm changes to shared components yet. Ask for a change to this element only.`);
      else if (!res.ok || !res.session) setAskError(`Couldn't make that change. ${res.errors?.at(-1) ?? ''}`);
      else { setSession(res.session); setInstruction(''); post({ type: 'neat:clear' }); }
    } catch (err) { setAskError((err as Error).message); }
    finally { setAsking(false); setStarted(null); }
  }

  async function settle(action: 'keep' | 'undo') {
    if (!session) return;
    const tag = target?.inst ?? target?.src;
    const direct = session.pending?.kind === 'direct' && target && tag;
    try {
      setSession(await api<Session>(`sessions/${session.id}/${action}`, { body: {} }));
      // After a direct edit the same element stays selected, read again so the controls show the code as it is now.
      if (direct) { post({ type: 'neat:reselect', tag }); void inspect(tag, route, target.ancestors); }
      else { setInspection(null); setTarget(null); post({ type: 'neat:clear' }); }
    }
    catch (e) { setAskError((e as Error).message); }
  }

  const frameWidth = WIDTHS[width];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page text-ink">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-ink px-4">
        <span className="display text-[22px] leading-none">Neat Labs</span>
        <span className="caption text-quiet">Editor · local</span>
        {session && (
          <>
            <span className="caption rounded-full border border-ink px-2.5">{session.fixture}</span>
            <form
              className="flex min-w-0 flex-1 items-center"
              onSubmit={(e) => { e.preventDefault(); if (frame.current) frame.current.src = new URL(route, session.previewUrl).toString(); }}
            >
              <label htmlFor="route" className="sr-only">Page</label>
              <input id="route" value={route} onChange={(e) => setRoute(e.target.value)} className="w-full max-w-[360px] rounded-full border border-rule bg-wash px-3 py-1 font-mono text-[12px] focus:border-ink" />
            </form>
            <div className="flex items-center gap-1" role="group" aria-label="Preview width">
              {([['desktop', Monitor], ['tablet', Tablet], ['phone', Smartphone]] as const).map(([key, Icon]) => (
                <button key={key} type="button" className="chip !px-2.5 !py-1" aria-pressed={width === key} aria-label={key} title={key} onClick={() => setWidth(key)}>
                  <Icon size={14} />
                </button>
              ))}
            </div>
            <button type="button" className="chip flex items-center gap-1.5" aria-pressed={selecting} onClick={() => setSelecting((s) => !s)} title="Select elements (turn off to use the page normally)">
              <MousePointer2 size={13} /> Select
            </button>
            <button type="button" className="btn-secondary !py-1 !text-[13px]" onClick={stop}>
              <Square size={12} /> Stop
            </button>
          </>
        )}
      </header>

      {!session ? (
        <div className="grid-canvas flex flex-1 items-center justify-center p-6">
          <div className="panel w-full max-w-[440px] space-y-5 p-7">
            <div className="space-y-2">
              <h1 className="display text-[40px]">Open a project</h1>
              <p className="text-[15px] leading-relaxed text-quiet">
                Runs the app from its own code in a local sandbox, with every element tagged back to its source. Click anything to inspect it, then ask for a change.
              </p>
            </div>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Project">
              {fixtures.map((f) => (
                <button key={f} type="button" role="radio" aria-checked={fixture === f} aria-selected={fixture === f} className="chip" onClick={() => setFixture(f)}>{f}</button>
              ))}
            </div>
            <button type="button" className="btn-primary w-full" onClick={start} disabled={!fixtures.length}>Open preview</button>
            {model && !model.ready && <p className="caption text-quiet">{model.setupNote}</p>}
            {error && <p role="alert" className="text-[14px] text-red-700">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="grid-canvas relative flex min-w-0 flex-1 justify-center overflow-auto p-4">
            {session.state === 'ready' ? (
              <iframe
                ref={frame}
                title={`${session.fixture} preview`}
                src={session.previewUrl}
                className="h-full border border-ink bg-page shadow-[4px_4px_0_0_#000]"
                style={{ width: frameWidth ?? '100%' }}
              />
            ) : (
              <div className="self-center text-center" aria-live="polite">
                {session.state === 'failed' ? (
                  <div className="panel max-w-[640px] space-y-3 p-5 text-left">
                    <p className="font-medium">The preview didn&apos;t start.</p>
                    <pre className="code max-h-[320px] whitespace-pre-wrap">{logs ?? 'No logs.'}</pre>
                    <button type="button" className="btn-secondary" onClick={start}>Try again</button>
                  </div>
                ) : (
                  <p className="caption flex items-center gap-2 text-quiet"><Loader2 size={14} className="animate-spin" /> Installing and starting next dev…</p>
                )}
              </div>
            )}
          </div>

          <aside className="flex w-[380px] shrink-0 flex-col border-l border-ink" aria-label="Inspector">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {notice && <p role="status" className="rounded-[6px] border border-rule bg-wash p-3 text-[13px] leading-snug">{notice}</p>}
              {session.pending ? (
                <PendingChange session={session} onSettle={settle} />
              ) : inspection ? (
                <InspectorPanel inspection={inspection} target={target} busy={editing} onEdit={(operations, label) => { if (inspection.style) void directEdit(inspection.style.target, operations, label); }} />
              ) : (
                <p className="text-[15px] text-quiet">{session.state === 'ready' ? 'Click anything on the page to see which component and line it comes from. Double-click text to edit it.' : 'The inspector fills in once the preview is running.'}</p>
              )}
              {session.history.length > 0 && (
                <section className="space-y-2">
                  <h2 className="caption text-quiet">Kept on the session branch</h2>
                  <ul className="space-y-1.5 text-[13px]">
                    {session.history.map((h) => (
                      <li key={h.commit} className="flex gap-2"><span className="font-mono text-quiet">{h.commit}</span><span>{h.instruction}</span></li>
                    ))}
                  </ul>
                </section>
              )}
            </div>

            <form onSubmit={ask} className="space-y-2 border-t border-ink p-4">
              <label htmlFor="ask" className="caption text-quiet">
                {inspection ? `Change this ${inspection.instance?.name ?? inspection.instanceOf?.name ?? inspection.element}` : 'Select an element to ask for a change'}
              </label>
              <textarea
                id="ask"
                rows={3}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                disabled={!inspection || asking || !!session.pending}
                placeholder={session.pending ? 'Keep or undo the last change first.' : 'Make this the main call to action…'}
                className="w-full resize-none rounded-[8px] border border-ink bg-page p-3 text-[14px] placeholder:text-quiet disabled:bg-wash"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="caption text-quiet" aria-live="polite">
                  {asking && started ? `Working · ${((now - started) / 1000).toFixed(1)} s` : model ? model.name : ''}
                </span>
                <button type="submit" className="btn-primary !px-4 !py-2 !text-[14px]" disabled={!inspection || asking || !instruction.trim() || !!session.pending}>
                  {asking ? <Loader2 size={14} className="animate-spin" /> : null} Ask
                </button>
              </div>
              {model && !model.ready && <p className="caption text-quiet">{model.setupNote}</p>}
              {askError && <p role="alert" className="text-[13px] leading-snug text-red-700">{askError}</p>}
            </form>
          </aside>
        </div>
      )}
    </div>
  );
}

function InspectorPanel({ inspection, target, busy, onEdit }: { inspection: Inspection; target: Target | null; busy: boolean; onEdit: (operations: EditOperation[], label: string) => void }) {
  const name = inspection.instance?.name ?? inspection.instanceOf?.name ?? inspection.element;
  return (
    <>
      <section className="space-y-1">
        <h2 className="font-mono text-[18px]">&lt;{name}&gt;</h2>
        <p className="caption text-quiet">{inspection.instance ? `${inspection.instance.file}:${inspection.instance.line}` : `${inspection.file}:${inspection.line}`}</p>
        {inspection.instance && <p className="text-[13px] text-quiet">Renders <span className="font-mono text-ink">&lt;{inspection.element}&gt;</span> from {inspection.file}:{inspection.line}</p>}
        {target?.text && <p className="line-clamp-2 text-[13px] text-quiet">&quot;{target.text}&quot;</p>}
      </section>

      {inspection.component && !inspection.instanceOf && (
        <p className="text-[13px] text-quiet">Inside <span className="font-mono text-ink">{inspection.component.name}</span>, used {inspection.component.uses}× in this repo. A change here shows everywhere {inspection.component.name} is used.</p>
      )}

      {inspection.style && <PropertyPanel style={inspection.style} options={inspection.options} component={inspection.instanceOf} busy={busy} onEdit={onEdit} />}

      {/* Code stays out of the way unless someone asks to see it. */}
      <details>
        <summary className="caption cursor-pointer text-quiet">Code details</summary>
        <div className="mt-3 space-y-5">
          {inspection.instanceOf && (
            <p className="font-mono text-[12px]">{inspection.instanceOf.name} is defined in {inspection.instanceOf.source.file}:{inspection.instanceOf.source.line}</p>
          )}

          {inspection.classes.length > 0 && (
            <section className="space-y-2">
              <h3 className="caption text-quiet">Classes</h3>
              <div className="flex flex-wrap gap-1">
                {inspection.classes.map((c, i) => <span key={`${c}-${i}`} className="rounded-[4px] bg-wash px-1.5 font-mono text-[12px]">{c}</span>)}
              </div>
            </section>
          )}

          {inspection.parents.length > 0 && (
            <section className="space-y-1">
              <h3 className="caption text-quiet">Inside</h3>
              <p className="font-mono text-[12px] leading-relaxed">
                {inspection.parents.slice().reverse().map((p) => `<${p.tag}${p.props ? ` ${p.props}` : ''}>`).join(' › ')}
              </p>
            </section>
          )}

          <section className="space-y-2">
            <h3 className="caption text-quiet">Source</h3>
            <pre className="code !p-3 !text-[11.5px]">
              {inspection.source.map((l) => (
                <div key={l.line} className={l.line === (inspection.instance?.line ?? inspection.line) ? '-mx-3 bg-tint px-3' : undefined}>
                  <span className="inline-block w-7 select-none text-quiet">{l.line}</span>{l.text}
                </div>
              ))}
            </pre>
          </section>
        </div>
      </details>
    </>
  );
}

function PendingChange({ session, onSettle }: { session: Session; onSettle: (action: 'keep' | 'undo') => void }) {
  const pending = session.pending!;
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="caption text-quiet">Change applied to the preview</h2>
        <p className="text-[15px]">{pending.instruction}</p>
      </div>
      {/* A change made with a control keeps its code out of the way until someone asks to see it. */}
      <details open={pending.kind === 'ask'} className="space-y-3">
        <summary className="caption cursor-pointer text-quiet">Code change in {pending.changes.length === 1 ? pending.changes[0]!.file : `${pending.changes.length} files`}</summary>
        {pending.changes.map((change) => (
          <div key={change.file} className="mt-2 space-y-1">
            <p className="font-mono text-[12px]">{change.file}</p>
            <pre className="code !p-0 !text-[11.5px]">
              {diffLines(change.before, change.after).map((l, i) => (
                <div key={i} className={l.kind === '+' ? 'bg-mint px-3' : l.kind === '-' ? 'bg-red-100 px-3 text-quiet line-through' : 'px-3'}>
                  <span className="inline-block w-3 select-none">{l.kind}</span>{l.text}
                </div>
              ))}
            </pre>
          </div>
        ))}
      </details>
      <div className="flex gap-2">
        <button type="button" className="btn-primary !px-4 !py-2 !text-[14px]" onClick={() => onSettle('keep')}><Check size={14} /> Keep</button>
        <button type="button" className="btn-secondary" onClick={() => onSettle('undo')}><Undo2 size={14} /> Undo</button>
      </div>
      <p className="caption flex items-center gap-1.5 text-quiet"><X size={11} /> Not committed until you keep it</p>
    </section>
  );
}
