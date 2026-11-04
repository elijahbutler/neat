import { basename } from 'node:path';
import {
  Node,
  SyntaxKind,
  ts,
  type ArrowFunction,
  type FunctionDeclaration,
  type FunctionExpression,
  type ObjectLiteralExpression,
  type Project,
  type SourceFile,
  type Type,
} from 'ts-morph';
import { isProjectFile, projectPath } from './project';
import type { ComponentInfo, PropInfo, VariantGroup } from './types';

type RenderFn = ArrowFunction | FunctionExpression | FunctionDeclaration;
interface Candidate { name: string; decl: Node; fn: RenderFn }
interface CvaDefinition { variants: Record<string, string[]>; defaults: Record<string, string> }

const PASCAL = /^[A-Z][A-Za-z0-9]*$/;
const MAX_TYPE_LENGTH = 120;

function pascalFromFile(base: string): string {
  return base
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

const ROUTE_FILES = new Set(['loading', 'error', 'not-found', 'global-not-found', 'global-error', 'template', 'default', 'forbidden', 'unauthorized']);

function routeKind(file: string): ComponentInfo['kind'] {
  if (!/(^|\/)app\//.test(file)) return 'component';
  const base = basename(file).replace(/\.[jt]sx?$/, '');
  if (base === 'page') return 'page';
  if (base === 'layout') return 'layout';
  return ROUTE_FILES.has(base) ? 'route' : 'component';
}

/** True when the file's directive prologue contains 'use client' (comments before it are fine). */
function isClientFile(sf: SourceFile): boolean {
  for (const statement of sf.getStatements()) {
    if (!Node.isExpressionStatement(statement)) return false;
    const expr = statement.getExpression();
    if (!Node.isStringLiteral(expr)) return false;
    if (expr.getLiteralText() === 'use client') return true;
  }
  return false;
}

function stripQuotes(text: string): string {
  const m = /^(['"`])(.*)\1$/s.exec(text);
  return m ? m[2]! : text;
}

/** The function that renders, unwrapping forwardRef(...) and memo(...) and following `memo(Card)` to Card. */
function renderFunction(node: Node | undefined, depth = 0): RenderFn | undefined {
  if (!node || depth > 5) return undefined;
  if (Node.isIdentifier(node)) {
    const decl = node.getSymbol()?.getDeclarations()[0];
    if (decl && Node.isFunctionDeclaration(decl)) return decl;
    if (decl && Node.isVariableDeclaration(decl)) return renderFunction(decl.getInitializer(), depth + 1);
    return undefined;
  }
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node)) return node;
  if (Node.isCallExpression(node) && /(^|\.)(forwardRef|memo)$/.test(node.getExpression().getText())) {
    return renderFunction(node.getArguments()[0], depth + 1);
  }
  if (Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node)) {
    return renderFunction(node.getExpression(), depth + 1);
  }
  return undefined;
}

function containsJsx(fn: RenderFn): boolean {
  return fn.getFirstDescendant((d) => Node.isJsxElement(d) || Node.isJsxSelfClosingElement(d) || Node.isJsxFragment(d)) !== undefined;
}

function candidates(sf: SourceFile): Candidate[] {
  const fromFile = pascalFromFile(sf.getBaseNameWithoutExtension());
  const found: Candidate[] = [];
  for (const f of sf.getFunctions()) {
    const name = f.getName() ?? (f.isDefaultExport() ? fromFile : undefined);
    if (name) found.push({ name, decl: f, fn: f });
  }
  for (const v of sf.getVariableDeclarations()) {
    const fn = renderFunction(v.getInitializer());
    if (fn) found.push({ name: v.getName(), decl: v, fn });
  }
  for (const a of sf.getExportAssignments()) {
    const fn = renderFunction(a.getExpression());
    if (fn) found.push({ name: fromFile, decl: a, fn });
  }
  return found.filter((c) => PASCAL.test(c.name) && containsJsx(c.fn));
}

function typeText(type: Type, at: Node): string {
  const text = type.getText(at, ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope | ts.TypeFormatFlags.NoTruncation);
  return text.length > MAX_TYPE_LENGTH ? `${text.slice(0, MAX_TYPE_LENGTH - 1)}…` : text;
}

/** String-literal options when a type is a union of two or more string literals (ignoring null/undefined). */
function literalOptions(type: Type): string[] | null {
  const parts = (type.isUnion() ? type.getUnionTypes() : [type]).filter((t) => !t.isUndefined() && !t.isNull());
  if (parts.length < 2 || !parts.every((t) => t.isStringLiteral())) return null;
  return parts.map((t) => String(t.getLiteralValue())).sort();
}

function extractProps(fn: RenderFn): { props: PropInfo[]; variants: VariantGroup[] } {
  const param = fn.getParameters()[0];
  if (!param) return { props: [], variants: [] };

  const defaults = new Map<string, string>();
  const bound: string[] = [];
  const nameNode = param.getNameNode();
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const el of nameNode.getElements()) {
      if (el.getDotDotDotToken()) continue;
      const key = (el.getPropertyNameNode() ?? el.getNameNode()).getText();
      bound.push(key);
      const init = el.getInitializer();
      if (init) defaults.set(key, init.getText());
    }
  }

  const props: PropInfo[] = [];
  const variants: VariantGroup[] = [];
  for (const symbol of param.getType().getProperties()) {
    if (!symbol.getDeclarations().some((d) => isProjectFile(d.getSourceFile().getFilePath()))) continue;
    const name = symbol.getName();
    const type = symbol.getTypeAtLocation(param);
    const optional = symbol.hasFlags(ts.SymbolFlags.Optional);
    // Optionality is its own field, so don't repeat `| undefined` in the type.
    const info: PropInfo = { name, type: typeText(optional ? type.getNonNullableType() : type, param), optional };
    const def = defaults.get(name);
    if (def !== undefined) info.defaultValue = def;
    props.push(info);
    const options = literalOptions(type);
    if (options) variants.push({ prop: name, options, ...(def !== undefined ? { defaultValue: stripQuotes(def) } : {}) });
  }

  // Untyped JavaScript: fall back to the destructured names.
  if (props.length === 0) {
    for (const name of bound) {
      const def = defaults.get(name);
      props.push({ name, type: 'unknown', optional: true, ...(def !== undefined ? { defaultValue: def } : {}) });
    }
  }
  return { props: props.sort((a, b) => a.name.localeCompare(b.name)), variants };
}

function propertyName(p: Node): string | undefined {
  if (!Node.isPropertyAssignment(p) && !Node.isShorthandPropertyAssignment(p)) return undefined;
  const n = p.getNameNode();
  return Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n) ? n.getLiteralText() : n.getText();
}

function objectProperty(obj: ObjectLiteralExpression, name: string): ObjectLiteralExpression | undefined {
  for (const p of obj.getProperties()) {
    if (!Node.isPropertyAssignment(p) || propertyName(p) !== name) continue;
    const init = p.getInitializer();
    if (init && Node.isObjectLiteralExpression(init)) return init;
  }
  return undefined;
}

function mapObject<T>(obj: ObjectLiteralExpression | undefined, fn: (value: Node) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const p of obj?.getProperties() ?? []) {
    if (!Node.isPropertyAssignment(p)) continue;
    const name = propertyName(p);
    const init = p.getInitializer();
    if (name && init) out[name] = fn(init);
  }
  return out;
}

function cvaDefinitions(sf: SourceFile): Map<string, CvaDefinition> {
  const defs = new Map<string, CvaDefinition>();
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    if (call.getExpression().getText() !== 'cva') continue;
    const decl = call.getParentIfKind(SyntaxKind.VariableDeclaration);
    const config = call.getArguments()[1];
    if (!decl || !config || !Node.isObjectLiteralExpression(config)) continue;
    defs.set(decl.getName(), {
      variants: mapObject(objectProperty(config, 'variants'), (v) =>
        Node.isObjectLiteralExpression(v) ? v.getProperties().flatMap((p) => propertyName(p) ?? []).sort() : [],
      ),
      defaults: mapObject(objectProperty(config, 'defaultVariants'), (v) => stripQuotes(v.getText())),
    });
  }
  return defs;
}

/** Adds cva groups the type checker didn't surface, and cva defaults. */
function mergeCva(fn: RenderFn, props: PropInfo[], variants: VariantGroup[], cvas: Map<string, CvaDefinition>): void {
  const used = new Set(fn.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  for (const [name, def] of cvas) {
    if (!used.has(name)) continue;
    for (const [prop, options] of Object.entries(def.variants)) {
      let group = variants.find((v) => v.prop === prop);
      if (!group) {
        group = { prop, options };
        variants.push(group);
        if (!props.some((p) => p.name === prop)) props.push({ name: prop, type: options.map((o) => `"${o}"`).join(' | '), optional: true });
      }
      const def2 = def.defaults[prop];
      if (group.defaultValue === undefined && def2 !== undefined) group.defaultValue = def2;
    }
  }
  props.sort((a, b) => a.name.localeCompare(b.name));
  variants.sort((a, b) => a.prop.localeCompare(b.prop));
}

export function extractComponents(project: Project, root: string): ComponentInfo[] {
  const out: ComponentInfo[] = [];
  for (const sf of project.getSourceFiles()) {
    const file = projectPath(root, sf.getFilePath());
    if (!file || !/\.(tsx|jsx|js)$/.test(file)) continue;
    const exported = new Set<Node>(Array.from(sf.getExportedDeclarations().values()).flat());
    const client = isClientFile(sf);
    const cvas = cvaDefinitions(sf);
    for (const { name, decl, fn } of candidates(sf)) {
      const { props, variants } = extractProps(fn);
      mergeCva(fn, props, variants, cvas);
      out.push({
        name,
        file,
        line: decl.getStartLineNumber(),
        kind: routeKind(file),
        exported: exported.has(decl) || Node.isExportAssignment(decl),
        client,
        props,
        variants,
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
