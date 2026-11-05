import { Node, SyntaxKind, type Project, type SourceFile } from 'ts-morph';
import type { ComponentInfo } from '../extract/types';
import { resolveComponentTag } from '../extract/usage';
import { componentAt, findJsxAt, type ComponentCard, type JsxOpening, type RepoIndex } from './index';

/**
 * What an edit may touch. The selected element and everything inside it are in scope; so is inserting right before or
 * after it. Anything else needs an entry in `allow`, which only an explicit confirmation should add.
 */
export interface EditScope {
  /** Source tag of the selected element, such as app/page.tsx:12:7. */
  selection: string;
  /** Confirmed wider targets: a project file path, or a component ID (`file:line`) for that component's definition. */
  allow?: string[];
}

/** What a caller needs to ask for confirmation, then retry with `allow` in the scope. */
export interface ScopeConfirmation {
  /** The value to add to `EditScope.allow`. */
  allow: string;
  component: string;
  file: string;
  line: number;
  /** JSX sites that render the component, so the question can say how much changes. */
  uses: number;
}

export interface ScopeViolation {
  code: 'out-of-scope' | 'needs-confirmation';
  message: string;
  confirm?: ScopeConfirmation;
}

/** The distinct shared components a failed attempt needs confirmed. */
export function confirmations(errors: Array<{ confirm?: ScopeConfirmation }>): ScopeConfirmation[] {
  const byAllow = new Map(errors.flatMap((e) => (e.confirm ? [[e.confirm.allow, e.confirm] as const] : [])));
  return [...byAllow.values()];
}

export interface ResolvedScope {
  selection: string;
  file: string;
  start: number;
  end: number;
  /** IDs of the components the selection renders, directly or through other components. */
  rendered: Set<string>;
  allow: Set<string>;
}

/** Find the selection in the current code and what it renders. Null when no element starts at the selection's tag. */
export function resolveScope(project: Project, root: string, index: RepoIndex, scope: EditScope): ResolvedScope | null {
  const found = findJsxAt(project, root, scope.selection);
  if (!found) return null;
  const element = Node.isJsxOpeningElement(found.opening) ? found.opening.getParentOrThrow() : found.opening;
  const components = index.profile.components;
  const byLocation = new Map(components.map((c) => [`${c.file}:${c.line}`, c]));
  const byName = new Map<string, ComponentInfo[]>();
  for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  const rendered = new Set<string>();
  const queue: string[] = [];
  const openings: JsxOpening[] = [found.opening, ...element.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...element.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];
  for (const opening of openings) {
    const tagNode = opening.getTagNameNode();
    if (!/^[A-Z]/.test(tagNode.getText())) continue;
    const target = resolveComponentTag(tagNode, root, byLocation, byName);
    if (target) queue.push(`${target.file}:${target.line}`);
  }
  while (queue.length) {
    const id = queue.shift()!;
    if (rendered.has(id)) continue;
    rendered.add(id);
    queue.push(...(index.renders[id] ?? []));
  }
  return { selection: scope.selection, file: found.file, start: element.getStart(), end: element.getEnd(), rendered, allow: new Set(scope.allow ?? []) };
}

/** A definition is shared when it or any rendering ancestor appears in several places or routes. */
export function isShared(index: RepoIndex, card: ComponentCard): boolean {
  const seen = new Set<string>();
  const queue = [card.id];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const current = index.components.find(c => c.id === id);
    if (index.repeated.includes(id) || (current?.uses ?? 0) > 1 || index.routes.filter(route => route.components.includes(id)).length > 1) return true;
    for (const [owner, rendered] of Object.entries(index.renders)) {
      if (rendered.includes(id)) queue.push(owner);
    }
  }
  return false;
}

function sharedViolation(scope: ResolvedScope, card: ComponentCard): ScopeViolation {
  const uses = card.uses === 1 ? 'once' : `${card.uses} times`;
  return {
    code: 'needs-confirmation',
    message: `That target is in the definition of ${card.name} (${card.id}), which is used ${uses} in this repo. Changing it changes every use, so the person has to confirm it first. Change only the selected element (${scope.selection}) and what is inside it, for example with a prop or a class on the instance.`,
    confirm: { allow: card.id, component: card.name, file: card.source.file, line: card.source.line, uses: card.uses },
  };
}

/**
 * Why an operation's target is outside the scope, or null when it is inside. A target in the definition of a component
 * the selection renders is a wider change that a person can confirm; every other outside target is refused outright.
 * A target inside the selection still needs confirmation when the selection sits in a shared component's own definition,
 * which is what a click on a component's markup selects when the page gives no instance to point at.
 */
export function scopeViolation(index: RepoIndex, scope: ResolvedScope, target: { sf: SourceFile; file: string; opening: JsxOpening }): ScopeViolation | null {
  const at = target.opening.getStart();
  if (scope.allow.has(target.file)) return null;
  const card = componentAt(index, target.sf, target.file, at);
  if (target.file === scope.file && at >= scope.start && at < scope.end) {
    return card && !scope.allow.has(card.id) && isShared(index, card) ? sharedViolation(scope, card) : null;
  }
  if (card && scope.allow.has(card.id)) return null;
  if (card && scope.rendered.has(card.id)) return sharedViolation(scope, card);
  return {
    code: 'out-of-scope',
    message: `That target is outside the selected element (${scope.selection}). Only the selected element and the elements inside it can change.`,
  };
}
