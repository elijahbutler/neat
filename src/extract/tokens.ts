import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ColorRole, FontRole, RadiusRole } from '../tokens/model';
import type { CssVariable, RoleToken, TokenProfile } from './types';

type ParsedVariable = Omit<CssVariable, 'resolved'>;

const COLOR_NAMES: Record<ColorRole, string[]> = {
  bg: ['background', 'bg', 'canvas', 'paper', 'page'],
  bgElevated: ['card', 'surface', 'elevated', 'popover', 'panel'],
  fg: ['foreground', 'fg', 'ink', 'text'],
  fgMuted: ['muted-foreground', 'ink-muted', 'text-muted', 'fg-muted', 'foreground-muted', 'muted-text', 'subtle'],
  accent: ['primary', 'brand', 'main-color', 'main', 'accent'],
  accentInk: ['primary-foreground', 'brand-ink', 'brand-foreground', 'accent-foreground', 'on-primary'],
  border: ['border', 'rule', 'line', 'divider'],
};
const FONT_NAMES: Record<FontRole, string[]> = {
  display: ['font-display', 'font-heading', 'font-serif'],
  body: ['font-sans', 'font-body'],
  mono: ['font-mono'],
};
const RADIUS_NAMES: Record<RadiusRole, string[]> = {
  control: ['radius-control', 'radius-button', 'radius-md', 'radius-sm', 'radius'],
  surface: ['radius-card', 'radius-surface', 'radius-lg', 'radius-xl'],
  pill: ['radius-pill', 'radius-full'],
};
const MAX_DEPTH = 8;
// Tailwind v4 namespaces that aren't colors. `--text-sm` is a font size, but a bare `--text` is a color.
const NON_COLOR_KEY = /^(font|radius|spacing|shadow|breakpoint|leading|tracking|ease|animate)(-|$)|^text-(xs|sm|base|lg|[0-9]*xl)$/;

/** Custom properties in a stylesheet, with their enclosing selectors/at-rules and line numbers. */
export function parseCssVariables(css: string, file: string): ParsedVariable[] {
  // Blank out comments but keep newlines so line numbers stay correct.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  const out: ParsedVariable[] = [];
  const stack: string[] = [];
  let buf = '';
  let bufStart = 0;

  const flush = () => {
    const m = /^(\s*)(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(buf);
    if (m && stack.length) {
      const line = text.slice(0, bufStart + m[1]!.length).split('\n').length;
      out.push({ name: m[2]!, value: m[3]!.replace(/\s+/g, ' '), scope: stack.join(' > '), file, line });
    }
    buf = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === '{') {
      stack.push(buf.trim().replace(/\s+/g, ' '));
      buf = '';
    } else if (ch === '}') {
      flush();
      stack.pop();
    } else if (ch === ';') {
      flush();
    } else {
      if (buf === '') bufStart = i;
      buf += ch;
    }
  }
  return out;
}

const isDark = (scope: string) => /dark/i.test(scope);

/** Resolves var() references, preferring light-scope declarations. Stops at cycles and after MAX_DEPTH. */
export function resolveVariables(vars: ParsedVariable[]): CssVariable[] {
  const light = new Map<string, string>();
  for (const v of vars) if (!isDark(v.scope) && !light.has(v.name)) light.set(v.name, v.value);
  for (const v of vars) if (!light.has(v.name)) light.set(v.name, v.value);

  const resolve = (value: string, seen: Set<string>, depth: number): string => {
    if (depth > MAX_DEPTH) return value;
    return value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (match, name: string, fallback: string | undefined) => {
      if (seen.has(name)) return match;
      const target = light.get(name);
      if (target === undefined) return fallback !== undefined ? resolve(fallback.trim(), seen, depth + 1) : match;
      return resolve(target, new Set([...seen, name]), depth + 1);
    });
  };

  return vars.map((v) => ({ ...v, resolved: resolve(v.value, new Set([v.name]), 0) }));
}

function pick<R extends string>(names: Record<R, string[]>, lookup: Map<string, CssVariable>): Partial<Record<R, RoleToken>> {
  const out: Partial<Record<R, RoleToken>> = {};
  for (const role of Object.keys(names) as R[]) {
    for (const key of names[role]) {
      const v = lookup.get(key);
      if (v) {
        out[role] = { variable: v.name, value: v.resolved };
        break;
      }
    }
  }
  return out;
}

export function mapRoles(vars: CssVariable[]): TokenProfile {
  const colors = new Map<string, CssVariable>();
  const other = new Map<string, CssVariable>();
  for (const v of vars) {
    if (isDark(v.scope)) continue;
    const key = v.name.slice(2);
    const colorKey = key.replace(/^color-/, '');
    if (!colors.has(colorKey) && (key.startsWith('color-') || !NON_COLOR_KEY.test(key))) colors.set(colorKey, v);
    if (!other.has(key)) other.set(key, v);
  }

  const profile: TokenProfile = {
    variables: vars,
    colors: pick(COLOR_NAMES, colors),
    fonts: pick(FONT_NAMES, other),
    radius: pick(RADIUS_NAMES, other),
    unresolved: [],
  };
  for (const role of Object.keys(COLOR_NAMES)) if (!(role in profile.colors)) profile.unresolved.push(`color.${role}`);
  for (const role of Object.keys(FONT_NAMES)) if (!(role in profile.fonts)) profile.unresolved.push(`font.${role}`);
  for (const role of Object.keys(RADIUS_NAMES)) if (!(role in profile.radius)) profile.unresolved.push(`radius.${role}`);
  profile.unresolved.sort();
  return profile;
}

export function extractTokens(root: string, cssFiles: string[]): TokenProfile {
  const vars = cssFiles.flatMap((file) => parseCssVariables(readFileSync(join(root, file), 'utf8'), file));
  return mapRoles(resolveVariables(vars));
}
