import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Project } from 'ts-morph';
import type { CatalogueReference } from '../catalogue/client';
import type { RepoIndex } from '../edit/index';
import type { EditOperation } from '../edit/operations';
import type { ScopeConfirmation } from '../edit/scope';
import { projectPath } from '../extract/project';

/** How long a person has to confirm. After this the saved operations are dropped and the change has to be asked for again. */
export const PROPOSAL_TTL_MS = 10 * 60 * 1000;

/** What a shared-component change reaches, from the extracted usage and render graph. Paths are relative to the app. */
export interface SharedImpact {
  /** Component ID, `file:line` of its declaration. */
  allow: string;
  component: string;
  file: string;
  line: number;
  /** JSX sites that render the component, across the repo. */
  uses: number;
  /** Where it is rendered. Extraction keeps a bounded list, so `moreSites` counts the ones not listed. */
  sites: Array<{ file: string; line: number }>;
  moreSites: number;
  /** Routes whose page or layouts render the component, directly or through other components. */
  routes: Array<{ pattern: string; page: string }>;
}

export function describeImpact(index: RepoIndex, confirm: ScopeConfirmation[]): SharedImpact[] {
  return confirm.map((c) => {
    const usage = index.profile.usage.components.find((u) => `${u.file}:${u.line}` === c.allow);
    const sites = (usage?.sites ?? []).map(({ file, line }) => ({ file, line }));
    return {
      allow: c.allow, component: c.component, file: c.file, line: c.line, uses: c.uses,
      sites, moreSites: Math.max(0, c.uses - sites.length),
      routes: index.routes.filter((route) => route.components.includes(c.allow)).map(({ pattern, page }) => ({ pattern, page })),
    };
  });
}

/**
 * A hash of every project source file as the editor holds it. A saved proposal is only valid while this is unchanged,
 * which covers the selection's file, the shared definition, and every consumer, whoever edited them.
 */
export function snapshotHash(project: Project, root: string, repositoryRoot = root): string {
  const hash = createHash('sha256');
  const files = project.getSourceFiles()
    .flatMap((sf) => { const file = projectPath(root, sf.getFilePath()); return file ? [{ file, text: sf.getFullText() }] : []; })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const { file, text } of files) hash.update(`${file}\0${text.length}\0${text}\0`);
  const skip = new Set(['node_modules', '.git', '.next', '.next-neat', '.neat', 'dist', 'out', 'coverage', '.turbo']);
  const config = /^(package\.json|(?:ts|js)config[^/]*\.json|(?:next|postcss|tailwind)\.config\.[^/]+|(?:bun|pnpm|package)[-.]lock(?:\.[^/]+)?|bun\.lockb|yarn\.lock|pnpm-workspace\.yaml)$/;
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (!skip.has(entry.name)) visit(path); }
      else if (entry.isFile() && config.test(entry.name)) {
        const name = relative(repositoryRoot, path);
        const bytes = readFileSync(path);
        hash.update(`${name}\0${bytes.length}\0`).update(bytes).update('\0');
      }
    }
  };
  visit(repositoryRoot);
  return hash.digest('hex');
}

/** A saved wide change. Immutable once created: confirming replays exactly this and nothing else. */
export interface Proposal {
  readonly id: string;
  readonly kind: 'ask' | 'direct';
  /** The selection the change was asked for. */
  readonly tag: string;
  readonly instruction: string;
  readonly label?: string;
  readonly reference?: CatalogueReference;
  /** The exact operations: the model's for an Ask, the control's for a direct edit. */
  readonly operations: readonly EditOperation[];
  /** The shared components to allow when replaying, and no others. */
  readonly confirm: readonly ScopeConfirmation[];
  readonly impact: readonly SharedImpact[];
  readonly snapshot: string;
  readonly expiresAt: number;
}

export type ProposalView = Pick<Proposal, 'id' | 'kind' | 'tag' | 'instruction' | 'expiresAt'> & { components: readonly SharedImpact[] };

/** The part of a proposal the browser sees. The operations stay on the server. */
export const proposalView = (p: Proposal): ProposalView => ({ id: p.id, kind: p.kind, tag: p.tag, instruction: p.instruction, expiresAt: p.expiresAt, components: p.impact });

export type TakeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'unknown' | 'expired' | 'stale' };

export type NewProposal = Omit<Proposal, 'id' | 'expiresAt'>;

/** One session's saved proposal. A new one replaces the old one, and any mutation of the code clears it. */
export class ProposalStore {
  private current: Proposal | undefined;

  constructor(private readonly clock: () => number = Date.now, private readonly ttlMs: number = PROPOSAL_TTL_MS) {}

  create(input: NewProposal): Proposal {
    const proposal: Proposal = Object.freeze({
      ...input,
      operations: Object.freeze(structuredClone([...input.operations])),
      confirm: Object.freeze(input.confirm.map((c) => Object.freeze({ ...c }))),
      impact: Object.freeze(structuredClone([...input.impact])),
      id: randomBytes(16).toString('hex'),
      expiresAt: this.clock() + this.ttlMs,
    });
    this.current = proposal;
    return proposal;
  }

  /**
   * Use the proposal once. It is spent whether or not it is still good: a stale or expired one is gone, and the
   * change has to be asked for again. `snapshot` is the hash of the code as it is right now.
   */
  take(id: string, snapshot: string): TakeResult {
    const proposal = this.current;
    if (!proposal || proposal.id !== id) return { ok: false, reason: 'unknown' };
    this.current = undefined;
    if (this.clock() >= proposal.expiresAt) return { ok: false, reason: 'expired' };
    if (proposal.snapshot !== snapshot) return { ok: false, reason: 'stale' };
    return { ok: true, proposal };
  }

  /** The saved proposal if it is still within its lifetime. */
  peek(): Proposal | undefined {
    return this.current && this.clock() < this.current.expiresAt ? this.current : undefined;
  }

  /** Drop the proposal without writing anything. True when it was the saved one. */
  cancel(id: string): boolean {
    if (this.current?.id !== id) return false;
    this.current = undefined;
    return true;
  }

  /** The code changed some other way, so the proposal no longer describes it. */
  clear() { this.current = undefined; }
}
