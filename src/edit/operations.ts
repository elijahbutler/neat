import { dirname, relative } from 'node:path';
import { Node, Project, SyntaxKind, ts, type JsxAttribute, type SourceFile } from 'ts-morph';
import { z } from 'zod';
import { projectPath } from '../extract/project';
import { substituteTokens, tailwindMajor } from '../extract/token-match';
import { findJsxAt, type ComponentCard, type JsxOpening, type RepoIndex } from './index';
import { resolveScope, scopeViolation, type EditScope, type ScopeConfirmation } from './scope';
import { classNameSpread } from './properties';
import { isLiteralTextChild } from './text';

const tag = z.string().regex(/^.+\.[jt]sx?:\d+:\d+$/, 'a source tag such as app/page.tsx:12:7');

/** What the model may return in the edit step. Code applies these to the syntax tree; the model never writes files. */
export const editOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('insert-jsx'),
    anchor: tag,
    position: z.enum(['before', 'after', 'first-child', 'last-child']),
    jsx: z.string().min(1).max(4000),
  }).strict(),
  z.object({
    op: z.literal('set-prop'),
    target: tag,
    name: z.string().regex(/^[A-Za-z_][\w-]*$/),
    /** A string, `{ expression }` for code, `true` for a bare attribute, or `null` to remove it. */
    value: z.union([z.string().max(2000), z.object({ expression: z.string().min(1).max(2000) }).strict(), z.literal(true), z.null()]),
  }).strict(),
  z.object({
    op: z.literal('replace-class'),
    target: tag,
    /** Empty adds `to` to the element's class string, which must be one plain string or absent. */
    from: z.string().regex(/^\S*$/),
    /** Empty removes the class. */
    to: z.string().regex(/^\S*$/),
  }).strict(),
  z.object({
    op: z.literal('set-text'),
    target: tag,
    text: z.string().max(2000),
  }).strict(),
]);
export const editOperationsSchema = z.array(editOperationSchema).min(1).max(20);
export type EditOperation = z.infer<typeof editOperationSchema>;

export interface EditError {
  /** Index of the operation in the request, or -1 for the request as a whole. */
  op: number;
  code: 'invalid' | 'target-not-found' | 'bad-jsx' | 'bad-anchor' | 'unknown-component' | 'no-children' | 'class-not-found' | 'ambiguous-class' | 'not-plain-text' | 'overlap' | 'out-of-scope' | 'needs-confirmation';
  message: string;
  /** Only with needs-confirmation: what to ask the person, and what to add to the scope's allow-list if they agree. */
  confirm?: ScopeConfirmation;
}

export interface FileChange {
  file: string;
  before: string;
  after: string;
}

export interface EditResult {
  ok: boolean;
  /** Empty unless every operation applied. */
  changes: FileChange[];
  errors: EditError[];
  /** Arbitrary values in the model's output that were swapped for matching tokens. */
  substitutions: Array<{ from: string; to: string }>;
}

interface TextEdit {
  file: string;
  start: number;
  end: number;
  text: string;
  op: number;
  /** Orders inserts at the same offset: a first child goes before anything else there, a last child after. */
  rank?: number;
}

class OpError extends Error {
  constructor(readonly code: EditError['code'], message: string, readonly confirm?: ScopeConfirmation) {
    super(message);
  }
}

const scratch = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: ts.JsxEmit.Preserve } });

/** Parse a snippet as exactly one JSX element or fragment. */
function parseJsx(jsx: string): SourceFile {
  const sf = scratch.createSourceFile('snippet.tsx', `const snippet = (\n${jsx}\n);\n`, { overwrite: true });
  const diagnostics = scratch.getProgram().getSyntacticDiagnostics(sf);
  if (diagnostics.length) throw new OpError('bad-jsx', `JSX does not parse: ${diagnostics[0]!.getMessageText().toString()}`);
  const init = sf.getVariableDeclarationOrThrow('snippet').getInitializerOrThrow();
  const expr = Node.isParenthesizedExpression(init) ? init.getExpression() : init;
  if (!Node.isJsxElement(expr) && !Node.isJsxSelfClosingElement(expr) && !Node.isJsxFragment(expr)) {
    throw new OpError('bad-jsx', 'JSX must be a single element or fragment.');
  }
  return sf;
}

function indentOf(sf: SourceFile, pos: number): string {
  const text = sf.getFullText();
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))![0];
}

function reindent(jsx: string, indent: string): string {
  return jsx.trim().split('\n').map((line, i) => (i === 0 ? line : `${indent}${line}`)).join('\n');
}

function attrText(name: string, value: string | { expression: string } | true): string {
  if (value === true) return name;
  if (typeof value === 'string') return !/["\n{}]/.test(value) ? `${name}="${value}"` : `${name}={${JSON.stringify(value)}}`;
  return `${name}={${value.expression}}`;
}

function textValue(text: string): string {
  return /[{}<>]/.test(text) || text !== text.trim() ? `{${JSON.stringify(text)}}` : text;
}

/** Names already in scope at module level: imports and top-level declarations. */
function moduleNames(sf: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const imp of sf.getImportDeclarations()) {
    const def = imp.getDefaultImport();
    if (def) names.add(def.getText());
    const ns = imp.getNamespaceImport();
    if (ns) names.add(ns.getText());
    for (const named of imp.getNamedImports()) names.add((named.getAliasNode() ?? named.getNameNode()).getText());
  }
  for (const fn of sf.getFunctions()) if (fn.getName()) names.add(fn.getName()!);
  for (const v of sf.getVariableDeclarations()) names.add(v.getName());
  for (const c of sf.getClasses()) if (c.getName()) names.add(c.getName()!);
  return names;
}

/** How other files import a card's module, most common first; a relative path when nobody does yet. */
function importSpecifier(project: Project, root: string, from: SourceFile, card: ComponentCard): string {
  const counts = new Map<string, number>();
  for (const sf of project.getSourceFiles()) {
    for (const imp of sf.getImportDeclarations()) {
      const target = imp.getModuleSpecifierSourceFile();
      if (!target || projectPath(root, target.getFilePath()) !== card.source.file) continue;
      const spec = imp.getModuleSpecifierValue();
      if (spec.startsWith('.')) continue;
      counts.set(spec, (counts.get(spec) ?? 0) + 1);
    }
  }
  const best = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (best) return best[0];
  const rel = relative(dirname(from.getFilePath()), `${root}/${card.source.file}`).replace(/\\/g, '/').replace(/\.[jt]sx?$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Whether the card's module exports it as default. Unknown shapes are treated as named exports. */
function isDefaultExport(project: Project, root: string, card: ComponentCard): boolean {
  const sf = project.getSourceFiles().find((source) => projectPath(root, source.getFilePath()) === card.source.file);
  const defaults = sf?.getExportedDeclarations().get('default') ?? [];
  return defaults.some((decl) => decl.getStartLineNumber() === card.source.line);
}

/** Edits that import the given cards into `sf`, merging into an existing import of the same module. */
function importEdits(project: Project, root: string, sf: SourceFile, file: string, cards: ComponentCard[], op: number): TextEdit[] {
  const edits: TextEdit[] = [];
  const imports = sf.getImportDeclarations();
  for (const card of cards) {
    const spec = importSpecifier(project, root, sf, card);
    const isDefault = isDefaultExport(project, root, card);
    const existing = imports.find((imp) => imp.getModuleSpecifierValue() === spec && !imp.isTypeOnly());
    const named = existing?.getNamedImports() ?? [];
    if (!isDefault && existing && named.length) {
      edits.push({ file, start: named.at(-1)!.getEnd(), end: named.at(-1)!.getEnd(), text: `, ${card.name}`, op });
      continue;
    }
    const line = isDefault ? `import ${card.name} from '${spec}';` : `import { ${card.name} } from '${spec}';`;
    const last = imports.at(-1);
    const directive = sf.getStatements().find((s) => Node.isExpressionStatement(s) && Node.isStringLiteral(s.getExpression()));
    const at = last?.getEnd() ?? directive?.getEnd() ?? 0;
    edits.push({ file, start: at, end: at, text: at === 0 ? `${line}\n` : `\n${line}`, op });
  }
  return edits;
}

/** Replace or remove one class inside a literal's body, leaving the rest of its whitespace as it was. */
function replaceClass(body: string, from: string, to: string): string {
  const parts = body.split(/(\s+)/);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== from) continue;
    parts[i] = to;
    if (to) continue;
    // Removing: drop one neighbouring run of whitespace, so "a b c" becomes "a c" and "b " + x stays joined correctly.
    if (i + 1 < parts.length) parts[i + 1] = '';
    else if (i > 0) parts[i - 1] = '';
  }
  return parts.join('');
}

/** Add one class to the end of a literal's body, unless it is already there. */
function addClass(body: string, to: string): string {
  if (body.split(/\s+/).includes(to)) return body;
  return body.trim() ? `${body.replace(/\s+$/, '')} ${to}` : to;
}

function classAttribute(opening: JsxOpening): JsxAttribute | undefined {
  return opening.getAttributes().find((a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === 'className');
}

/**
 * Apply edit operations to the unmodified repo copy. All or nothing: any error means no changes, so the model can
 * retry from the same state. Positions come from source tags, so every operation targets the original text.
 *
 * `scope` limits targets to the selected element, what is inside it, and its allow-list. Pass null only where there is
 * no selection to hold an edit to, such as the command line.
 */
export function applyEdits(project: Project, root: string, index: RepoIndex, input: unknown, scope: EditScope | null): EditResult {
  const parsed = editOperationsSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, changes: [], substitutions: [], errors: parsed.error.issues.map((issue) => ({ op: typeof issue.path[0] === 'number' ? issue.path[0] : -1, code: 'invalid', message: `${issue.path.join('.') || 'request'}: ${issue.message}` })) };
  }
  const within = scope && resolveScope(project, root, index, scope);
  if (scope && !within) {
    return { ok: false, changes: [], substitutions: [], errors: [{ op: -1, code: 'target-not-found', message: `The selected element (${scope.selection}) is no longer in the code.` }] };
  }
  const tokens = index.profile.tokens;
  const major = tailwindMajor(index.profile.framework.tailwind);
  const substitutions: EditResult['substitutions'] = [];
  const sub = (classes: string) => {
    const out = substituteTokens(classes, tokens, major);
    substitutions.push(...out.replaced);
    return out.classes;
  };

  const edits: TextEdit[] = [];
  const errors: EditError[] = [];
  const files = new Map<string, SourceFile>();
  const pendingImports = new Map<string, Set<string>>();
  const classEdits = new Map<string, TextEdit>();
  const propsSet = new Set<string>();

  parsed.data.forEach((operation, op) => {
    try {
      const found = findJsxAt(project, root, operation.op === 'insert-jsx' ? operation.anchor : operation.target);
      if (!found) throw new OpError('target-not-found', 'No JSX element starts at that source tag in this commit.');
      const outside = within ? scopeViolation(index, within, found) : null;
      if (outside) throw new OpError(outside.code, outside.message, outside.confirm);
      const { sf, file, opening } = found;
      files.set(file, sf);
      const element = Node.isJsxOpeningElement(opening) ? opening.getParentOrThrow() : opening;

      if (operation.op === 'insert-jsx') {
        const snippet = parseJsx(operation.jsx);
        for (const attr of snippet.getDescendantsOfKind(SyntaxKind.JsxAttribute)) {
          const init = attr.getInitializer();
          if (attr.getNameNode().getText() === 'className' && init && Node.isStringLiteral(init)) init.setLiteralValue(sub(init.getLiteralValue()));
        }
        const known = moduleNames(sf);
        const needed = pendingImports.get(file) ?? new Set<string>();
        const tags = [...snippet.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...snippet.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)]
          .map((el) => el.getTagNameNode().getText().split('.')[0]!).filter((name) => /^[A-Z]/.test(name));
        for (const name of new Set(tags)) {
          if (known.has(name)) continue;
          const cards = index.components.filter((card) => card.name === name);
          if (cards.length !== 1) throw new OpError('unknown-component', cards.length ? `${name} is defined in ${cards.length} files; the plan must pick one.` : `${name} is not a component in this repo and isn't imported in ${file}.`);
          if (cards[0]!.source.file === file) throw new OpError('unknown-component', `${name} is declared in ${file} but not at module level.`);
          needed.add(cards[0]!.id);
        }
        pendingImports.set(file, needed);
        const init = snippet.getVariableDeclarationOrThrow('snippet').getInitializerOrThrow();
        const jsx = (Node.isParenthesizedExpression(init) ? init.getExpression() : init).getText();
        const indent = indentOf(sf, element.getStart());
        if (operation.position === 'before' || operation.position === 'after') {
          const parent = element.getParent();
          if (!parent || !(Node.isJsxElement(parent) || Node.isJsxFragment(parent))) {
            throw new OpError('bad-anchor', 'The anchor is not a child of a JSX element (for example it is inside .map(), a condition, or a return). Anchor on an element whose parent is JSX, or insert as a child of a JSX element.');
          }
          const text = reindent(jsx, indent);
          const at = operation.position === 'before' ? element.getStart() : element.getEnd();
          edits.push({ file, start: at, end: at, text: operation.position === 'before' ? `${text}\n${indent}` : `\n${indent}${text}`, op });
        } else {
          if (!Node.isJsxElement(element)) throw new OpError('no-children', 'A self-closing element has no children to insert into.');
          const inner = `${indent}  `;
          const text = reindent(jsx, inner);
          if (operation.position === 'first-child') {
            const at = element.getOpeningElement().getEnd();
            edits.push({ file, start: at, end: at, text: `\n${inner}${text}`, op, rank: 0 });
          } else {
            const closing = element.getClosingElement();
            const lineStart = sf.getFullText().lastIndexOf('\n', closing.getStart() - 1) + 1;
            const closingOnOwnLine = sf.getFullText().slice(lineStart, closing.getStart()).trim() === '';
            edits.push(closingOnOwnLine
              ? { file, start: lineStart, end: lineStart, text: `${inner}${text}\n`, op, rank: 2 }
              : { file, start: closing.getStart(), end: closing.getStart(), text: `\n${inner}${text}\n${indent}`, op, rank: 2 });
          }
        }
      } else if (operation.op === 'set-prop') {
        const propKey = `${file}:${opening.getStart()}:${operation.name}`;
        if (propsSet.has(propKey)) throw new OpError('overlap', `Another operation already sets ${operation.name} on this element.`);
        propsSet.add(propKey);
        const existing = opening.getAttributes().find((a): a is JsxAttribute => Node.isJsxAttribute(a) && a.getNameNode().getText() === operation.name);
        const value = operation.name === 'className' && typeof operation.value === 'string' ? sub(operation.value) : operation.value;
        if (value === null) {
          if (existing) edits.push({ file, start: existing.getFullStart(), end: existing.getEnd(), text: '', op });
        } else if (existing) {
          edits.push({ file, start: existing.getStart(), end: existing.getEnd(), text: attrText(operation.name, value), op });
        } else {
          const after = opening.getAttributes().at(-1) ?? opening.getTagNameNode();
          edits.push({ file, start: after.getEnd(), end: after.getEnd(), text: ` ${attrText(operation.name, value)}`, op });
        }
      } else if (operation.op === 'replace-class') {
        const attr = classAttribute(opening);
        const init = attr?.getInitializer();
        const to = sub(operation.to);
        if (!operation.from && !to) throw new OpError('invalid', 'replace-class needs a from, a to, or both.');
        // Adding where a spread decides the className would either throw away what the spread passes in or be
        // overridden by it. This holds for every caller: the panel, the direct-edit path, and the model.
        const spread = operation.from ? undefined : classNameSpread(opening);
        if (spread) throw new OpError('class-not-found', `The element's className can come from {...${spread.getExpression().getText()}}, so a class can't be added to it here.`);
        if (!operation.from && !attr) {
          // Adding to an element with no className writes the attribute. Further adds in the same request join it.
          if (/["\\{}]/.test(to)) throw new OpError('invalid', `${to} can't go inside a "-quoted string.`);
          const key = `${file}:${opening.getStart()}:new-class`;
          const added = classEdits.get(key);
          if (added) added.text = `${added.text.slice(0, -1)} ${to}"`;
          else {
            const after = opening.getAttributes().at(-1) ?? opening.getTagNameNode();
            const edit = { file, start: after.getEnd(), end: after.getEnd(), text: ` className="${to}"`, op };
            classEdits.set(key, edit);
            edits.push(edit);
          }
          return;
        }
        if (!init) throw new OpError('class-not-found', 'The element has no className.');
        const literals = operation.from
          ? [init, ...init.getDescendants()].filter((n) => (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n))
            && n.getLiteralText().split(/\s+/).includes(operation.from))
          : [Node.isJsxExpression(init) ? init.getExpression() : init].filter((n) => n !== undefined && (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)));
        if (!operation.from && literals.length === 0) throw new OpError('class-not-found', "The element's className is not one plain string, so a class can't be added to it.");
        if (literals.length === 0) throw new OpError('class-not-found', `${operation.from} is not a literal class on this element.`);
        if (literals.length > 1) throw new OpError('ambiguous-class', `${operation.from} appears in ${literals.length} strings on this element.`);
        const literal = literals[0]!;
        const quote = literal.getText()[0]!;
        if (to.includes(quote) || to.includes('\\') || (quote === '`' && to.includes('${'))) throw new OpError('invalid', `${to} can't go inside a ${quote}-quoted string.`);
        // Several replace-class operations on one string build on each other instead of overlapping.
        const previous = classEdits.get(`${file}:${literal.getStart()}`);
        const body = previous ? previous.text.slice(1, -1) : literal.getText().slice(1, -1);
        const text = `${quote}${operation.from ? replaceClass(body, operation.from, to) : addClass(body, to)}${quote}`;
        if (previous) previous.text = text;
        else {
          const edit = { file, start: literal.getStart(), end: literal.getEnd(), text, op };
          classEdits.set(`${file}:${literal.getStart()}`, edit);
          edits.push(edit);
        }
      } else {
        if (!Node.isJsxElement(element)) throw new OpError('not-plain-text', 'A self-closing element has no text.');
        const children = element.getJsxChildren();
        if (!children.length || !children.every(isLiteralTextChild)) throw new OpError('not-plain-text', 'Only elements whose children are plain text can be retexted; use insert-jsx or set-prop.');
        const first = children[0]!;
        const last = children.at(-1)!;
        const original = sf.getFullText().slice(first.getStart(), last.getEnd());
        const lead = /^\s*/.exec(original)![0];
        const trail = /\s*$/.exec(original)![0];
        edits.push({ file, start: first.getStart(), end: last.getEnd(), text: `${lead}${textValue(operation.text)}${trail}`, op });
      }
    } catch (error) {
      if (error instanceof OpError) errors.push({ op, code: error.code, message: error.message, ...(error.confirm ? { confirm: error.confirm } : {}) });
      else throw error;
    }
  });

  for (const [file, ids] of pendingImports) {
    const cards = [...ids].map((id) => index.components.find((card) => card.id === id)!);
    if (cards.length) edits.push(...importEdits(project, root, files.get(file)!, file, cards, -1));
  }

  const byFile = new Map<string, TextEdit[]>();
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  for (const list of byFile.values()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end || (a.rank ?? 1) - (b.rank ?? 1) || a.op - b.op);
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1]!;
      const cur = list[i]!;
      if (cur.start < prev.end || (cur.start === prev.start && cur.end > cur.start && prev.end > prev.start)) {
        errors.push({ op: cur.op, code: 'overlap', message: `Operation ${cur.op} changes the same text as operation ${prev.op}.` });
      }
    }
  }
  if (errors.length) return { ok: false, changes: [], errors, substitutions };

  const changes = [...byFile].map(([file, list]) => {
    const before = files.get(file)!.getFullText();
    let after = before;
    for (const e of [...list].reverse()) after = after.slice(0, e.start) + e.text + after.slice(e.end);
    return { file, before, after };
  }).sort((a, b) => a.file.localeCompare(b.file));
  return { ok: true, changes, errors: [], substitutions };
}
