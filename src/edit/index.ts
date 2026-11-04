import { Node, SyntaxKind, type JsxOpeningElement, type JsxSelfClosingElement, type Project, type SourceFile } from 'ts-morph';
import { loadProject, projectPath } from '../extract/project';
import type { ComponentInfo, DesignSystemProfile, SourceRef } from '../extract/types';
import { resolveComponentTag } from '../extract/usage';

export interface RouteEntry {
  pattern: string;
  page: string;
  layouts: string[];
  /** IDs of every project component the page and its layouts render, directly or through other components. */
  components: string[];
}

export interface ComponentCard {
  /** `file:line` of the declaration, the same key the profile uses. */
  id: string;
  name: string;
  source: SourceRef;
  props: ComponentInfo['props'];
  variants: ComponentInfo['variants'];
  uses: number;
  example?: SourceRef;
}

export interface RepoIndex {
  commit: string | null;
  routes: RouteEntry[];
  components: ComponentCard[];
  /** Component, page, or layout ID to the IDs of project components it renders. */
  renders: Record<string, string[]>;
  profile: DesignSystemProfile;
}

export interface ResolvedSelection {
  source: SourceRef & { column: number };
  tag: string;
  component: ComponentCard | null;
  /** JSX ancestors, nearest first. */
  /** `props` is the opening tag's attributes as written, so the model sees context such as tone="ink". */
  parents: Array<SourceRef & { tag: string; props: string }>;
}

function routePattern(file: string): string {
  const parts = file.replace(/^(src\/)?app\//, '').replace(/(^|\/)page\.[jt]sx?$/, '').split('/').filter(Boolean);
  const visible = parts.filter((part) => !/^\(.+\)$/.test(part) && !part.startsWith('@'));
  return `/${visible.join('/')}`;
}

function layoutsFor(page: string, layouts: string[]): string[] {
  const dir = page.slice(0, page.lastIndexOf('/'));
  return layouts.filter((layout) => {
    const parent = layout.slice(0, layout.lastIndexOf('/'));
    return dir === parent || dir.startsWith(`${parent}/`);
  }).sort((a, b) => a.length - b.length);
}

const idOf = (c: SourceRef) => `${c.file}:${c.line}`;

/** Which project component renders which, keyed by declaration ID. Elements outside any component are skipped. */
function renderEdges(project: Project, root: string, components: ComponentInfo[]): Record<string, string[]> {
  const byLocation = new Map(components.map((c) => [idOf(c), c]));
  const byName = new Map<string, ComponentInfo[]>();
  for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const edges = new Map<string, Set<string>>();
  for (const sf of project.getSourceFiles()) {
    const file = projectPath(root, sf.getFilePath());
    if (!file) continue;
    for (const el of [...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)]) {
      const tagNode = el.getTagNameNode();
      if (!/^[A-Z]/.test(tagNode.getText())) continue;
      const target = resolveComponentTag(tagNode, root, byLocation, byName);
      const owner = el.getFirstAncestor((node) =>
        (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node) || Node.isExportAssignment(node))
        && byLocation.has(`${file}:${node.getStartLineNumber()}`));
      if (!target || !owner) continue;
      const from = `${file}:${owner.getStartLineNumber()}`;
      edges.set(from, (edges.get(from) ?? new Set()).add(idOf(target)));
    }
  }
  return Object.fromEntries([...edges].sort(([a], [b]) => a.localeCompare(b)).map(([from, to]) => [from, [...to].sort()]));
}

function reachable(starts: string[], renders: Record<string, string[]>): string[] {
  const seen = new Set<string>();
  const queue = starts.flatMap((id) => renders[id] ?? []);
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    queue.push(...(renders[id] ?? []));
  }
  return [...seen].sort();
}

/** Per-commit deterministic index. The caller owns persistence and invalidation on push. */
export function buildRepoIndex(profile: DesignSystemProfile, project: Project, root: string): RepoIndex {
  const renders = renderEdges(project, root, profile.components);
  const idByFile = (file: string, kind: ComponentInfo['kind']) => profile.components.filter((c) => c.file === file && c.kind === kind).map(idOf);
  const pages = profile.components.filter((c) => c.kind === 'page');
  const layouts = profile.components.filter((c) => c.kind === 'layout').map((c) => c.file);
  const routes = pages.map((page) => {
    const pageLayouts = layoutsFor(page.file, layouts);
    return {
      pattern: routePattern(page.file),
      page: page.file,
      layouts: pageLayouts,
      components: reachable([idOf(page), ...pageLayouts.flatMap((file) => idByFile(file, 'layout'))], renders),
    };
  });
  const components = profile.components.filter((c) => c.kind === 'component').map((c) => {
    const usage = profile.usage.components.find((u) => u.file === c.file && u.line === c.line);
    return {
      id: idOf(c),
      name: c.name,
      source: { file: c.file, line: c.line },
      props: c.props,
      variants: c.variants,
      uses: usage?.uses ?? 0,
      example: usage?.sites[0],
    };
  });
  return { commit: profile.commit, routes: routes.sort((a, b) => a.pattern.localeCompare(b.pattern)), components, renders, profile };
}

/** Match a URL pathname to a Next App Router page, including dynamic and catch-all segments. */
export function resolveRoute(index: RepoIndex, pathname: string): RouteEntry | null {
  let path: string;
  try {
    path = new URL(pathname, 'https://neat.invalid').pathname;
  } catch {
    return null;
  }
  const actual = path.split('/').filter(Boolean);
  const matches = index.routes.filter(({ pattern }) => {
    const parts = pattern.split('/').filter(Boolean);
    let i = 0;
    for (const part of parts) {
      if (/^\[\[\.\.\..+\]\]$/.test(part)) return true;
      if (/^\[\.\.\..+\]$/.test(part)) return i < actual.length;
      if (i >= actual.length || (!/^\[.+\]$/.test(part) && part !== actual[i])) return false;
      i++;
    }
    return i === actual.length;
  });
  return matches.sort((a, b) => {
    const score = (route: RouteEntry) => route.pattern.split('/').filter((part) => part && !part.startsWith('[')).length;
    return score(b) - score(a) || b.pattern.length - a.pattern.length;
  })[0] ?? null;
}

function jsxName(node: Node): string | null {
  if (Node.isJsxElement(node)) return node.getOpeningElement().getTagNameNode().getText();
  if (Node.isJsxSelfClosingElement(node)) return node.getTagNameNode().getText();
  return null;
}

export type JsxOpening = JsxOpeningElement | JsxSelfClosingElement;

/** The JSX opening element a `path:line:col` tag points at exactly, in the unmodified repo copy. */
export function findJsxAt(project: Project, root: string, tag: string): { sf: SourceFile; file: string; opening: JsxOpening; line: number; column: number } | null {
  const match = /^(.*\.[jt]sx?):(\d+):(\d+)$/.exec(tag);
  if (!match) return null;
  const [, file, lineText, columnText] = match;
  const line = Number(lineText);
  const column = Number(columnText);
  if (!file || !Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) return null;
  const sf = project.getSourceFiles().find((source) => projectPath(root, source.getFilePath()) === file);
  if (!sf || line > sf.getEndLineNumber()) return null;
  const sourceLine = sf.getFullText().split('\n')[line - 1];
  if (!sourceLine || column > sourceLine.length) return null;
  const offset = sf.getFullText().split('\n').slice(0, line - 1).reduce((total, text) => total + text.length + 1, 0) + column - 1;
  const opening = sf.getDescendantAtPos(offset)?.getFirstAncestor((node) =>
    Node.isJsxOpeningElement(node) || Node.isJsxSelfClosingElement(node));
  const target = opening ?? sf.getDescendantAtPos(offset);
  if (!target || !(Node.isJsxOpeningElement(target) || Node.isJsxSelfClosingElement(target))) return null;
  if (target.getStartLineNumber() !== line || target.getStart() !== offset) return null;
  return { sf, file, opening: target, line, column };
}

/** Resolve a data-nl-src or data-nl-inst tag against the unmodified repo copy. */
export function resolveSelection(project: Project, root: string, index: RepoIndex, tag: string): ResolvedSelection | null {
  const found = findJsxAt(project, root, tag);
  if (!found) return null;
  const { sf, file, opening: target, line, column } = found;
  const offset = target.getStart();
  const tagName = target.getTagNameNode().getText();
  const parents: ResolvedSelection['parents'] = [];
  const element = Node.isJsxOpeningElement(target) ? target.getParentOrThrow() : target;
  for (let parent: Node | undefined = element.getParent(); parent; parent = parent.getParent()) {
    const name = jsxName(parent);
    if (!name) continue;
    const opening = Node.isJsxElement(parent) ? parent.getOpeningElement() : parent;
    const props = Node.isJsxOpeningElement(opening) || Node.isJsxSelfClosingElement(opening)
      ? opening.getAttributes().map((a) => a.getText()).join(' ').replace(/\s+/g, ' ').slice(0, 200) : '';
    parents.push({ tag: name, props, file, line: parent.getStartLineNumber() });
  }
  return { source: { file, line, column }, tag: tagName, component: componentAt(index, sf, file, offset), parents };
}

/** The team component whose declaration contains `offset`, innermost first; null in a page, a layout, or loose code. */
export function componentAt(index: RepoIndex, sf: SourceFile, file: string, offset: number): ComponentCard | null {
  return index.components
    .filter((card) => card.source.file === file)
    .map((card) => ({ card, declaration: sf.getDescendants().find((node) =>
      (Node.isFunctionDeclaration(node) || Node.isVariableDeclaration(node) || Node.isExportAssignment(node))
      && node.getStartLineNumber() === card.source.line && node.getStart() <= offset && node.getEnd() >= offset),
    }))
    .filter((entry) => entry.declaration !== undefined)
    .sort((a, b) => (a.declaration!.getEnd() - a.declaration!.getStart()) - (b.declaration!.getEnd() - b.declaration!.getStart()))[0]?.card ?? null;
}

export function loadEditProject(root: string): Project {
  return loadProject(root);
}

export interface ContextPacket {
  route: RouteEntry | null;
  selection: ResolvedSelection;
  components: ComponentCard[];
  tokens: Pick<DesignSystemProfile['tokens'], 'colors' | 'fonts' | 'radius' | 'unresolved'>;
  facts: DesignSystemProfile['facts'];
  /** `text` is numbered source lines; `elements` gives the source tag of every JSX element in them, so edits can target them. */
  source: { file: string; startLine: number; text: string; elements: Array<{ tag: string; element: string }> };
  /** What the budget cut, such as "facts: 4". Empty when everything fit. */
  omitted: string[];
}

const MAX_CARDS = 12;
const MAX_FACTS = 12;
const WINDOWS = [15, 8, 3, 0];

/**
 * Pack the selection, a source window, component cards, role tokens, and cited facts into at most `maxChars`
 * characters of JSON. When it doesn't fit, facts go first, then extra cards, then source lines, then the rest of the
 * cards except the selected one. Never sends the whole repo.
 */
export function buildContext(index: RepoIndex, project: Project, root: string, pathname: string, selection: ResolvedSelection, maxChars = 12000): ContextPacket {
  if (!Number.isSafeInteger(maxChars) || maxChars < 500) throw new Error('Context budget must be at least 500 characters.');
  const route = resolveRoute(index, pathname);
  const onRoute = new Set(route?.components ?? []);
  const selected = selection.component ?? index.components.find((card) => card.name === selection.tag) ?? null;
  const rank = (card: ComponentCard) => (card === selected ? 3 : 0) + (onRoute.has(card.id) ? 2 : 0) + (card.source.file === selection.source.file ? 1 : 0);
  const allCards = index.components.filter((card) => rank(card) > 0 || card.uses > 0)
    .sort((a, b) => rank(b) - rank(a) || b.uses - a.uses || a.id.localeCompare(b.id))
    .slice(0, MAX_CARDS);
  const names = new Set(allCards.map((card) => card.name));
  const factRank = (fact: DesignSystemProfile['facts'][number]) =>
    fact.evidence.some((ref) => ref.file === selection.source.file) ? 2 : [...names].some((name) => fact.id.includes(`:${name}:`) || fact.id.endsWith(`:${name}`)) ? 1 : 0;
  const allFacts = index.profile.facts.map((fact) => ({ fact, rank: factRank(fact) })).filter((entry) => entry.rank > 0 || !/^(unused|duplicate|variant):/.test(entry.fact.id))
    .sort((a, b) => b.rank - a.rank).map((entry) => entry.fact).slice(0, MAX_FACTS);

  const sf = project.getSourceFiles().find((source) => projectPath(root, source.getFilePath()) === selection.source.file);
  if (!sf) throw new Error('Selection source is absent from the project.');
  const lines = sf.getFullText().split('\n');
  const openings = [...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)]
    .map((el) => {
      const { line, column } = sf.getLineAndColumnAtPos(el.getStart());
      return { line, tag: `${selection.source.file}:${line}:${column}`, element: el.getTagNameNode().getText() };
    })
    .sort((a, b) => a.line - b.line || a.tag.localeCompare(b.tag));
  const window = (radius: number) => {
    const start = Math.max(0, selection.source.line - 1 - radius);
    const end = selection.source.line + radius;
    const text = lines.slice(start, end).map((line, i) => `${start + i + 1}: ${line}`).join('\n');
    const elements = openings.filter((el) => el.line > start && el.line <= end).map(({ tag, element }) => ({ tag, element }));
    return { file: selection.source.file, startLine: start + 1, text, elements };
  };
  const { colors, fonts, radius, unresolved } = index.profile.tokens;

  let cards = allCards.length;
  let facts = allFacts.length;
  let w = 0;
  const minCards = selected && allCards.includes(selected) ? 1 : 0;
  const packet = (): ContextPacket => {
    const omitted = [
      allFacts.length > facts ? `facts: ${allFacts.length - facts}` : '',
      allCards.length > cards ? `components: ${allCards.length - cards}` : '',
      w > 0 ? `source lines beyond ±${WINDOWS[w]}` : '',
    ].filter(Boolean);
    return { route, selection, components: allCards.slice(0, cards), tokens: { colors, fonts, radius, unresolved }, facts: allFacts.slice(0, facts), source: window(WINDOWS[w]!), omitted };
  };
  const fits = () => JSON.stringify(packet()).length <= maxChars;
  while (!fits() && facts > 0) facts--;
  while (!fits() && cards > Math.min(4, allCards.length)) cards--;
  while (!fits() && w < WINDOWS.length - 1) w++;
  while (!fits() && cards > minCards) cards--;
  if (!fits()) throw new Error(`The selection alone needs more than ${maxChars} characters of context.`);
  return packet();
}
