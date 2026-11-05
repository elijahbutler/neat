'use client';

import { Check, Loader2, Monitor, MousePointer2, Smartphone, Square, Tablet, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { PanelOptions } from '../../edit/classes';
import type { ProposalView } from '../../worker/confirmation';
import type { BaseChoices, DeliveryView, GithubState } from '../../worker/delivery';
import type { EditOperation } from '../../edit/operations';
import type { StyleSource } from '../../edit/properties';
import { moveTarget, patchLines, targetTags, textEditTracker, textOperation, type SelectedTarget } from './direct';
import { PropertyPanel } from './PropertyPanel';

interface FileChange { file: string; before: string; after: string }
interface Check { name: 'syntax' | 'typecheck' | 'imports' | 'variants' | 'lint' | 'render'; status: 'passed' | 'not-run' }
interface Step {
  id: string;
  number: number;
  source: 'ask' | 'direct';
  summary: string;
  files: string[];
  status: 'kept' | 'undone';
  patch: string;
  checks: Check[];
  commit: string | null;
  /** The newest step still in the history. Undoing it leaves no trace. */
  latest: boolean;
}
interface Session {
  id: string;
  fixture: string;
  state: 'starting' | 'ready' | 'stopped' | 'failed';
  previewUrl: string;
  pass?: { id: string; base: string; durable: boolean };
  pending: { kind: 'ask' | 'direct'; instruction: string; changes: FileChange[]; checks: Check[] } | null;
  timeline: Step[];
  /** A shared-component change waiting for the person to confirm or cancel it. */
  proposal: ProposalView | null;
  /** What a restart found: steps put back, saved files skipped, and the first step that could not come back. */
  recovery: { restored: number; skipped: number; failure: { summary: string; reason: string } | null } | null;
  /** Branches, patch files, and the pull request made from this pass. Comes back after a browser reload. */
  delivery: DeliveryView | null;
}
/** Keep and Undo answer with the session plus where the tags the page holds now point (null when they can't be followed). */
type Settled = Session & { nextTag: string | null; moved: Record<string, string | null> };
type Target = SelectedTarget;
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
  if (!res.ok && data.error) throw Object.assign(new Error(data.error), { code: (data as { code?: string }).code });
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
  const [target, setTargetState] = useState<Target | null>(null);
  // Callbacks that outlive a render read the selection from here, so they always follow the newest tags.
  const targetRef = useRef<Target | null>(null);
  const inspectionRequest = useRef(0);
  const setTarget = useCallback((next: Target | null) => { inspectionRequest.current++; targetRef.current = next; setTargetState(next); }, []);
  const [recoveryShown, setRecoveryShown] = useState(true);
  const [undoing, setUndoing] = useState<string | null>(null);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [instruction, setInstruction] = useState('');
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  // The shared-component change waiting for a decision, whether it is being confirmed, and why the last try failed.
  const [proposal, setProposal] = useState<ProposalView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  // What a direct edit did or why it didn't happen. Shown above the inspector.
  const [notice, setNotice] = useState<string | null>(null);
  // The page element being typed in (`key`, as the preview knows it) and the source tag its text is written at.
  const [textEdit] = useState(textEditTracker);
  const [mutating, setMutating] = useState(false);
  const mutationActive = useRef(false);
  const [started, setStarted] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const frame = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    api<{ fixtures: string[]; model: string; modelReady: boolean; modelSetupNote: string }>('fixtures')
      .then((d) => { setFixtures(d.fixtures); setFixture(d.fixtures[0] ?? ''); setModel({ name: d.model, ready: d.modelReady, setupNote: d.modelSetupNote }); })
      .catch((e: Error) => setError(e.message));
    api<{ sessions: Session[] }>('sessions').then(d => { if (d.sessions[0]) { setSession(d.sessions[0]); setProposal(d.sessions[0].proposal); } }).catch((e: Error) => setError(e.message));
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

  const beginChange = useCallback(() => {
    if (mutationActive.current) return false;
    mutationActive.current = true;
    setMutating(true);
    textEdit.ask();
    post({ type: 'neat:busy', busy: true });
    return true;
  }, [post, textEdit]);

  const endChange = useCallback(() => {
    mutationActive.current = false;
    setMutating(false);
    post({ type: 'neat:busy', busy: false });
  }, [post]);

  const inspect = useCallback(async (tag: string, at: string, ancestors: Target['ancestors']) => {
    if (!session) return;
    const ticket = ++inspectionRequest.current;
    try {
      const next = await api<Inspection>(`sessions/${session.id}/inspect`, { body: { tag, route: at, ancestors } });
      if (ticket === inspectionRequest.current) setInspection(next);
    } catch (e) { if (ticket === inspectionRequest.current) { setInspection(null); setAskError((e as Error).message); } }
  }, [session]);

  /** Send operations from a control to the worker. They apply without the model and wait for Keep or Undo. */
  const directEdit = useCallback(async (tag: string, operations: EditOperation[], label?: string): Promise<boolean> => {
    if (!session || !beginChange()) return false;
    try {
      const held = targetRef.current;
      const res = await api<{ ok: boolean; session?: Session; message?: string; moved?: Record<string, string | null>; proposal?: ProposalView | null }>(`sessions/${session.id}/edit`, { body: { tag, operations, label, tags: held ? targetTags(held) : [] } });
      if (res.proposal) { setProposal(res.proposal); setProposalError(null); setNotice(null); return false; }
      if (!res.ok || !res.session) { setNotice(res.message ?? "That change couldn't be made."); return false; }
      // The change can move lines and columns. The selection follows its element, so the panel is back on the same
      // element once the change is kept or undone, and the next tweak targets the right place.
      setNotice(null); setSession(res.session); setProposal(res.session.proposal);
      if (held) followSelection(held, res.moved);
      return true;
    } catch (e) { setNotice((e as Error).message); return false; }
    finally { endChange(); }
  }, [session, setTarget, post, inspect, route, beginChange, endChange]);

  useEffect(() => {
    if (!session) return;
    const origin = new URL(session.previewUrl).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || !e.data || typeof e.data.type !== 'string') return;
      if ((e.data.type === 'neat:text-request' || e.data.type === 'neat:select') && mutationActive.current) return;
      if (e.data.type === 'neat:text-request') {
        const t = e.data.target as Target;
        const key = t.inst ?? t.src;
        if (!key) return;
        if (session.pending) { setNotice('Keep or undo the last change first.'); return; }
        if (proposal) { setNotice('Confirm or cancel the shared change first.'); return; }
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
      if (e.data.type === 'neat:deselect') { inspectionRequest.current++; setTarget(null); setInspection(null); }
      if (e.data.type === 'neat:select') {
        const t = e.data.target as Target;
        setTarget(t);
        setInspection(null);
        setAskError(null);
        setNotice(null);
        // A component's instance tag points at where it's used, which is what an edit should change.
        const tag = t.inst ?? t.src;
        if (tag) void inspect(tag, e.data.route, t.ancestors);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [session, selecting, inspect, post, directEdit, textEdit, proposal]);

  useEffect(() => { post({ type: 'neat:mode', selecting }); }, [selecting, post]);

  async function start() {
    setError(null); setLogs(null); setTarget(null); setInspection(null); setNotice(null); setRecoveryShown(true); setProposal(null); setProposalError(null); setConfirming(false); setAskError(null);
    try { const opened = await api<Session>('sessions', { body: { fixture } }); setSession(opened); setProposal(opened.proposal); }
    catch (e) { setError((e as Error).message); }
  }

  async function stop() {
    if (!session) return;
    await api(`sessions/${session.id}`, { method: 'DELETE' }).catch(() => undefined);
    setSession(null); setTarget(null); setInspection(null); setProposal(null); setProposalError(null); setConfirming(false); setAskError(null);
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!session || !inspection || !instruction.trim() || asking || proposal) return;
    const held = targetRef.current;
    if (!beginChange()) return;
    setAsking(true); setAskError(null); setProposalError(null); setStarted(Date.now());
    try {
      const res = await api<{ ok: boolean; session?: Session; errors?: string[]; confirm?: Array<{ component: string; uses: number }>; proposal?: ProposalView | null; moved?: Record<string, string | null> }>(`sessions/${session.id}/ask`, { body: { tag: inspection.instance?.tag ?? inspection.tag, route, instruction, tags: held ? targetTags(held) : [] } });
      if (res.proposal) setProposal(res.proposal);
      else if (res.confirm?.length) setAskError(`That change needs ${res.confirm[0]!.component}, which is shared, along with other parts outside this element. Ask for a change to this element only.`);
      else if (!res.ok || !res.session) setAskError(`Couldn't make that change. ${res.errors?.at(-1) ?? ''}`);
      else {
        setSession(res.session); setProposal(res.session.proposal); setInstruction('');
        // The element stays selected, at the tag it has now, the way it does after a direct edit.
        followSelection(held, res.moved);
      }
    } catch (err) { setAskError((err as Error).message); }
    finally { setAsking(false); setStarted(null); endChange(); }
  }

  /** Make the saved change. The worker replays what it saved, so the model is not asked again. */
  async function confirmShared() {
    if (!session || !proposal || confirming) return;
    const held = targetRef.current;
    if (!beginChange()) return;
    setConfirming(true); setProposalError(null);
    try {
      const res = await api<{ ok: boolean; session?: Session; message?: string; errors?: string[]; moved?: Record<string, string | null> }>(`sessions/${session.id}/confirm`, { body: { proposalId: proposal.id, allowSharedComponent: true, tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      if (!res.ok || !res.session) { setProposal(null); setAskError(res.message ?? `Couldn't make that change. ${res.errors?.at(-1) ?? ''}`); return; }
      const kind = proposal.kind;
      setSession(res.session); setProposal(null); setNotice(null);
      if (kind === 'ask') setInstruction('');
      followSelection(held, res.moved);
    } catch (err) {
      const code = (err as { code?: string }).code;
      // A proposal that timed out, went stale, or is gone can't be confirmed again. Anything else can be retried.
      if (code === 'STALE_PROPOSAL' || code === 'EXPIRED_PROPOSAL' || code === 'UNKNOWN_PROPOSAL') { setProposal(null); setAskError((err as Error).message); }
      else setProposalError((err as Error).message);
    } finally { setConfirming(false); endChange(); }
  }

  /** Drop the saved change. Nothing was written, so there is nothing to undo. */
  async function cancelShared() {
    if (!session || !proposal || confirming) return;
    setConfirming(true); setProposalError(null);
    try {
      await api(`sessions/${session.id}/cancel`, { body: { proposalId: proposal.id } });
      setProposal(null);
    } catch (err) { setProposalError((err as Error).message); }
    finally { setConfirming(false); }
  }

  /** Reselect the element after a change, at the tag it now has. Without one the selection is cleared. */
  function followSelection(held: Target | null, moved: Record<string, string | null> | undefined) {
    const next = held && moved ? moveTarget(held, moved) : null;
    const tag = next && (next.inst ?? next.src);
    if (!next || !tag) {
      inspectionRequest.current++; setInspection(null); setTarget(null); post({ type: 'neat:clear' });
      if (held) setNotice("The element you had selected moved and couldn't be followed. Click it again.");
      return;
    }
    setTarget(next);
    post({ type: 'neat:reselect', tag });
    void inspect(tag, route, next.ancestors);
  }

  async function settle(action: 'keep' | 'undo') {
    if (!session) return;
    const held = targetRef.current;
    if (!beginChange()) return;
    try {
      const done = await api<Settled>(`sessions/${session.id}/${action}`, { body: { tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      setSession(done);
      // The same element stays selected, read again so the controls show the code as it is now.
      if (held) followSelection(held, done.moved);
      else { setInspection(null); setTarget(null); post({ type: 'neat:clear' }); }
    }
    catch (e) { setAskError((e as Error).message); }
    finally { endChange(); }
  }

  /** Take one kept step back. The server says no when later steps depend on it, and the notice says why. */
  async function undoStep(step: Step) {
    if (!session || undoing) return;
    const held = targetRef.current;
    if (!beginChange()) return;
    setUndoing(step.id); setNotice(null);
    try {
      const done = await api<Settled>(`sessions/${session.id}/undo`, { body: { step: step.id, tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      setSession(done);
      if (held) followSelection(held, done.moved);
    } catch (e) { setNotice((e as Error).message); }
    finally { setUndoing(null); endChange(); }
  }

  const frameWidth = WIDTHS[width];

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page text-ink">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-ink px-4 py-2 lg:h-12 lg:flex-nowrap lg:gap-4 lg:py-0">
        <span className="display text-[22px] leading-none">Neat Labs</span>
        <span className="caption hidden text-quiet sm:inline">Editor · local</span>
        {session && (
          <>
            <span className="caption max-w-40 truncate rounded-full border border-ink px-2.5" title={session.fixture}>{session.fixture.split(/[/\\]/).filter(Boolean).at(-1)}</span>
            <form
              className="order-last flex min-w-0 flex-1 basis-full items-center lg:order-none lg:basis-auto"
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
            <button type="button" className="btn-secondary !py-1 !text-[13px]" disabled={mutating} onClick={stop}>
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
        <div className="flex min-h-0 flex-1 flex-col overflow-auto lg:flex-row lg:overflow-hidden">
          <div className="grid-canvas relative flex h-[55svh] min-w-0 shrink-0 justify-center overflow-auto p-4 lg:h-auto lg:flex-1">
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

          <aside className="flex w-full shrink-0 flex-col border-t border-ink lg:w-[380px] lg:border-t-0 lg:border-l" aria-label="Inspector">
            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              {session.recovery && recoveryShown && <RecoveryNotice recovery={session.recovery} onDismiss={() => setRecoveryShown(false)} />}
              {session.pass && !session.pass.durable && <p role="status" className="text-[13px] text-quiet">This preview keeps edits for this session only. Use the default local preview to save passes and deliver branches.</p>}
              {notice && <p role="status" className="rounded-[6px] border border-rule bg-wash p-3 text-[13px] leading-snug">{notice}</p>}
              {session.pending && <PendingChange session={session} busy={mutating} onSettle={settle} />}
              {proposal ? (
                <ConfirmShared proposal={proposal} busy={confirming} error={proposalError} onConfirm={confirmShared} onCancel={cancelShared} />
              ) : inspection ? (
                <InspectorPanel inspection={inspection} target={target} busy={mutating || !!session.pending} onEdit={(operations, label) => { if (inspection.style) void directEdit(inspection.style.target, operations, label); }} />
              ) : (
                <p className="text-[15px] text-quiet">{session.state === 'ready' ? 'Click anything on the page to see which component and line it comes from. Double-click text to edit it.' : 'The inspector fills in once the preview is running.'}</p>
              )}
              {session.pass?.durable && session.timeline.some((step) => step.status === 'kept') && (
                <DeliveryPanel session={session} blocked={mutating || !!session.pending || !!proposal} onDelivery={(delivery) => setSession((current) => (current ? { ...current, delivery } : current))} />
              )}
              {session.timeline.length > 0 && <Timeline steps={session.timeline} busy={mutating || !!session.pending || !!proposal} undoing={undoing} onUndo={undoStep} />}
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
                disabled={!inspection || mutating || !!session.pending || !!proposal}
                placeholder={session.pending ? 'Keep or undo the last change first.' : proposal ? 'Confirm or cancel the shared change first.' : 'Make this the main call to action…'}
                className="w-full resize-none rounded-[8px] border border-ink bg-page p-3 text-[14px] placeholder:text-quiet disabled:bg-wash"
              />
              <div className="flex items-center justify-between gap-3">
                <span className="caption text-quiet" aria-live="polite">
                  {asking && started ? `Working · ${((now - started) / 1000).toFixed(1)} s` : model ? model.name : ''}
                </span>
                <button type="submit" className="btn-primary !px-4 !py-2 !text-[14px]" disabled={!inspection || mutating || !instruction.trim() || !!session.pending || !!proposal}>
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

      {inspection.style && <PropertyPanel key={inspection.style.target} style={inspection.style} options={inspection.options} component={inspection.instanceOf} busy={busy} onEdit={onEdit} />}

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

/** The routes and call sites a shared change reaches, and the choice to go ahead or not. Nothing is written until confirmed. */
function ConfirmShared({ proposal, busy, error, onConfirm, onCancel }: { proposal: ProposalView; busy: boolean; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [proposal.id]);
  const names = proposal.components.map((c) => c.component).join(' and ');
  const places = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;
  return (
    <section
      aria-labelledby="shared-title"
      aria-describedby="shared-summary"
      aria-busy={busy}
      onKeyDown={(e) => { if (e.key === 'Escape' && !busy) onCancel(); }}
      className="space-y-4"
    >
      <div className="space-y-1">
        <h2 id="shared-title" ref={heading} tabIndex={-1} className="text-[15px] font-medium outline-offset-4">Change {names} everywhere it is used?</h2>
        <p id="shared-summary" className="text-[13px] leading-snug text-quiet">&ldquo;{proposal.instruction}&rdquo; edits the shared code, so every use below changes. Nothing is written until you confirm.</p>
      </div>
      {proposal.components.map((c) => (
        <div key={c.allow} className="space-y-2">
          <p className="font-mono text-[13px]">&lt;{c.component}&gt; <span className="text-quiet">{c.file}:{c.line} · used in {places(c.uses)}</span></p>
          <div>
            <p className="caption text-quiet">{c.routes.length === 1 ? 'Shown on 1 route' : `Shown on ${c.routes.length} routes`}</p>
            {c.routes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[13px]">
                {c.routes.map((route) => <li key={route.page}><span className="font-mono">{route.pattern}</span> <span className="text-quiet">{route.page}</span></li>)}
              </ul>
            )}
          </div>
          <div>
            <p className="caption text-quiet">Rendered at</p>
            <ul tabIndex={0} aria-label={`Places ${c.component} is rendered`} className="mt-1 max-h-32 space-y-0.5 overflow-y-auto font-mono text-[12px]">
              {c.sites.map((site) => <li key={`${site.file}:${site.line}`}>{site.file}:{site.line}</li>)}
            </ul>
            {c.moreSites > 0 && <p className="text-[12px] text-quiet">and {places(c.moreSites)} more</p>}
          </div>
        </div>
      ))}
      <div className="flex gap-2">
        <button type="button" className="btn-primary !px-4 !py-2 !text-[14px]" disabled={busy} onClick={onConfirm}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Change everywhere
        </button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
      {error && <p role="alert" className="text-[13px] leading-snug text-red-700">{error}</p>}
    </section>
  );
}

function PendingChange({ session, busy, onSettle }: { session: Session; busy: boolean; onSettle: (action: 'keep' | 'undo') => void }) {
  const pending = session.pending!;
  return (
    <section className="space-y-3">
      <div className="space-y-1">
        <h2 className="caption text-quiet">Source updated. Review the preview</h2>
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
        <button type="button" className="btn-primary !px-4 !py-2 !text-[14px]" disabled={busy} onClick={() => onSettle('keep')}><Check size={14} /> Keep</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => onSettle('undo')}><Undo2 size={14} /> Undo</button>
      </div>
      <p className="caption flex items-center gap-1.5 text-quiet"><X size={11} /> Not committed until you keep it</p>
      {pending.checks.length > 0 && <p className="text-[12px] leading-snug text-quiet">{checkSummary(pending.checks)}</p>}
    </section>
  );
}

/** What was checked and what was not. A check the editor has not run is never listed as a pass. */
function checkSummary(checks: Check[]): string {
  const names = (status: Check['status']) => checks.filter((c) => c.status === status).map((c) => c.name).join(', ');
  const passed = names('passed');
  const skipped = names('not-run');
  return [passed && `Checked: ${passed}.`, skipped && `Not run yet: ${skipped}.`].filter(Boolean).join(' ');
}

function RecoveryNotice({ recovery, onDismiss }: { recovery: NonNullable<Session['recovery']>; onDismiss: () => void }) {
  const lines: string[] = [];
  if (recovery.failure?.reason === 'base-missing') lines.push('A saved pass was left alone because the commit it started from is no longer in this repository. This session starts a new pass.');
  else if (recovery.failure) {
    const why = recovery.failure.reason === 'changed' || recovery.failure.reason === 'conflict' ? 'the code it changed is different now' : 'it could not be applied safely';
    const restored = recovery.restored > 0 ? 'Restored the earlier part of your pass.' : 'Your saved pass could not be restored.';
    lines.push(`${restored} "${recovery.failure.summary}" could not be put back because ${why}, so it and the steps after it were left out. The saved pass is still on disk.`);
  }
  else if (recovery.restored > 0) lines.push('Restored your saved pass.');
  if (recovery.skipped > 0) lines.push(`${recovery.skipped} saved pass ${recovery.skipped === 1 ? 'file' : 'files'} could not be read and ${recovery.skipped === 1 ? 'was' : 'were'} skipped.`);
  if (!lines.length) return null;
  return (
    <div role="status" className="flex items-start gap-2 rounded-[6px] border border-rule bg-wash p-3 text-[13px] leading-snug">
      <div className="flex-1 space-y-1">{lines.map((line) => <p key={line}>{line}</p>)}</div>
      <button type="button" className="shrink-0 rounded-full p-0.5 text-quiet hover:text-ink" aria-label="Dismiss" onClick={onDismiss}><X size={14} /></button>
    </div>
  );
}

function Timeline({ steps, busy, undoing, onUndo }: { steps: Step[]; busy: boolean; undoing: string | null; onUndo: (step: Step) => void }) {
  return (
    <section className="space-y-2">
      <h2 className="caption text-quiet">Kept steps</h2>
      {steps.length > 1 && <p className="text-[12px] leading-snug text-quiet">Undo on the newest step removes it. Undo on an earlier step adds a step that reverses it and keeps the work after it. If a later step changed the same lines, nothing is changed and the editor says so.</p>}
      <ol className="space-y-3" aria-label="Kept steps">
        {steps.map((step) => (
          <li key={step.id} className="space-y-1.5 border-b border-rule pb-3 last:border-b-0">
            <div className="flex items-start gap-2">
              <span className="w-4 shrink-0 pt-px font-mono text-[12px] text-quiet">{step.number}</span>
              <div className="min-w-0 flex-1">
                <p className={step.status === 'undone' ? 'text-[13px] text-quiet line-through' : 'text-[13px]'}>{step.summary}</p>
                <p className="caption truncate text-quiet" title={step.files.join(', ')}>{step.status === 'kept' ? 'Kept' : 'Undone'} · {step.files.join(', ')}{step.commit ? ` · ${step.commit}` : ''}</p>
              </div>
              {step.status === 'kept' && (
                <button type="button" className="btn-secondary shrink-0 !px-3 !py-1 !text-[12px]" disabled={busy} aria-label={`Undo step ${step.number}: ${step.summary}`} onClick={() => onUndo(step)}>
                  {undoing === step.id ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Undo
                </button>
              )}
            </div>
            <details className="pl-6">
              <summary className="caption cursor-pointer text-quiet">Code and checks</summary>
              <pre className="code mt-2 !p-0 !text-[11.5px]">
                {patchLines(step.patch).map((l, i) => (
                  <div key={i} className={l.kind === '+' ? 'bg-mint px-3' : l.kind === '-' ? 'bg-red-100 px-3 text-quiet line-through' : l.kind === 'hunk' ? 'bg-wash px-3 text-quiet' : 'px-3'}>
                    <span className="inline-block w-3 select-none">{l.kind === 'hunk' ? '' : l.kind}</span>{l.text}
                  </div>
                ))}
              </pre>
              {step.checks.length > 0 && <p className="mt-2 text-[12px] leading-snug text-quiet">{checkSummary(step.checks)}</p>}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface DeliveryInfo { delivery: DeliveryView | null; suggestedSlug: string; bases: BaseChoices | null; github: GithubState | null }
type DeliveryAnswer = { delivery: DeliveryView; file?: string };

function DeliveryPanel({ session, blocked, onDelivery }: { session: Session; blocked: boolean; onDelivery: (delivery: DeliveryView) => void }) {
  const path = `sessions/${session.id}/delivery`;
  const [info, setInfo] = useState<DeliveryInfo | null>(null);
  const [slug, setSlug] = useState('');
  const [base, setBase] = useState<'pass' | 'head'>('pass');
  const [working, setWorking] = useState<'branch' | 'export' | 'pr' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const delivery = session.delivery;
  const steps = session.timeline.length;

  // Read the checkout and GitHub state again whenever the steps or the delivery change.
  useEffect(() => {
    let current = true;
    api<DeliveryInfo>(path).then((next) => { if (current) { setInfo(next); setSlug((typed) => typed || next.suggestedSlug); } }).catch(() => undefined);
    return () => { current = false; };
  }, [path, steps, delivery?.branch?.name, delivery?.pr?.url]);

  async function send(kind: 'branch' | 'export' | 'pr') {
    setWorking(kind); setError(null);
    try {
      const body = kind === 'branch' ? { slug, base } : kind === 'export' ? { slug } : {};
      const answer = await api<DeliveryAnswer>(`${path}/${kind}`, { method: 'POST', body });
      onDelivery(answer.delivery);
    } catch (e) { setError((e as Error).message); }
    finally { setWorking(null); }
  }

  const idle = working === null && !blocked;
  const advanced = info?.bases?.advanced && info.bases.head;
  const short = (commit: string) => commit.slice(0, 7);
  return (
    <section className="space-y-3" aria-label="Deliver this pass">
      <h2 className="caption text-quiet">Deliver</h2>
      <div className="space-y-2">
        <label htmlFor="delivery-slug" className="caption text-quiet">Branch name</label>
        <div className="flex items-center gap-1">
          <span className="font-mono text-[13px] text-quiet">neat/</span>
          <input id="delivery-slug" value={slug} onChange={(e) => setSlug(e.target.value)} maxLength={48} spellCheck={false} className="min-w-0 flex-1 rounded-[6px] border border-ink bg-page px-2 py-1 font-mono text-[13px]" />
        </div>
        <label htmlFor="delivery-base" className="caption text-quiet">Start from</label>
        <select id="delivery-base" value={base} onChange={(e) => setBase(e.target.value === 'head' ? 'head' : 'pass')} className="w-full rounded-[6px] border border-ink bg-page px-2 py-1 text-[13px]">
          <option value="pass">The commit this pass started from{info?.bases ? ` (${short(info.bases.pass.commit)})` : ''}</option>
          {advanced && info.bases?.head && <option value="head">Your checkout's current commit ({short(info.bases.head.commit)}{info.bases.head.branch ? `, ${info.bases.head.branch}` : ', detached'})</option>}
        </select>
        <p className="text-[12px] leading-snug text-quiet">Your working tree, index, and current branch are not touched.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary !px-4 !py-2 !text-[14px]" disabled={!idle} onClick={() => void send('branch')}>
          {working === 'branch' ? <Loader2 size={14} className="animate-spin" /> : null} Create branch
        </button>
        <button type="button" className="btn-secondary !px-4 !py-2 !text-[14px]" disabled={!idle} onClick={() => void send('export')}>
          {working === 'export' ? <Loader2 size={14} className="animate-spin" /> : null} Export patch
        </button>
      </div>
      {blocked && <p className="text-[12px] leading-snug text-quiet">Keep or undo the change in progress before delivering.</p>}
      <div aria-live="polite" className="space-y-2 text-[13px] leading-snug">
        {error && <p role="alert" className="text-red-700">{error}</p>}
        {delivery?.branch && (
          <p>
            Created <span className="font-mono">{delivery.branch.name}</span> with {delivery.branch.commits} {delivery.branch.commits === 1 ? 'commit' : 'commits'} on {short(delivery.branch.root.commit)}.
            {delivery.branch.name !== delivery.branch.requested ? ` ${delivery.branch.requested} was taken.` : ''}
            {delivery.branch.stale ? ' Steps were kept after this branch was made. Create it again to include them.' : ''}
          </p>
        )}
        {delivery?.exports.map((file) => (
          <p key={file.name}><a className="underline" href={`/api/editor/${path}/exports/${file.name}`} download={file.name}>Download {file.name}</a> <span className="text-quiet">({Math.ceil(file.bytes / 1024)} KB)</span></p>
        ))}
        {delivery?.pr && <p>{delivery.pr.reused ? 'Pull request already open: ' : 'Opened '}<a className="underline" href={delivery.pr.url} target="_blank" rel="noreferrer">{delivery.pr.url}</a></p>}
      </div>
      {delivery?.branch && !delivery.pr && info?.github === 'ready' && (
        <div className="space-y-1">
          <button type="button" className="btn-secondary !px-4 !py-2 !text-[14px]" disabled={!idle || delivery.branch.stale} onClick={() => void send('pr')}>
            {working === 'pr' ? <Loader2 size={14} className="animate-spin" /> : null} Open pull request
          </button>
          <p className="text-[12px] leading-snug text-quiet">Pushes {delivery.branch.name} to origin, then asks GitHub to open a pull request.</p>
        </div>
      )}
    </section>
  );
}
