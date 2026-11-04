import type { CssVariable, TokenProfile } from './types';

export type TokenFamily = 'color' | 'radius';

const COLOR_UTILITY = /^(bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|shadow)$/;

/** Lowercase, collapse whitespace, and expand #abc / #abcd to six or eight digits so equal colors compare equal. */
export function normalizeValue(value: string): string {
  const v = value.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*,\s*/g, ',');
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/.exec(v);
  if (!short) return v;
  return `#${short.slice(1).filter(Boolean).map((c) => c + c).join('')}`;
}

/** Whether a CSS variable holds a color or a radius, judged by its name and resolved value. */
export function tokenFamily(variable: CssVariable): TokenFamily | null {
  const name = variable.name.slice(2);
  if (/^radius(-|$)/.test(name)) return 'radius';
  if (/^(#|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\()/.test(normalizeValue(variable.resolved))) return 'color';
  return null;
}

/**
 * The variable whose resolved light value equals `value`, if exactly one does. Tailwind v4 `@theme` variables win over
 * plain ones they alias, because they have a named utility. Two different candidates at the same level mean the value
 * has more than one role, so there is no answer.
 */
export function findToken(tokens: TokenProfile, value: string, want: TokenFamily): CssVariable | null {
  const target = normalizeValue(value);
  const matches = tokens.variables.filter((v) => !/dark/i.test(v.scope) && tokenFamily(v) === want && normalizeValue(v.resolved) === target);
  const themed = matches.filter(isThemeVariable);
  const best = themed.length ? themed : matches;
  return new Set(best.map((v) => v.name)).size === 1 ? best[0]! : null;
}

function isThemeVariable(v: CssVariable): boolean {
  return /^--(color|radius)-/.test(v.name) && /@theme/.test(v.scope);
}

/** Split an arbitrary Tailwind utility such as `hover:bg-[#0a7d5a]` into its parts, or null. */
export function parseArbitrary(raw: string): { prefix: string; utility: string; value: string; family: TokenFamily } | null {
  const m = /^((?:[^:\s]+:)*!?)([a-z]+)-\[(.+)\]$/.exec(raw);
  if (!m) return null;
  const [, prefix, utility, value] = m;
  if (utility === 'rounded') return { prefix: prefix!, utility, value: value!, family: 'radius' };
  if (COLOR_UTILITY.test(utility!) && !/^(length|number|url):/.test(value!)) {
    return { prefix: prefix!, utility: utility!, value: value!.replace(/^color:/, ''), family: 'color' };
  }
  return null;
}

/** The Tailwind class that uses `variable` in place of an arbitrary value. */
export function tokenClass(prefix: string, utility: string, variable: CssVariable, tailwindMajor: number): string {
  // Only Tailwind v4 `@theme` variables generate a named utility such as `bg-brand`.
  const named = tailwindMajor >= 4 && /@theme/.test(variable.scope) ? /^--(?:color|radius)-(.+)$/.exec(variable.name) : null;
  if (named) return `${prefix}${utility}-${named[1]}`;
  return tailwindMajor >= 4 ? `${prefix}${utility}-(${variable.name})` : `${prefix}${utility}-[var(${variable.name})]`;
}

export function tailwindMajor(version: string | null): number {
  const m = /(\d+)/.exec(version ?? '');
  return m ? Number(m[1]) : 4;
}

/** Replace arbitrary color and radius classes that equal a token. Returns the new class string and what changed. */
export function substituteTokens(classes: string, tokens: TokenProfile, major: number): { classes: string; replaced: Array<{ from: string; to: string }> } {
  const replaced: Array<{ from: string; to: string }> = [];
  const out = classes.replace(/\S+/g, (raw) => {
    const parsed = parseArbitrary(raw);
    if (!parsed) return raw;
    const token = findToken(tokens, parsed.value, parsed.family);
    if (!token) return raw;
    const to = tokenClass(parsed.prefix, parsed.utility, token, major);
    replaced.push({ from: raw, to });
    return to;
  });
  return { classes: out, replaced };
}

/** Hex colors inside an inline style snippet, for linking inline styles to tokens. */
export function hexColors(text: string): string[] {
  return text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
}
