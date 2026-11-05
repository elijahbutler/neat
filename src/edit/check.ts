import { Node, SyntaxKind, ts, type Diagnostic, type Project, type SourceFile } from 'ts-morph';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectPath } from '../extract/project';
import type { ComponentInfo } from '../extract/types';
import { resolveComponentTag } from '../extract/usage';
import type { RepoIndex } from './index';
import type { FileChange } from './operations';

export interface CheckError {
  check: 'syntax' | 'typecheck' | 'imports' | 'variants';
  file: string;
  line: number;
  message: string;
}

export interface CheckResult {
  ok: boolean;
  errors: CheckError[];
  /** Checks that need the running sandbox: the repo's own linter, and render plus screenshot comparison. */
  pending: Array<'lint' | 'render'>;
}

type Finding = Omit<CheckError, 'check' | 'file'> & { key: string };

function moduleLabel(root: string, specifier: string): string {
  let file = specifier;
  if (file.startsWith('file://')) {
    try { file = fileURLToPath(file); } catch { return '[external module]'; }
  }
  file = file.replaceAll('\\', '/');
  if (!isAbsolute(file) && !/^[a-zA-Z]:\//.test(file)) return specifier;
  const local = relative(resolve(root), file);
  if (local && !isAbsolute(local) && local !== '..' && !local.startsWith('../')) return local.replaceAll('\\', '/');
  const dependency = file.lastIndexOf('/node_modules/');
  return dependency >= 0 ? file.slice(dependency + 1) : '[external module]';
}

/** Remove machine locations before check feedback reaches a model or an API caller. */
function safeMessage(root: string, message: string): string {
  const rewrite = (value: string): string => {
    let decoded: string;
    try {
      const parsed: unknown = value[0] === '"' ? JSON.parse(value) : value.slice(1, -1).replace(/\\(['\\])/g, '$1');
      if (typeof parsed !== 'string') return value;
      decoded = parsed;
    }
    catch { return value; }
    const label = moduleLabel(root, decoded);
    if (label === decoded) return value;
    return value[0] === '"' ? JSON.stringify(label) : `'${label.replaceAll("'", "\\'")}'`;
  };
  const imports = message.replace(/import\(("(?:\\.|[^"\\])*")\)/g, (_match, specifier: string) => `import(${rewrite(specifier)})`);
  const quoted = imports.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, rewrite);
  const location = resolve(root).replaceAll('\\', '/');
  return quoted.replaceAll(location + '/', '').replaceAll(location, '[project]');
}

function diagnostics(list: Diagnostic[]): Finding[] {
  return list.map((d) => {
    const message = `TS${d.getCode()}: ${ts.flattenDiagnosticMessageText(d.compilerObject.messageText, ' ')}`;
    return { key: message, line: d.getLineNumber() ?? 1, message };
  });
}

/** Module specifiers imported from outside the project, such as a new npm package. */
function externalImports(root: string, sf: SourceFile): Finding[] {
  return sf.getImportDeclarations().flatMap((imp) => {
    const target = imp.getModuleSpecifierSourceFile();
    if (target && projectPath(root, target.getFilePath())) return [];
    const spec = imp.getModuleSpecifierValue();
    return [{ key: spec, line: imp.getStartLineNumber(), message: `imports ${moduleLabel(root, spec)}, which this file didn't import before` }];
  });
}

/** Literal values passed to a variant prop that the component doesn't define. */
function variantViolations(root: string, sf: SourceFile, components: ComponentInfo[]): Finding[] {
  const byLocation = new Map(components.map((c) => [`${c.file}:${c.line}`, c]));
  const byName = new Map<string, ComponentInfo[]>();
  for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  const out: Finding[] = [];
  for (const el of [...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)]) {
    const comp = resolveComponentTag(el.getTagNameNode(), root, byLocation, byName);
    if (!comp?.variants.length) continue;
    for (const attr of el.getAttributes()) {
      if (!Node.isJsxAttribute(attr)) continue;
      const group = comp.variants.find((v) => v.prop === attr.getNameNode().getText());
      const init = attr.getInitializer();
      const expr = init && Node.isJsxExpression(init) ? init.getExpression() : init;
      const value = expr && Node.isStringLiteral(expr) ? expr.getLiteralText() : null;
      if (!group || value === null || group.options.includes(value)) continue;
      const key = `${comp.name}.${group.prop}=${value}`;
      out.push({ key, line: attr.getStartLineNumber(), message: `${comp.name} has no ${group.prop}="${value}"; options are ${group.options.map((o) => `"${o}"`).join(', ')}` });
    }
  }
  return out;
}

/** Findings present after the edit that weren't there before, compared by key so shifted lines don't count as new. */
function introduced(before: Finding[], after: Finding[]): Finding[] {
  const remaining = new Map<string, number>();
  for (const f of before) remaining.set(f.key, (remaining.get(f.key) ?? 0) + 1);
  return after.filter((f) => {
    const n = remaining.get(f.key) ?? 0;
    if (n > 0) {
      remaining.set(f.key, n - 1);
      return false;
    }
    return true;
  });
}

/**
 * Files that render a component declared in one of the changed files, from the current render graph. Their types depend
 * on the edited component's props, so an edit is checked there too. The changed files themselves are left out.
 */
export function consumerFiles(index: RepoIndex, changed: string[]): string[] {
  const edited = new Set(changed);
  const ids = new Set(index.profile.components.filter((c) => edited.has(c.file)).map((c) => `${c.file}:${c.line}`));
  const files = new Set<string>();
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const [owner, rendered] of Object.entries(index.renders)) {
      if (!rendered.some((id) => ids.has(id))) continue;
      if (!ids.has(owner)) { ids.add(owner); expanded = true; }
      const file = owner.slice(0, owner.lastIndexOf(':'));
      if (!edited.has(file)) files.add(file);
    }
  }
  return [...files].sort();
}

/**
 * Check applied changes against the repo: they must parse, add no type errors, import nothing new from outside the
 * project, and pass only defined variant values. Files that render an edited component are type-checked too, so an edit
 * that breaks a consumer fails here. Problems that existed before the edit are ignored. The project is restored before
 * returning.
 */
export function checkEdit(project: Project, root: string, index: RepoIndex, changes: FileChange[]): CheckResult {
  const components = index.profile.components;
  const collect = (sf: SourceFile) => {
    const program = project.getProgram();
    return {
      syntax: diagnostics(program.getSyntacticDiagnostics(sf)),
      typecheck: diagnostics(program.getSemanticDiagnostics(sf)),
      imports: externalImports(root, sf),
      variants: variantViolations(root, sf, components),
    };
  };
  const files = changes.map((change) => {
    const sf = project.getSourceFiles().find((source) => projectPath(root, source.getFilePath()) === change.file);
    if (!sf) throw new Error(`${change.file} is not in the project.`);
    if (sf.getFullText() !== change.before) throw new Error(`${change.file} changed since the edit was computed.`);
    return { change, sf };
  });

  const consumers = consumerFiles(index, changes.map((change) => change.file)).flatMap((file) => {
    const sf = project.getSourceFiles().find((source) => projectPath(root, source.getFilePath()) === file);
    return sf ? [{ file, sf }] : [];
  });
  const semantic = (sf: SourceFile) => diagnostics(project.getProgram().getSemanticDiagnostics(sf));

  const before = files.map(({ sf }) => collect(sf));
  const beforeConsumers = consumers.map(({ sf }) => semantic(sf));
  const errors: CheckError[] = [];
  try {
    for (const { change, sf } of files) sf.replaceWithText(change.after);
    files.forEach(({ change, sf }, i) => {
      const after = collect(sf);
      for (const check of ['syntax', 'typecheck', 'imports', 'variants'] as const) {
        const found = introduced(before[i]![check], after[check]);
        for (const f of found) errors.push({ check, file: change.file, line: f.line, message: safeMessage(root, f.message) });
        // A new syntax error makes every later check noise.
        if (check === 'syntax' && found.length) break;
      }
    });
    consumers.forEach(({ file, sf }, i) => {
      for (const f of introduced(beforeConsumers[i]!, semantic(sf))) errors.push({ check: 'typecheck', file, line: f.line, message: safeMessage(root, f.message) });
    });
  } finally {
    for (const { change, sf } of files) sf.replaceWithText(change.before);
  }
  return { ok: errors.length === 0, errors, pending: ['lint', 'render'] };
}
