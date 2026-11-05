'use client';

import { Check, ChevronRight, Hand, Loader2, Monitor, MousePointer2, RefreshCw, Smartphone, Square, Tablet, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { PanelOptions } from '../../edit/classes';
import type { ProposalView } from '../../worker/confirmation';
import type { BaseChoices, DeliveryView, GithubState } from '../../worker/delivery';
import type { EditOperation } from '../../edit/operations';
import type { StyleSource } from '../../edit/properties';
import type { StartupState } from '../../worker/startup';
import { moveTarget, patchLines, targetTags, textEditTracker, textOperation, type SelectedTarget } from './direct';
import { PropertyPanel } from './PropertyPanel';
import { InspectorTabs, type InspectorTab } from './InspectorTabs';

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

const startupSchema: z.ZodType<StartupState> = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('idle') }),
  z.object({ phase: z.enum(['preparing', 'dependencies', 'restoring', 'starting', 'ready']), startedAt: z.string() }),
  z.object({ phase: z.literal('failed'), startedAt: z.string(), error: z.string() }),
]);

function startupLabel(state: StartupState | null): string {
  if (!state) return 'Connecting to the local editor';
  switch (state.phase) {
    case 'idle': return 'Ready to open a project';
    case 'preparing': return 'Preparing your preview';
    case 'dependencies': return 'Preparing project dependencies';
    case 'restoring': return 'Restoring your saved pass';
    case 'starting': return 'Starting your app';
    case 'ready': return 'Connecting to your preview';
    case 'failed': return 'The preview could not start';
    default: { const exhaustive: never = state; return exhaustive; }
  }
}

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
  const [activeTab, setActiveTab] = useState<InspectorTab>('edit');
  const [startup, setStartup] = useState<StartupState | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [bridge, setBridge] = useState<'connecting' | 'ready' | 'timeout'>('connecting');
  const bridgeReady = useRef(false);
  const awaitingFrameLoad = useRef(false);
  const [frameLoad, setFrameLoad] = useState(0);
  const [frameRevision, setFrameRevision] = useState(0);
  const [frameSource, setFrameSource] = useState<string | null>(null);
  const activeRoute = useRef<string | null>(null);
  const previewLocation = useRef('/');
  const [route, setRoute] = useState('/');
  const [target, setTargetState] = useState<Target | null>(null);
  // Callbacks that outlive a render read the selection from here, so they always follow the newest tags.
  const targetRef = useRef<Target | null>(null);
  const inspectionRequest = useRef(0);
  const confirmedReselection = useRef<string | null>(null);
  const setTarget = useCallback((next: Target | null) => { inspectionRequest.current++; confirmedReselection.current = null; targetRef.current = next; setTargetState(next); }, []);
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
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<Session>(`sessions/${session.id}`);
        if (!current) return;
        setSession(next);
      } catch (e) { if (current) setError((e as Error).message); }
      if (current) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { current = false; clearTimeout(timer); };
  }, [session?.id, session?.state]);

  useEffect(() => {
    if (session?.state !== 'failed') return;
    let current = true;
    setLogs(null);
    api<{ logs: string }>(`sessions/${session.id}/logs`)
      .then((result) => { if (current) setLogs(result.logs); })
      .catch((error: Error) => { if (current) setError(error.message); });
    return () => { current = false; };
  }, [session?.id, session?.state]);

  useEffect(() => {
    if (!started) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [started]);

  const post = useCallback((message: object) => {
    if (session) frame.current?.contentWindow?.postMessage(message, new URL(session.previewUrl).origin);
  }, [session]);

  // A full iframe load loses the bridge even when the session and pending change survive.
  // Ping for at most twenty seconds. Only neat:ready unlocks the preview.
  useEffect(() => {
    bridgeReady.current = false;
    setBridge('connecting');
    if (session?.state !== 'ready') return;
    let attempts = 0;
    const hello = () => {
      if (bridgeReady.current) { clearInterval(timer); return; }
      if (attempts++ >= 40) { clearInterval(timer); setBridge('timeout'); return; }
      post({ type: 'neat:hello' });
    };
    const timer = setInterval(hello, 500);
    hello();
    return () => clearInterval(timer);
  }, [session?.id, session?.state, frameLoad]);

  useEffect(() => {
    activeRoute.current = null;
    previewLocation.current = '/';
    awaitingFrameLoad.current = false;
    setFrameSource(null);
    setTarget(null);
    setInspection(null);
    setActiveTab('edit');
  }, [session?.id, setTarget]);

  // Startup can begin before a session exists, or continue while its preview reconnects.
  useEffect(() => {
    if (session?.state === 'ready' && bridge === 'ready') return;
    if (!opening && (session?.state === 'stopped' || session?.state === 'failed')) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = startupSchema.safeParse(await api<unknown>('startup'));
        if (current && next.success) setStartup(next.data);
        if (!session) {
          const existing = await api<{ sessions: Session[] }>('sessions');
          const opened = existing.sessions[0];
          if (current && opened) { setSession((held) => held ?? opened); setProposal(opened.proposal); }
        }
      } catch { /* The session request reports connection errors. Keep its progress visible. */ }
      if (current) timer = setTimeout(() => void poll(), 1000);
    };
    void poll();
    return () => { current = false; clearTimeout(timer); };
  }, [session?.id, session?.state, bridge, opening]);

  const beginChange = useCallback(() => {
    if (mutationActive.current) return false;
    mutationActive.current = true;
    confirmedReselection.current = null;
    setMutating(true);
    textEdit.ask();
    post({ type: 'neat:busy', busy: true });
    return true;
  }, [post, textEdit]);

  const endChange = useCallback(() => {
    mutationActive.current = false;
    setMutating(false);
    post({ type: 'neat:busy', busy: false });
    // The iframe can reload while inspection is still refreshing. Rebind once the mutation is settled.
    const tag = confirmedReselection.current;
    if (tag && bridgeReady.current) post({ type: 'neat:reselect', tag });
  }, [post]);

  const inspect = useCallback(async (tag: string, at: string, ancestors: Target['ancestors']) => {
    if (!session) return;
    const ticket = ++inspectionRequest.current;
    try {
      const next = await api<Inspection>(`sessions/${session.id}/inspect`, { body: { tag, route: at, ancestors } });
      if (ticket === inspectionRequest.current) {
        setInspection(next); confirmedReselection.current = tag;
        if (bridgeReady.current && !mutationActive.current) post({ type: 'neat:reselect', tag });
      }
    } catch (e) { if (ticket === inspectionRequest.current) { setInspection(null); setAskError((e as Error).message); } }
  }, [session, post]);

  /** Send operations from a control to the worker. They apply without the model and wait for Keep or Undo. */
  const directEdit = useCallback(async (tag: string, operations: EditOperation[], label?: string): Promise<boolean> => {
    if (!session || !beginChange()) return false;
    try {
      const held = targetRef.current;
      const selectedRoute = activeRoute.current;
      const res = await api<{ ok: boolean; session?: Session; message?: string; moved?: Record<string, string | null>; proposal?: ProposalView | null }>(`sessions/${session.id}/edit`, { body: { tag, operations, label, tags: held ? targetTags(held) : [] } });
      if (res.proposal) { setProposal(res.proposal); setProposalError(null); setNotice(null); return false; }
      if (!res.ok || !res.session) { setNotice(res.message ?? "That change couldn't be made."); return false; }
      // The change can move lines and columns. The selection follows its element, so the panel is back on the same
      // element once the change is kept or undone, and the next tweak targets the right place.
      setNotice(null); setSession(res.session); setProposal(res.session.proposal);
      if (held) await followSelection(held, res.moved, selectedRoute);
      return true;
    } catch (e) { setNotice((e as Error).message); return false; }
    finally { endChange(); }
  }, [session, setTarget, post, inspect, route, beginChange, endChange]);

  useEffect(() => {
    if (!session) return;
    const origin = new URL(session.previewUrl).origin;
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== origin || !e.data || typeof e.data.type !== 'string') return;
      if (awaitingFrameLoad.current && (e.data.type === 'neat:route' || e.data.type === 'neat:ready')) return;
      if ((e.data.type === 'neat:text-request' || e.data.type === 'neat:select') && (mutationActive.current || !bridgeReady.current || !selecting)) return;
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
      if ((e.data.type === 'neat:route' || e.data.type === 'neat:ready') && typeof e.data.route === 'string') {
        if (activeRoute.current !== null && activeRoute.current !== e.data.route) {
          setTarget(null); setInspection(null); textEdit.ask(); post({ type: 'neat:clear' });
        }
        activeRoute.current = e.data.route;
        try {
          const at = new URL(typeof e.data.url === 'string' ? e.data.url : e.data.route, origin);
          if (at.origin === origin) {
            previewLocation.current = at.pathname + at.search + at.hash;
            setRoute(previewLocation.current);
          }
        } catch { /* Ignore malformed locations from the preview. */ }
      }
      if (e.data.type === 'neat:ready') {
        bridgeReady.current = true;
        setBridge('ready');
        post({ type: 'neat:mode', selecting });
        post({ type: 'neat:busy', busy: mutationActive.current });
        // Fast Refresh can reload the whole iframe. Restore only tags confirmed by the worker.
        const tag = confirmedReselection.current;
        if (tag && !mutationActive.current) post({ type: 'neat:reselect', tag });
      }
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

  useEffect(() => {
    if (!bridgeReady.current) return;
    post({ type: 'neat:mode', selecting });
    if (selecting && !mutationActive.current && confirmedReselection.current) post({ type: 'neat:reselect', tag: confirmedReselection.current });
  }, [selecting, post]);

  async function start() {
    if (opening || closing || !session && startup?.phase !== 'idle' && startup?.phase !== 'failed') return;
    setOpening(true);
    setError(null);
    try {
      if (session?.state === 'failed' || session?.state === 'stopped') {
        await api(`sessions/${session.id}`, { method: 'DELETE' });
        setSession(null); setStartup({ phase: 'idle' });
      }
      setLogs(null); setTarget(null); setInspection(null); setNotice(null); setRecoveryShown(true); setProposal(null); setProposalError(null); setConfirming(false); setAskError(null);
      const opened = await api<Session>('sessions', { body: { fixture: session?.fixture ?? fixture } });
      setSession(opened); setProposal(opened.proposal);
    }
    catch (e) { setError((e as Error).message); }
    finally { setOpening(false); }
  }

  async function stop() {
    if (!session || closing || opening || mutationActive.current) return;
    setClosing(true); setError(null);
    try {
      await api(`sessions/${session.id}`, { method: 'DELETE' });
      setSession(null); setStartup({ phase: 'idle' }); setTarget(null); setInspection(null); setProposal(null); setProposalError(null); setConfirming(false); setAskError(null);
    } catch (e) { setError((e as Error).message); }
    finally { setClosing(false); }
  }

  async function ask(e: FormEvent) {
    e.preventDefault();
    if (!session || !inspection || !bridgeReady.current || !instruction.trim() || asking || proposal || session.pending || model?.ready === false) return;
    const held = targetRef.current;
    const selectedRoute = activeRoute.current;
    if (!beginChange()) return;
    setAsking(true); setAskError(null); setProposalError(null); setStarted(Date.now());
    try {
      const res = await api<{ ok: boolean; session?: Session; errors?: string[]; confirm?: Array<{ component: string; uses: number }>; proposal?: ProposalView | null; moved?: Record<string, string | null> }>(`sessions/${session.id}/ask`, { body: { tag: inspection.instance?.tag ?? inspection.tag, route: activeRoute.current ?? route, instruction, tags: held ? targetTags(held) : [] } });
      if (res.proposal) setProposal(res.proposal);
      else if (res.confirm?.length) setAskError(`That change needs ${res.confirm[0]!.component}, which is shared, along with other parts outside this element. Ask for a change to this element only.`);
      else if (!res.ok || !res.session) setAskError(`Couldn't make that change. ${res.errors?.at(-1) ?? ''}`);
      else {
        setSession(res.session); setProposal(res.session.proposal); setInstruction('');
        // The element stays selected, at the tag it has now, the way it does after a direct edit.
        await followSelection(held, res.moved, selectedRoute);
      }
    } catch (err) { setAskError((err as Error).message); }
    finally { setAsking(false); setStarted(null); endChange(); }
  }

  /** Make the saved change. The worker replays what it saved, so the model is not asked again. */
  async function confirmShared() {
    if (!session || !proposal || confirming) return;
    const held = targetRef.current;
    const selectedRoute = activeRoute.current;
    if (!beginChange()) return;
    setConfirming(true); setProposalError(null);
    try {
      const res = await api<{ ok: boolean; session?: Session; message?: string; errors?: string[]; moved?: Record<string, string | null> }>(`sessions/${session.id}/confirm`, { body: { proposalId: proposal.id, allowSharedComponent: true, tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      if (!res.ok || !res.session) { setProposal(null); setAskError(res.message ?? `Couldn't make that change. ${res.errors?.at(-1) ?? ''}`); return; }
      const kind = proposal.kind;
      setSession(res.session); setProposal(null); setNotice(null);
      if (kind === 'ask') setInstruction('');
      await followSelection(held, res.moved, selectedRoute);
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
  async function followSelection(held: Target | null, moved: Record<string, string | null> | undefined, selectedRoute: string | null) {
    if (selectedRoute !== activeRoute.current) return;
    const next = held && moved ? moveTarget(held, moved) : null;
    const tag = next && (next.inst ?? next.src);
    if (!next || !tag) {
      inspectionRequest.current++; setInspection(null); setTarget(null); post({ type: 'neat:clear' });
      if (held) setNotice("The element you had selected moved and couldn't be followed. Click it again.");
      return;
    }
    setTarget(next);
    // Inspection must finish before endChange or neat:ready can replay this tag.
    await inspect(tag, activeRoute.current ?? route, next.ancestors);
  }

  async function settle(action: 'keep' | 'undo') {
    if (!session) return;
    const held = targetRef.current;
    const selectedRoute = activeRoute.current;
    if (!beginChange()) return;
    try {
      const done = await api<Settled>(`sessions/${session.id}/${action}`, { body: { tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      setSession(done);
      // The same element stays selected, read again so the controls show the code as it is now.
      if (held) await followSelection(held, done.moved, selectedRoute);
      else { setInspection(null); setTarget(null); post({ type: 'neat:clear' }); }
    }
    catch (e) { setAskError((e as Error).message); }
    finally { endChange(); }
  }

  /** Take one kept step back. The server says no when later steps depend on it, and the notice says why. */
  async function undoStep(step: Step) {
    if (!session || undoing) return;
    const held = targetRef.current;
    const selectedRoute = activeRoute.current;
    if (!beginChange()) return;
    setUndoing(step.id); setNotice(null);
    try {
      const done = await api<Settled>(`sessions/${session.id}/undo`, { body: { step: step.id, tag: held ? held.inst ?? held.src : undefined, tags: held ? targetTags(held) : [] } });
      setSession(done);
      if (held) await followSelection(held, done.moved, selectedRoute);
    } catch (e) { setNotice((e as Error).message); }
    finally { setUndoing(null); endChange(); }
  }

  const frameWidth = WIDTHS[width];
  const autoStarting = startup !== null && startup.phase !== 'idle' && startup.phase !== 'failed';
  const blocked = mutating || closing || opening || !!session?.pending || !!proposal;
  const editorReady = session?.state === 'ready' && bridge === 'ready';
  const selectedName = inspection ? inspection.instance?.name ?? inspection.instanceOf?.name ?? inspection.element : null;
  const projectName = session?.fixture.split(/[/\\]/).filter(Boolean).at(-1);
  const status = closing ? 'Stopping your preview' : mutating ? asking ? 'Making your change' : confirming ? 'Applying shared change' : 'Saving your change' : session?.pending ? 'Review pending change' : session?.state === 'failed' && !opening ? 'The preview could not start' : !editorReady ? bridge === 'timeout' ? 'Preview connection needs attention' : startupLabel(startup) : selecting ? 'Select an element to edit' : 'Interact with your app';

  function navigatePreview(path: string) {
    if (!session || !frame.current || mutating || closing || opening) return;
    try {
      const destination = new URL(path, session.previewUrl);
      if (destination.origin !== new URL(session.previewUrl).origin) { setNotice('Enter a page path within this preview, such as /about.'); return; }
      previewLocation.current = destination.pathname + destination.search + destination.hash;
      awaitingFrameLoad.current = true;
      bridgeReady.current = false;
      setBridge('connecting');
      setFrameSource(destination.toString());
      setFrameRevision((revision) => revision + 1);
    } catch { setNotice('Enter a valid page path, such as /about.'); }
  }

  function reloadPreview() {
    navigatePreview(previewLocation.current);
  }

  return (
    <div className="editor-workspace fixed inset-0 z-50 flex flex-col bg-page text-ink">
      <header className="workspace-header">
        <a className="sr-only focus:not-sr-only" href="#inspector">Skip to inspector</a>
        <span className="display text-[24px] leading-none">Neat Labs</span>
        <span className="hidden h-5 border-l border-rule sm:block" aria-hidden="true" />
        <h1 className="text-[14px] font-medium">Editor</h1>
        {session && <span className="project-name" title={projectName}>{projectName}</span>}
        <span className="ml-auto hidden text-[12px] text-quiet sm:block">Local workspace</span>
        {session && (
          <button type="button" className="btn-secondary !px-3 !py-1.5 !text-[12px]" disabled={mutating || opening || closing} onClick={() => void stop()}>
            {closing ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <Square size={12} aria-hidden="true" />} Stop
          </button>
        )}
      </header>

      {!session ? (
        <main className="workspace-welcome">
          <div className="w-full max-w-[460px] space-y-6">
            <div className="space-y-3">
              <h2 className="display text-[40px]">{opening || autoStarting ? 'Opening your workspace' : 'Open a project'}</h2>
              <p className="text-[15px] leading-relaxed text-quiet">Edit your app in a local preview. Select an element, adjust its properties, then keep the changes you want.</p>
            </div>
            {opening || autoStarting ? (
              <div className="startup-progress" role="status">
                <Loader2 size={18} className="animate-spin shrink-0" aria-hidden="true" />
                <div><p className="font-medium">{startupLabel(startup)}</p><p className="mt-1 text-[13px] text-quiet">Your workspace will open here when the preview is ready.</p></div>
              </div>
            ) : (
              <>
                <fieldset className="space-y-3" disabled={opening}>
                  <legend className="text-[13px] font-medium">Project</legend>
                  <div className="flex flex-wrap gap-2">
                    {fixtures.map((f) => (
                      <label key={f} className="project-choice">
                        <input type="radio" name="project" value={f} checked={fixture === f} onChange={() => setFixture(f)} />
                        <span>{f.split(/[/\\]/).filter(Boolean).at(-1)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <button type="button" className="btn-primary w-full" onClick={() => void start()} disabled={!fixtures.length || opening || startup === null}>Open preview <ChevronRight size={16} aria-hidden="true" /></button>
                {!fixtures.length && <p className="text-[13px] text-quiet">Loading available projects.</p>}
              </>
            )}
            <p className="text-[13px] leading-relaxed text-quiet">Property and text edits work without a model. Use Ask when you need a larger change.</p>
            {model && !model.ready && <ModelHelp note={model.setupNote} />}
            {(error || startup?.phase === 'failed') && <p role="alert" className="text-[14px] text-red-700">{error ?? (startup?.phase === 'failed' ? startup.error : '')}</p>}
          </div>
        </main>
      ) : (
        <div className="workspace-body">
          <main className="preview-workspace" aria-label="Preview workspace">
            <div className="preview-toolbar">
              <div className="preview-modes" role="group" aria-label="Preview mode">
                <button type="button" aria-pressed={selecting} disabled={!editorReady || mutating} onClick={() => setSelecting(true)}><MousePointer2 size={15} aria-hidden="true" /> Select</button>
                <button type="button" aria-pressed={!selecting} disabled={!editorReady || mutating} onClick={() => setSelecting(false)}><Hand size={15} aria-hidden="true" /> Interact</button>
              </div>
              <div className="preview-widths" role="group" aria-label="Preview width">
                {([['desktop', Monitor], ['tablet', Tablet], ['phone', Smartphone]] as const).map(([key, Icon]) => (
                  <button key={key} type="button" aria-pressed={width === key} aria-label={key} title={key} onClick={() => setWidth(key)}><Icon size={16} aria-hidden="true" /></button>
                ))}
              </div>
              <form className="preview-route" onSubmit={(e) => { e.preventDefault(); navigatePreview(route); }}>
                <label htmlFor="route" className="sr-only">Page</label>
                <input id="route" value={route} onChange={(e) => setRoute(e.target.value)} disabled={session.state !== 'ready' || mutating} spellCheck={false} className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-[12px]" />
                <button type="submit" aria-label="Go to page" title="Go to page" disabled={session.state !== 'ready' || mutating}><ChevronRight size={16} aria-hidden="true" /></button>
              </form>
              <button type="button" className="preview-reload" aria-label="Reload preview" title="Reload preview" disabled={session.state !== 'ready' || mutating} onClick={reloadPreview}><RefreshCw size={15} aria-hidden="true" /></button>
            </div>
            <div className="preview-status" role="status">
              <span className="flex min-w-0 items-center gap-2">{!editorReady || mutating ? <Loader2 size={13} className={bridge === 'timeout' ? 'shrink-0' : 'shrink-0 animate-spin'} aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />} {status}</span>
              <span className="hidden shrink-0 font-mono text-[11px] sm:block">{frameWidth ? `${frameWidth} px` : 'Fit to workspace'}</span>
            </div>
            <div className="preview-stage">
              {session.state === 'ready' ? (
                <div className="preview-frame" style={{ width: frameWidth ?? '100%', minWidth: frameWidth ?? undefined }}>
                  <iframe
                    key={`${session.id}:${frameRevision}`}
                    ref={frame}
                    title={`${projectName} preview`}
                    src={frameSource ?? session.previewUrl}
                    onLoad={() => { awaitingFrameLoad.current = false; bridgeReady.current = false; setBridge('connecting'); setFrameLoad((load) => load + 1); }}
                    className="h-full w-full bg-page"
                    inert={!editorReady || mutating}
                  />
                  {!editorReady && (
                    <div className="preview-connection" role="status">
                      {bridge === 'timeout' ? <RefreshCw size={22} aria-hidden="true" /> : <Loader2 size={22} className="animate-spin" aria-hidden="true" />}
                      <p className="font-medium">{bridge === 'timeout' ? 'The preview has not connected' : 'Connecting to your preview'}</p>
                      <p className="max-w-[32ch] text-[13px] leading-relaxed text-quiet">{bridge === 'timeout' ? 'Reload the preview to reconnect. Your pending change stays in this session.' : 'Selection will be available when your app is ready.'}</p>
                      {bridge === 'timeout' && <button type="button" className="btn-secondary" onClick={reloadPreview}>Reconnect preview</button>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="preview-startup" role="status">
                  {session.state === 'failed' && !opening ? (
                    <div className="w-full max-w-[580px] space-y-4 text-left">
                      <h2 className="text-[18px] font-medium">The preview didn&apos;t start.</h2>
                      {startup?.phase === 'failed' && <p className="text-[13px] leading-relaxed text-red-700">{startup.error}</p>}
                      <details><summary className="cursor-pointer text-[13px]">Startup logs</summary><pre className="code mt-3 max-h-[260px] whitespace-pre-wrap">{logs ?? 'No startup logs are available.'}</pre></details>
                      <button type="button" className="btn-secondary" disabled={opening} onClick={() => void start()}>Try again</button>
                    </div>
                  ) : session.state === 'stopped' ? <p>The preview has stopped. Open the project again to continue.</p> : (
                    <><Loader2 size={24} className="animate-spin" aria-hidden="true" /><h2 className="text-[18px] font-medium">{startupLabel(startup)}</h2><p className="max-w-[34ch] text-[13px] leading-relaxed text-quiet">Your saved work will appear when the preview is ready.</p></>
                  )}
                </div>
              )}
            </div>
          </main>

          <aside id="inspector" tabIndex={-1} className="workspace-inspector" aria-label="Inspector">
            <div className="selection-summary" aria-live="polite">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[12px] font-medium text-quiet">Selected element</span>
                {target && <button type="button" className="rounded p-1 text-quiet hover:bg-wash hover:text-ink" aria-label="Clear selection" disabled={mutating} onClick={() => { setTarget(null); setInspection(null); post({ type: 'neat:clear' }); }}><X size={14} aria-hidden="true" /></button>}
              </div>
              <h2 className="mt-1 truncate font-mono text-[18px]">{selectedName ? `<${selectedName}>` : target ? 'Reading selection' : 'Nothing selected'}</h2>
              <p className="mt-1 text-[12px] leading-relaxed text-quiet">{inspection ? inspection.instance ? 'Scope: this component instance' : inspection.component ? `Scope: shared ${inspection.component.name} source` : 'Scope: this element' : target ? 'Finding its source and available controls.' : selecting ? 'Select an element in the preview to start.' : 'Switch to Select to choose an element.'}</p>
              {inspection && <p className="mt-1 break-all font-mono text-[11px] text-quiet">{inspection.instance ? `${inspection.instance.file}:${inspection.instance.line}` : `${inspection.file}:${inspection.line}`}</p>}
            </div>
            <InspectorTabs active={activeTab} count={session.timeline.length} onChange={setActiveTab} />
            <div className="inspector-content">
              {error && <p role="alert" className="text-[13px] leading-relaxed text-red-700">{error}</p>}
              {session.recovery && recoveryShown && <RecoveryNotice recovery={session.recovery} onDismiss={() => setRecoveryShown(false)} />}
              {session.pass && !session.pass.durable && <p role="status" className="text-[13px] text-quiet">This preview keeps edits for this session only. Use the default local preview to save passes and deliver branches.</p>}
              {notice && <p role="status" className="rounded-[6px] border border-rule bg-wash p-3 text-[13px] leading-snug">{notice}</p>}
              {askError && <p role="alert" className="text-[13px] leading-snug text-red-700">{askError}</p>}
              {proposal && <ConfirmShared proposal={proposal} busy={confirming} error={proposalError} onConfirm={confirmShared} onCancel={cancelShared} />}

              <section id="inspector-panel-edit" role="tabpanel" aria-labelledby="inspector-tab-edit" hidden={activeTab !== 'edit'} tabIndex={0} className="inspector-tabpanel">
                {inspection ? (
                  <InspectorPanel inspection={inspection} target={target} busy={blocked || !editorReady || !selecting} onEdit={(operations, label) => { if (inspection.style) void directEdit(inspection.style.target, operations, label); }} />
                ) : (
                  <div className="inspector-empty">
                    {target ? <Loader2 size={23} className="animate-spin" aria-hidden="true" /> : <MousePointer2 size={23} aria-hidden="true" />}
                    <h3 className="text-[16px] font-medium">{target ? 'Reading element properties' : !editorReady ? 'Waiting for your preview' : selecting ? 'Start with an element' : 'Your app is interactive'}</h3>
                    <p>{target ? 'The inspector is finding the source for this selection.' : !editorReady ? 'The inspector will be available once your app connects.' : selecting ? 'Click an element to adjust spacing, type, and color. Double-click plain text to edit it on the page.' : 'Follow links and use the page normally. Switch to Select when you want to edit.'}</p>
                  </div>
                )}
                <form onSubmit={ask} className="ask-composer">
                  <label htmlFor="ask" className="block text-[13px] font-medium">{inspection ? `Change this ${selectedName}` : 'Select an element to ask for a change'}</label>
                  <textarea
                    id="ask"
                    rows={3}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }}
                    disabled={!inspection || blocked || !editorReady || !selecting || model?.ready === false}
                    placeholder={session.pending ? 'Keep or undo the last change first.' : proposal ? 'Confirm or cancel the shared change first.' : model?.ready === false ? 'Set up a model to use Ask.' : 'Describe what you want to change…'}
                    className="w-full resize-y rounded-[6px] border border-rule bg-page p-3 text-[14px] placeholder:text-quiet disabled:bg-wash"
                  />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-quiet" aria-live="polite">{asking && started ? `Working · ${((now - started) / 1000).toFixed(1)} s` : 'Enter to send · Shift + Enter for a new line'}</span>
                    <button type="submit" className="btn-primary !px-4 !py-2 !text-[13px]" disabled={!inspection || blocked || !editorReady || !selecting || !instruction.trim() || model?.ready === false}>{asking && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Ask</button>
                  </div>
                  {model && !model.ready && <ModelHelp note={model.setupNote} />}
                </form>
              </section>
              <section id="inspector-panel-history" role="tabpanel" aria-labelledby="inspector-tab-history" hidden={activeTab !== 'history'} tabIndex={0} className="inspector-tabpanel">
                {session.timeline.length > 0 ? <Timeline steps={session.timeline} busy={blocked} undoing={undoing} onUndo={undoStep} /> : <div className="inspector-empty"><h2 className="text-[16px] font-medium">No kept steps yet</h2><p>Keep a pending change to save it in this pass. Each saved step includes its code and checks, with an option to undo.</p></div>}
              </section>
              <section id="inspector-panel-deliver" role="tabpanel" aria-labelledby="inspector-tab-deliver" hidden={activeTab !== 'deliver'} tabIndex={0} className="inspector-tabpanel">
                {session.pass?.durable && session.timeline.some((step) => step.status === 'kept') ? (
                  <DeliveryPanel session={session} blocked={blocked} onDelivery={(delivery) => setSession((current) => (current ? { ...current, delivery } : current))} />
                ) : <div className="inspector-empty"><h2 className="text-[16px] font-medium">{session.pass?.durable ? 'Keep a change to deliver' : 'Delivery needs a saved pass'}</h2><p>{session.pass?.durable ? 'Create a branch or download a patch from your kept steps. Review the pending change first.' : 'Use a durable local preview to create branches and export your kept work.'}</p></div>}
              </section>
            </div>
            {session.pending && <div className="pending-bar"><PendingChange session={session} busy={mutating || closing || opening} onSettle={settle} /></div>}
            <div className="inspector-footer"><span>{session.timeline.length} {session.timeline.length === 1 ? 'saved step' : 'saved steps'}</span><span>{session.pending ? '1 pending change' : session.pass?.durable ? 'Pass saved locally' : 'Session only'}</span></div>
          </aside>
        </div>
      )}
    </div>
  );
}

function ModelHelp({ note }: { note: string }) {
  return <details className="model-help"><summary>Set up a model for Ask</summary><p className="mt-2 break-words text-[12px] leading-relaxed text-quiet">{note}</p><p className="mt-2 text-[12px] leading-relaxed text-quiet">You can keep using property controls and edit text directly without a model.</p></details>;
}

function InspectorPanel({ inspection, target, busy, onEdit }: { inspection: Inspection; target: Target | null; busy: boolean; onEdit: (operations: EditOperation[], label: string) => void }) {
  return (
    <>
      {target?.text && <p className="selection-text line-clamp-2 text-[13px] text-quiet">&quot;{target.text}&quot;</p>}
      {inspection.instance && <p className="break-words text-[12px] leading-relaxed text-quiet">Renders <span className="font-mono text-ink">&lt;{inspection.element}&gt;</span> from {inspection.file}:{inspection.line}</p>}

      {inspection.component && !inspection.instanceOf && (
        <p className="scope-notice">Inside <span className="font-mono text-ink">{inspection.component.name}</span>, used {inspection.component.uses}× in this repo. A change here shows everywhere {inspection.component.name} is used.</p>
      )}

      {inspection.style && <PropertyPanel key={inspection.style.target} style={inspection.style} options={inspection.options} component={inspection.instanceOf} busy={busy} onEdit={onEdit} />}

      {/* Code stays out of the way unless someone asks to see it. */}
      <details className="source-details">
        <summary className="cursor-pointer text-[13px] font-medium">Code details</summary>
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
      className="shared-confirmation space-y-4"
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
    <section className="space-y-3" aria-label="Pending change">
      <div className="space-y-1">
        <h2 className="text-[13px] font-semibold">Pending change</h2>
        <p className="line-clamp-2 text-[14px]" title={pending.instruction}>{pending.instruction}</p>
        <p className="text-[12px] text-quiet">Source updated. Review the preview, then keep or undo.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1 !px-4 !py-2 !text-[14px]" disabled={busy} onClick={() => onSettle('keep')}><Check size={14} aria-hidden="true" /> Keep</button>
        <button type="button" className="btn-secondary flex-1" disabled={busy} onClick={() => onSettle('undo')}><Undo2 size={14} aria-hidden="true" /> Undo</button>
      </div>
      {/* A change made with a control keeps its code out of the way until someone asks to see it. */}
      <details open={pending.kind === 'ask'} className="pending-code space-y-3">
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
      <p className="text-[12px] text-quiet">Not committed until you keep it.</p>
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
