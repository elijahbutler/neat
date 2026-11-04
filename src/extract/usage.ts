import { Node, SyntaxKind, type JsxAttribute, type Project } from 'ts-morph';
import { categorizeClass } from './classes';
import { projectPath } from './project';
import type { ClassCategory, ClassCount, ComponentInfo, ComponentUsage, RepeatedClassList, SourceRef, TokenBypass, UsageProfile } from './types';

const CLASS_HELPERS = new Set(['cn', 'clsx', 'cx', 'cva', 'twMerge', 'classNames']);
const IGNORED_PROPS = new Set(['children', 'key', 'className', 'style', 'ref']);
const TOP_CLASSES = 15;
const MAX_SITES = 20;
const MAX_BYPASSES = 200;

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function attrValue(attr: JsxAttribute): string {
  const init = attr.getInitializer();
  if (!init) return 'true';
  if (Node.isStringLiteral(init)) return init.getLiteralText();
  if (Node.isJsxExpression(init)) {
    const e = init.getExpression();
    if (e && (Node.isStringLiteral(e) || Node.isNoSubstitutionTemplateLiteral(e))) return e.getLiteralText();
    if (e && (Node.isNumericLiteral(e) || Node.isTrueLiteral(e) || Node.isFalseLiteral(e))) return e.getText();
  }
  return '{expression}';
}

/** A same-file `const` initializer an identifier refers to, such as `className` or the `intents` in `intents[intent]`. */
function localInitializer(id: Node): Node | undefined {
  const decl = id.getSymbol()?.getDeclarations()[0];
  if (!decl || !Node.isVariableDeclaration(decl) || decl.getSourceFile() !== id.getSourceFile()) return undefined;
  return decl.getInitializer();
}

/**
 * String pieces that can hold class names, excluding object keys and import paths. Follows identifiers to same-file
 * variables, so `className={className}` and object maps like `intents[intent]` count their strings.
 */
function classLiterals(node: Node | undefined, visited = new Set<Node>()): Array<{ node: Node; text: string }> {
  if (!node || visited.has(node)) return [];
  visited.add(node);
  const out: Array<{ node: Node; text: string }> = [];
  for (const n of [node, ...node.getDescendants()]) {
    if (Node.isIdentifier(n)) {
      const parent = n.getParent();
      const isName = parent && (Node.isPropertyAssignment(parent) || Node.isPropertyAccessExpression(parent)) && parent.getNameNode() === n;
      if (!isName) out.push(...classLiterals(localInitializer(n), visited));
    } else if (Node.isStringLiteral(n) || Node.isNoSubstitutionTemplateLiteral(n)) {
      const parent = n.getParent();
      if (parent && Node.isPropertyAssignment(parent) && parent.getNameNode() === n) continue;
      out.push({ node: n, text: n.getLiteralText() });
    } else if (Node.isTemplateExpression(n)) {
      const parts = [n.getHead().getLiteralText(), ...n.getTemplateSpans().map((s) => s.getLiteral().getLiteralText())];
      out.push({ node: n, text: parts.join(' ') });
    }
  }
  return out;
}

/** The project component a JSX tag renders, through imports; by unique name when the symbol can't be resolved. */
export function resolveComponentTag(tagNode: Node, root: string, byLocation: Map<string, ComponentInfo>, byName: Map<string, ComponentInfo[]>): ComponentInfo | undefined {
  const symbol = tagNode.getSymbol();
  const target = symbol?.isAlias() ? symbol.getAliasedSymbol() : symbol;
  const decl = target?.getDeclarations()[0];
  const declFile = decl ? projectPath(root, decl.getSourceFile().getFilePath()) : null;
  if (decl && declFile) return byLocation.get(`${declFile}:${decl.getStartLineNumber()}`);
  if (decl) return undefined;
  const same = byName.get(tagNode.getText());
  return same?.length === 1 ? same[0] : undefined;
}

export function extractUsage(project: Project, root: string, components: ComponentInfo[]): UsageProfile {
  const byLocation = new Map(components.map((c) => [`${c.file}:${c.line}`, c]));
  const byName = new Map<string, ComponentInfo[]>();
  for (const c of components) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);

  const usage = new Map<string, ComponentUsage>();
  const counts = { spacing: new Map(), radius: new Map(), fontSize: new Map(), color: new Map() } as Record<ClassCategory, Map<string, ClassCount>>;
  const bypasses: TokenBypass[] = [];
  const repeated = new Map<string, RepeatedClassList>();

  const countClasses = (text: string, at: SourceRef) => {
    for (const raw of text.split(/\s+/)) {
      if (!raw) continue;
      const utility = raw.split(':').pop()!.replace(/^!/, '');
      const category = categorizeClass(utility);
      if (!category) continue;
      // Only values a token could hold count as bypasses; layout sizes such as w-[350px] are fine to hardcode.
      if (utility.includes('[')) bypasses.push({ kind: 'arbitrary-class', value: raw, ...at });
      const entry = counts[category].get(utility);
      if (entry) entry.count++;
      else counts[category].set(utility, { value: utility, count: 1, example: at });
    }
  };

  for (const sf of project.getSourceFiles()) {
    const file = projectPath(root, sf.getFilePath());
    if (!file) continue;
    const seen = new Set<number>();
    const elements = [...sf.getDescendantsOfKind(SyntaxKind.JsxOpeningElement), ...sf.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement)];

    for (const el of elements) {
      const tagNode = el.getTagNameNode();
      const tag = tagNode.getText();
      const at = { file, line: el.getStartLineNumber() };

      if (/^[A-Z]/.test(tag)) {
        const comp = resolveComponentTag(tagNode, root, byLocation, byName);
        if (comp) {
          const key = `${comp.file}:${comp.line}`;
          const u = usage.get(key) ?? { component: comp.name, file: comp.file, line: comp.line, uses: 0, sites: [], props: {} };
          u.uses++;
          if (u.sites.length < MAX_SITES) u.sites.push(at);
          for (const attr of el.getAttributes()) {
            if (!Node.isJsxAttribute(attr)) continue;
            const name = attr.getNameNode().getText();
            if (IGNORED_PROPS.has(name)) continue;
            const value = attrValue(attr);
            const values = (u.props[name] ??= {});
            values[value] = (values[value] ?? 0) + 1;
          }
          usage.set(key, u);
        }
      }

      for (const attr of el.getAttributes()) {
        if (!Node.isJsxAttribute(attr)) continue;
        const name = attr.getNameNode().getText();
        const init = attr.getInitializer();
        if (name === 'className') {
          for (const lit of classLiterals(init)) {
            // A variable referenced from several elements is one definition, so count it once.
            if (seen.has(lit.node.getStart())) continue;
            seen.add(lit.node.getStart());
            countClasses(lit.text, { file, line: lit.node.getStartLineNumber() });
          }
          if (init && Node.isStringLiteral(init) && /^[a-z]/.test(tag)) {
            const classes = init.getLiteralText().trim().split(/\s+/).sort().join(' ');
            const key = `${tag}\u0000${classes}`;
            const entry = repeated.get(key) ?? { tag, classes, count: 0, examples: [] };
            entry.count++;
            if (entry.examples.length < 5) entry.examples.push(at);
            repeated.set(key, entry);
          }
        } else if (name === 'style' && init && Node.isJsxExpression(init)) {
          const expr = init.getExpression();
          if (expr && Node.isObjectLiteralExpression(expr)) {
            bypasses.push({ kind: 'inline-style', value: truncate(expr.getText().replace(/\s+/g, ' '), 80), file, line: attr.getStartLineNumber() });
          }
        }
      }
    }

    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (!CLASS_HELPERS.has(call.getExpression().getText())) continue;
      for (const arg of call.getArguments()) {
        for (const lit of classLiterals(arg)) {
          if (seen.has(lit.node.getStart())) continue;
          seen.add(lit.node.getStart());
          countClasses(lit.text, { file, line: lit.node.getStartLineNumber() });
        }
      }
    }
  }

  const sortCounts = (m: Map<string, ClassCount>) =>
    [...m.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, TOP_CLASSES);

  return {
    components: [...usage.values()].sort((a, b) => b.uses - a.uses || a.component.localeCompare(b.component) || a.file.localeCompare(b.file)),
    classes: { spacing: sortCounts(counts.spacing), radius: sortCounts(counts.radius), fontSize: sortCounts(counts.fontSize), color: sortCounts(counts.color) },
    bypasses: bypasses.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.value.localeCompare(b.value)).slice(0, MAX_BYPASSES),
    repeatedClassLists: [...repeated.values()].filter((r) => r.count >= 3).sort((a, b) => b.count - a.count || a.classes.localeCompare(b.classes)),
  };
}
