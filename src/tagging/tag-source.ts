declare const NEAT_LEGACY_LAYOUT: string[];
import { posix } from 'node:path';
import { parse } from '@babel/parser';
import MagicString, { type SourceMap } from 'magic-string';

export const SRC_ATTR = 'data-nl-src';
export const INST_ATTR = 'data-nl-inst';

export interface TagResult {
  code: string;
  /** Elements tagged. Zero when the file has no JSX or doesn't parse. */
  tagged: number;
  map: SourceMap | null;
}

interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start: { line: number; column: number } } | null;
  [key: string]: unknown;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments']);

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as AstNode).type === 'string';
}

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit);
    } else if (isNode(value)) {
      walk(value, visit);
    }
  }
}

function elementName(node: AstNode): string {
  if (node.type === 'JSXIdentifier') return String(node.name);
  if (node.type === 'JSXMemberExpression' && isNode(node.object) && isNode(node.property)) {
    return `${elementName(node.object)}.${elementName(node.property)}`;
  }
  if (node.type === 'JSXNamespacedName' && isNode(node.namespace) && isNode(node.name)) {
    return `${elementName(node.namespace)}:${elementName(node.name)}`;
  }
  return '';
}

function hasTag(attributes: unknown): boolean {
  if (!Array.isArray(attributes)) return false;
  return attributes.some(
    (a) => isNode(a) && a.type === 'JSXAttribute' && isNode(a.name) && (a.name.name === SRC_ATTR || a.name.name === INST_ATTR),
  );
}

/**
 * Adds data-nl-src (host elements) or data-nl-inst (component elements) to every JSX opening
 * element. Only inserts text, so line numbers and the rest of the file are unchanged.
 */
export function tagSource(source: string, relativePath: string): TagResult {
  let program: AstNode;
  try {
    // Only parse TypeScript syntax in TypeScript files; the TS plugin can misread some valid JavaScript.
    const plugins: ('typescript' | 'jsx')[] = /\.tsx?$/.test(relativePath) ? ['typescript', 'jsx'] : ['jsx'];
    program = parse(source, { sourceType: relativePath.endsWith('.cjs') ? 'commonjs' : 'unambiguous', plugins }).program as unknown as AstNode;
  } catch {
    return { code: source, tagged: 0, map: null };
  }

  const s = new MagicString(source);
  const legacyLayout = typeof NEAT_LEGACY_LAYOUT !== 'undefined' && NEAT_LEGACY_LAYOUT.includes(relativePath);
  if (legacyLayout) {
    // Append in memory so directive prologues and original source positions stay intact.
    const app = relativePath.startsWith('src/') ? 'src/app' : 'app';
    const client = posix.relative(posix.dirname(relativePath), `${app}/neat-client.js`);
    s.append(`\nimport '${client.startsWith('.') ? client : './' + client}';\n`);
  }
  let tagged = 0;
  walk(program, (node) => {
    if (node.type !== 'JSXOpeningElement' || !isNode(node.name) || !node.loc) return;
    const name = elementName(node.name);
    if (!name || name === 'Fragment' || name.endsWith('.Fragment') || hasTag(node.attributes)) return;

    const host = node.name.type !== 'JSXMemberExpression' && /^[a-z]/.test(name);
    const typeArgs = isNode(node.typeArguments) ? node.typeArguments : isNode(node.typeParameters) ? node.typeParameters : null;
    const insertAt = (typeArgs ?? node.name).end;
    if (typeof insertAt !== 'number') return;

    const value = `${relativePath}:${node.loc.start.line}:${node.loc.start.column + 1}`;
    s.appendLeft(insertAt, ` ${host ? SRC_ATTR : INST_ATTR}={${JSON.stringify(value)}}`);
    tagged++;
  });

  if (tagged === 0 && !legacyLayout) return { code: source, tagged: 0, map: null };
  return { code: s.toString(), tagged, map: s.generateMap({ hires: true, source: relativePath, includeContent: true }) };
}
