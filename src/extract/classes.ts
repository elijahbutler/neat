import type { ClassCategory } from './types';

const SPACING = /^-?(p[xytrblse]?|m[xytrblse]?|gap(-[xy])?|space-[xy])-/;
const FONT_SIZE = /^text-(xs|sm|base|lg|xl|[2-9]xl)(\/\S+)?$/;
const COLOR = /^(bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|caret|accent|shadow)-(.+)$/;
const NOT_COLOR = new Set([
  'left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip',
  'none', 'solid', 'dashed', 'dotted', 'double', 'hidden', 'collapse', 'separate', 'cover', 'contain', 'fixed',
  'local', 'scroll', 'repeat', 'no-repeat', 'auto', 'inset', 'inner', 'x', 'y', 't', 'b', 'l', 'r', 's', 'e',
  'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'top', 'bottom',
]);

/** Which token family a Tailwind utility (without variant prefixes) draws from, if any. */
export function categorizeClass(utility: string): ClassCategory | null {
  if (SPACING.test(utility)) return 'spacing';
  if (/^rounded(-|$)/.test(utility)) return 'radius';
  if (FONT_SIZE.test(utility)) return 'fontSize';

  const arbitrary = /^([a-z]+)-\[(.+)\]$/.exec(utility);
  if (arbitrary) {
    const [, prefix, value] = arbitrary;
    if (prefix === 'text' && /^\d/.test(value!)) return 'fontSize';
    if (/^(#|rgb|hsl|oklch|color:)/.test(value!) && COLOR.test(utility)) return 'color';
    return null;
  }

  const color = COLOR.exec(utility);
  if (!color) return null;
  const rest = color[2]!;
  if (NOT_COLOR.has(rest) || /^\d/.test(rest) || /^(opacity|offset|gradient|linear|radial|clip|origin|blend|size|position)(-|$)/.test(rest) || /^[xytrblse]-/.test(rest)) return null;
  return 'color';
}
