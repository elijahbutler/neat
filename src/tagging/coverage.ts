import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { HTMLElement, NodeType, parse } from 'node-html-parser';
import { INST_ATTR, SRC_ATTR } from './tag-source';

const IGNORED = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta', 'title', 'next-route-announcer']);
const COMPONENT_START = /^<([A-Z_$][\w$]*(\.[\w$]+)*|[a-z_$][\w$]*(\.[\w$]+)+)[\s/>]/;

export interface TagLocation {
  file: string;
  line: number;
  column: number;
}

export interface CoverageReport {
  elements: number;
  /** Elements carrying their own data-nl-src. */
  direct: number;
  /** Elements without a tag whose ancestor has one, e.g. markup rendered inside node_modules. */
  inherited: number;
  untagged: number;
  invalidSrc: string[];
  instances: number;
  invalidInst: string[];
  inheritedByTag: Record<string, number>;
}

export type LineReader = (file: string, line: number) => string | undefined;

export function parseTagLocation(value: string): TagLocation | null {
  const match = /^(.*):(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  return { file: match[1]!, line: Number(match[2]), column: Number(match[3]) };
}

function sourceAt(read: LineReader, value: string): string | undefined {
  const loc = parseTagLocation(value);
  return loc ? read(loc.file, loc.line)?.slice(loc.column - 1) : undefined;
}

function nearestSrc(el: HTMLElement | null): string | undefined {
  for (let node: HTMLElement | null = el; node; node = node.parentNode) {
    const src = node.getAttribute?.(SRC_ATTR);
    if (src) return src;
  }
  return undefined;
}

function bodyOf(html: string): HTMLElement | null {
  return parse(html).querySelector('body');
}

export function checkTags(html: string, read: LineReader): CoverageReport {
  const report: CoverageReport = { elements: 0, direct: 0, inherited: 0, untagged: 0, invalidSrc: [], instances: 0, invalidInst: [], inheritedByTag: {} };
  const body = bodyOf(html);
  if (!body) return report;

  for (const el of body.querySelectorAll('*')) {
    const tag = el.rawTagName.toLowerCase();
    if (IGNORED.has(tag)) continue;
    report.elements++;

    const src = el.getAttribute(SRC_ATTR);
    if (src) {
      report.direct++;
      const code = sourceAt(read, src);
      if (!code || !new RegExp(`^<${tag}[\\s/>]`, 'i').test(code)) report.invalidSrc.push(`${tag} -> ${src}`);
    } else if (nearestSrc(el.parentNode)) {
      report.inherited++;
      report.inheritedByTag[tag] = (report.inheritedByTag[tag] ?? 0) + 1;
    } else {
      report.untagged++;
    }

    const inst = el.getAttribute(INST_ATTR);
    if (inst) {
      report.instances++;
      const code = sourceAt(read, inst);
      if (!code || !COMPONENT_START.test(code)) report.invalidInst.push(`${tag} -> ${inst}`);
    }
  }
  return report;
}

/** The nearest data-nl-src for the first element whose own text contains `text`. */
export function findTagForText(html: string, text: string): string | undefined {
  const body = bodyOf(html);
  if (!body) return undefined;
  for (const el of [body, ...body.querySelectorAll('*')]) {
    if (el.childNodes.some((n) => n.nodeType === NodeType.TEXT_NODE && n.rawText.includes(text))) return nearestSrc(el);
  }
  return undefined;
}

/** Static App Router routes: skips dynamic segments, private folders, parallel slots; drops route groups. */
export async function listStaticRoutes(appDir: string): Promise<string[]> {
  const routes: string[] = [];
  async function visit(dir: string, segments: string[]): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = entry.name;
      if (entry.isDirectory()) {
        if (name.startsWith('_') || name.startsWith('@') || name.includes('[')) continue;
        await visit(join(dir, name), /^\(.*\)$/.test(name) ? segments : [...segments, name]);
      } else if (/^page\.(tsx|jsx|ts|js)$/.test(name)) {
        routes.push(`/${segments.join('/')}`);
      }
    }
  }
  await visit(appDir, []);
  return routes.sort();
}
