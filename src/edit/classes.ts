// Class-list logic for the property panel: which class sets a property, what the choices are, and which classes to
// replace, add, or remove for a new value. Pure and free of Node imports, so the editor's browser bundle can use it.
import { categorizeClass } from '../extract/classes';
import { tailwindMajor, tokenClass, tokenFamily } from '../extract/token-match';
import type { DesignSystemProfile } from '../extract/types';
import type { EditOperation } from './operations';

export type PropertyId =
  | 'padding' | 'paddingX' | 'paddingY' | 'margin' | 'marginX' | 'marginY' | 'gap'
  | 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'textColor' | 'background' | 'radius';

type OptionKey = 'spacing' | 'margin' | 'fontFamily' | 'fontSize' | 'fontWeight' | 'lineHeight' | 'textColor' | 'background' | 'radius';

interface PropertySpec {
  id: PropertyId;
  label: string;
  group: 'Spacing' | 'Type' | 'Color and shape';
  options: OptionKey;
  /** The utility this control writes, such as `px`. */
  root: string;
  /** Shorthands that also set this property, such as `p` for `px`. They stay; the control's own class overrides them. */
  broader: string[];
  /** More specific utilities that would override this one, such as `pl` for `px`. Setting the control removes them. */
  narrower: string[];
}

const SIDES = ['t', 'r', 'b', 'l', 's', 'e'];
const CORNERS = ['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'bl', 'br', 'ss', 'se', 'es', 'ee'];

export const PROPERTIES: PropertySpec[] = [
  { id: 'padding', label: 'Padding, all sides', group: 'Spacing', options: 'spacing', root: 'p', broader: [], narrower: ['px', 'py', ...SIDES.map((s) => `p${s}`)] },
  { id: 'paddingX', label: 'Padding, left and right', group: 'Spacing', options: 'spacing', root: 'px', broader: ['p'], narrower: ['pl', 'pr', 'ps', 'pe'] },
  { id: 'paddingY', label: 'Padding, top and bottom', group: 'Spacing', options: 'spacing', root: 'py', broader: ['p'], narrower: ['pt', 'pb'] },
  { id: 'margin', label: 'Margin, all sides', group: 'Spacing', options: 'margin', root: 'm', broader: [], narrower: ['mx', 'my', ...SIDES.map((s) => `m${s}`)] },
  { id: 'marginX', label: 'Margin, left and right', group: 'Spacing', options: 'margin', root: 'mx', broader: ['m'], narrower: ['ml', 'mr', 'ms', 'me'] },
  { id: 'marginY', label: 'Margin, top and bottom', group: 'Spacing', options: 'margin', root: 'my', broader: ['m'], narrower: ['mt', 'mb'] },
  { id: 'gap', label: 'Gap between items', group: 'Spacing', options: 'spacing', root: 'gap', broader: [], narrower: ['gap-x', 'gap-y'] },
  { id: 'fontFamily', label: 'Font', group: 'Type', options: 'fontFamily', root: 'font', broader: [], narrower: [] },
  { id: 'fontSize', label: 'Size', group: 'Type', options: 'fontSize', root: 'text', broader: [], narrower: [] },
  { id: 'fontWeight', label: 'Weight', group: 'Type', options: 'fontWeight', root: 'font', broader: [], narrower: [] },
  { id: 'lineHeight', label: 'Line height', group: 'Type', options: 'lineHeight', root: 'leading', broader: [], narrower: [] },
  { id: 'textColor', label: 'Text color', group: 'Color and shape', options: 'textColor', root: 'text', broader: [], narrower: [] },
  { id: 'background', label: 'Background', group: 'Color and shape', options: 'background', root: 'bg', broader: [], narrower: [] },
  { id: 'radius', label: 'Corner radius', group: 'Color and shape', options: 'radius', root: 'rounded', broader: [], narrower: CORNERS.map((c) => `rounded-${c}`) },
];

const spec = (id: PropertyId) => PROPERTIES.find((p) => p.id === id)!;

export interface PanelOption {
  /** What follows the utility's root: `4` in `px-4`, `ink-muted` in `text-ink-muted`. Empty for a bare `rounded`. */
  value: string;
  label: string;
  /** `Tokens` come from the repo's own CSS, `Used in this repo` from its class names, the rest from Tailwind's scale. */
  group: 'Tokens' | 'Used in this repo' | 'Tailwind scale';
  /** A CSS color to show beside a color choice, when the repo defines it. */
  swatch?: string;
}

export type PanelOptions = Record<OptionKey, PanelOption[]>;

const SPACING_SCALE = ['0', 'px', '0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '5', '6', '7', '8', '9', '10', '11', '12', '14', '16', '20', '24', '28', '32', '36', '40', '48', '56', '64', '72', '80', '96'];
const FONT_SIZES: Array<[string, number]> = [['xs', 12], ['sm', 14], ['base', 16], ['lg', 18], ['xl', 20], ['2xl', 24], ['3xl', 30], ['4xl', 36], ['5xl', 48], ['6xl', 60], ['7xl', 72], ['8xl', 96], ['9xl', 128]];
const FONT_WEIGHTS: Array<[string, number]> = [['thin', 100], ['extralight', 200], ['light', 300], ['normal', 400], ['medium', 500], ['semibold', 600], ['bold', 700], ['extrabold', 800], ['black', 900]];
const LINE_HEIGHTS: Array<[string, string]> = [['none', '1'], ['tight', '1.25'], ['snug', '1.375'], ['normal', '1.5'], ['relaxed', '1.625'], ['loose', '2']];
const RADII = ['none', 'xs', 'sm', '', 'md', 'lg', 'xl', '2xl', '3xl', 'full'];
const FONT_FAMILIES = ['sans', 'serif', 'mono'];
const BASIC_COLORS = ['white', 'black', 'transparent'];

const spacingLabel = (value: string) => (value === 'px' ? '1px' : /^\d+(\.\d+)?$/.test(value) ? `${value} · ${Number(value) * 4}px` : value);

/** Options in order, without repeats: a value the repo defines as a token is listed once, as a token. */
function unique(options: PanelOption[]): PanelOption[] {
  const seen = new Set<string>();
  return options.filter((option) => !seen.has(option.value) && Boolean(seen.add(option.value)));
}

/**
 * The choices each control offers for a repo: its own tokens first, then values its code already uses, then
 * Tailwind's scale. Nothing free-form.
 */
export function panelOptions(profile: DesignSystemProfile): PanelOptions {
  const major = tailwindMajor(profile.framework.tailwind);
  const light = profile.tokens.variables.filter((v) => !/dark/i.test(v.scope));
  const themed = light.filter((v) => /@theme/.test(v.scope));
  // Tailwind v4 theme variables such as --radius-card each make a named utility. `--text-lg--line-height` is not a size.
  const named = (namespace: string): PanelOption[] => themed
    .filter((v) => v.name.startsWith(`--${namespace}-`) && !v.name.slice(2).includes('--'))
    .map((v) => ({ value: v.name.slice(namespace.length + 3), label: v.name.slice(namespace.length + 3), group: 'Tokens' as const }));

  const colorVariables = light.filter((v) => tokenFamily(v) === 'color');
  const themeColors = colorVariables.filter((v) => /@theme/.test(v.scope) && v.name.startsWith('--color-'));
  // Without theme colors the repo's plain CSS variables are the tokens, written as bg-(--name).
  const colorTokens: PanelOption[] = (major >= 4 && themeColors.length ? themeColors : colorVariables).map((v) => {
    const value = tokenClass('', 'x', v, major).slice(2);
    return { value, label: v.name.replace(/^--(color-)?/, ''), group: 'Tokens' as const, swatch: v.resolved };
  });
  const usedColors: PanelOption[] = profile.usage.classes.color
    .map((c) => /^(?:bg|text)-([a-z][\w-]*)$/.exec(c.value.split(':').pop()!)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort()
    .map((value) => ({ value, label: value, group: 'Used in this repo' as const }));
  const colors = unique([...colorTokens, ...usedColors, ...BASIC_COLORS.map((value) => ({ value, label: value, group: 'Tailwind scale' as const }))]);

  const usedSpacing: PanelOption[] = profile.usage.classes.spacing
    .map((c) => /^(?:p[xytrblse]?|m[xytrblse]?|gap)-([\w.]+)$/.exec(c.value.split(':').pop()!)?.[1])
    .filter((value): value is string => value !== undefined && value !== 'auto')
    .sort((a, b) => Number(a) - Number(b) || a.localeCompare(b))
    .map((value) => ({ value, label: spacingLabel(value), group: 'Used in this repo' as const }));
  const scale = SPACING_SCALE.map((value) => ({ value, label: spacingLabel(value), group: 'Tailwind scale' as const }));
  // Used values that are on the scale stay in scale order; only off-scale ones are listed separately.
  const spacing = unique([...named('spacing'), ...scale, ...usedSpacing]);

  return {
    spacing,
    margin: unique([...spacing, { value: 'auto', label: 'auto', group: 'Tailwind scale' }]),
    fontFamily: unique([...named('font').filter((o) => !o.value.startsWith('weight-')), ...FONT_FAMILIES.map((value) => ({ value, label: value, group: 'Tailwind scale' as const }))]),
    fontSize: unique([...named('text').filter((o) => !o.value.startsWith('shadow-')), ...FONT_SIZES.map(([value, px]) => ({ value, label: `${value} · ${px}px`, group: 'Tailwind scale' as const }))]),
    fontWeight: unique([...named('font-weight'), ...FONT_WEIGHTS.map(([value, weight]) => ({ value, label: `${value} · ${weight}`, group: 'Tailwind scale' as const }))]),
    lineHeight: unique([...named('leading'), ...LINE_HEIGHTS.map(([value, ratio]) => ({ value, label: `${value} · ${ratio}`, group: 'Tailwind scale' as const }))]),
    textColor: colors,
    background: colors,
    radius: unique([...named('radius'), ...RADII.map((value) => ({ value, label: value || 'default', group: 'Tailwind scale' as const }))]),
  };
}

interface ParsedClass {
  raw: string;
  /** Variant prefixes with their colons, such as `md:hover:`. Empty for a class that always applies. */
  prefix: string;
  /** `!` before or after the utility, kept when the class is replaced. */
  important: '' | 'before' | 'after';
  utility: string;
}

/** Split `md:hover:!px-4` into its variants and utility. Colons inside brackets, as in `bg-[url(a:b)]`, don't count. */
export function parseClass(raw: string): ParsedClass {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === '[' || ch === '(') depth++;
    else if (ch === ']' || ch === ')') depth--;
    else if (ch === ':' && depth === 0) cut = i + 1;
  }
  const rest = raw.slice(cut);
  const important = rest.startsWith('!') ? 'before' : rest.endsWith('!') ? 'after' : '';
  const utility = important === 'before' ? rest.slice(1) : important === 'after' ? rest.slice(0, -1) : rest;
  return { raw, prefix: raw.slice(0, cut), important, utility };
}

// Utilities that share a prefix are told apart by value: `font-` is a weight or a family, `text-` a size or a color,
// `rounded-` a radius or one corner. The repo's own token names decide first, since `font-book` is a weight only in a
// repo whose theme has --font-weight-book.
const isToken = (choices: PanelOption[], value: string) => choices.some((o) => o.group === 'Tokens' && o.value === value);

const isWeight = (value: string, options: PanelOptions) => isToken(options.fontWeight, value) || FONT_WEIGHTS.some(([name]) => name === value) || /^\[\d+\]$/.test(value);

/** A color by the repo's token names, with or without an opacity such as `/90`, or by Tailwind's naming. */
const isColor = (value: string, body: string, options: PanelOptions) => isToken(options.textColor, value.split('/')[0]!) || categorizeClass(body) === 'color';

const CORNER = new RegExp(`^(${CORNERS.join('|')})(-|$)`);

/** `text-` is a size when its value is on the size scale, a theme size, or an arbitrary length; otherwise a color. */
function isFontSize(value: string, options: PanelOptions): boolean {
  const size = value.split('/')[0]!;
  return isToken(options.fontSize, size) || FONT_SIZES.some(([name]) => name === size) || /^\[(length:)?[\d.]/.test(size);
}

/** The value a utility gives one of a property's roots, or null when the utility is something else. */
function valueFor(id: PropertyId, root: string, utility: string, options: PanelOptions): string | null {
  const negative = utility.startsWith('-') && /^m/.test(root);
  const body = negative ? utility.slice(1) : utility;
  // `rounded-s` is the start side, unless the theme has a radius named s. Then it is the whole radius.
  if (id === 'radius' && root !== 'rounded' && isToken(options.radius, body.slice('rounded-'.length))) return null;
  if (id === 'radius' && body === root) return '';
  if (!body.startsWith(`${root}-`)) return null;
  const value = body.slice(root.length + 1);
  if (!value) return null;
  switch (id) {
    case 'gap': return root === 'gap' && /^[xy]-/.test(value) ? null : value;
    case 'radius': return root === 'rounded' && CORNER.test(value) && !isToken(options.radius, value) ? null : value;
    case 'fontSize': return isFontSize(value, options) ? value : null;
    case 'textColor': return !isFontSize(value, options) && isColor(value, body, options) ? value : null;
    case 'background': return isColor(value, body, options) ? value : null;
    case 'fontWeight': return isWeight(value, options) ? value : null;
    case 'fontFamily': return isWeight(value, options) || /^stretch-/.test(value) ? null : value;
    case 'lineHeight': return value;
    default:
      // Padding, margin, and gap. Anything else after the root, as in a hand-written `my-widget`, is not spacing.
      if (!/^(\d+(\.\d+)?|px|auto|\[.+\]|\(.+\))$/.test(value) && !options.spacing.some((o) => o.value === value)) return null;
      return negative ? `-${value}` : value;
  }
}

export interface ResolvedProperty {
  /** The value in effect when no variant applies, or null when no class sets the property. */
  value: string | null;
  /** The class that value comes from. */
  className: string | null;
  /** The value comes from a shorthand such as `p-4`, not from this control's own utility. */
  fromShorthand: boolean;
  /** More specific classes, such as `pl-2` under "left and right", that make the sides differ. */
  overrides: string[];
  /** Classes that set the same property only at a breakpoint or in a state, such as `md:px-8`. Never changed here. */
  conditional: string[];
}

interface Matches {
  exact: ParsedClass[];
  broader: ParsedClass[];
  narrower: ParsedClass[];
  conditional: string[];
}

function matches(classes: string[], id: PropertyId, options: PanelOptions): Matches {
  const property = spec(id);
  const out: Matches = { exact: [], broader: [], narrower: [], conditional: [] };
  // Longer roots first, so `gap-x-4` is read as gap-x and not as gap with the value x-4.
  const roots: Array<[keyof Omit<Matches, 'conditional'>, string]> = [
    ...property.narrower.map((root): ['narrower', string] => ['narrower', root]),
    ['exact', property.root],
    ...property.broader.map((root): ['broader', string] => ['broader', root]),
  ];
  roots.sort((a, b) => b[1].length - a[1].length);
  for (const raw of classes) {
    const parsed = parseClass(raw);
    const hit = roots.find(([, root]) => valueFor(id, root, parsed.utility, options) !== null);
    if (!hit) continue;
    if (parsed.prefix) out.conditional.push(raw);
    else out[hit[0]].push(parsed);
  }
  return out;
}

/** The class in a list that takes effect: an important one (`!p-4` or `p-4!`) beats the rest, then the last one. */
const winner = (list: ParsedClass[]) => list.filter((c) => c.important).at(-1) ?? list.at(-1);

/** What a class list sets for one property. Classes behind a variant are reported, not counted. */
export function resolveProperty(classes: string[], id: PropertyId, options: PanelOptions): ResolvedProperty {
  const found = matches(classes, id, options);
  const own = winner(found.exact);
  const shorthand = winner(found.broader);
  // An important shorthand beats a plain class of the control's own: in `!p-4 px-2` the sides are 4, not 2.
  const source = (shorthand?.important && !own?.important ? shorthand : own ?? shorthand) ?? null;
  const root = source ? [spec(id).root, ...spec(id).broader].find((r) => valueFor(id, r, source.utility, options) !== null)! : null;
  return {
    value: source && root ? valueFor(id, root, source.utility, options) : null,
    className: source?.raw ?? null,
    fromShorthand: source !== null && source === shorthand,
    overrides: found.narrower.map((c) => c.raw),
    conditional: found.conditional,
  };
}

/** The class a control writes for a value: `px-4`, `-mx-2`, `rounded` for the default radius. */
export function classFor(id: PropertyId, value: string): string {
  const { root } = spec(id);
  if (value === '') return root;
  return value.startsWith('-') ? `-${root}-${value.slice(1)}` : `${root}-${value}`;
}

/** One step of a change to a class list. An empty `from` adds `to`; an empty `to` removes `from`. */
export interface ClassChange {
  from: string;
  to: string;
}

/**
 * The steps that give a property a new value, or clear it when `value` is null. The control's own class is replaced
 * when there is one and added when there isn't. More specific classes that would override it are removed. Shorthands
 * and classes behind a variant (`md:`, `hover:`) are left alone. Under an important shorthand such as `!p-4` the
 * class is written important too, in the same form, because a plain `px-6` would lose to it and change nothing.
 */
export function changeProperty(classes: string[], id: PropertyId, value: string | null, options: PanelOptions): ClassChange[] {
  const found = matches(classes, id, options);
  const changes: ClassChange[] = [];
  const remove = (parsed: ParsedClass) => { if (!changes.some((c) => c.from === parsed.raw)) changes.push({ from: parsed.raw, to: '' }); };
  const own = winner(found.exact);

  if (value !== null) {
    const shorthand = winner(found.broader);
    const gives = shorthand !== undefined && spec(id).broader.some((root) => valueFor(id, root, shorthand.utility, options) === value);
    // The shorthand's value shows once the control's own class is gone, unless that class is the important one.
    const covered = gives && (Boolean(shorthand?.important) || !own?.important);
    const next = classFor(id, value);
    const important = own?.important || shorthand?.important || '';
    const written = important === 'before' ? `!${next}` : important === 'after' ? `${next}!` : next;
    // A shorthand that already gives this value needs no class of its own: `p-4 px-2` set to 4 becomes `p-4`.
    if (covered) { if (own) remove(own); }
    else if (own && own.raw !== written) changes.push({ from: own.raw, to: written });
    else if (!own) changes.push({ from: '', to: written });
  } else if (own) {
    remove(own);
  }
  // Repeats of the control's own utility, and anything more specific, would still win over the new class.
  for (const parsed of found.exact) if (parsed !== own) remove(parsed);
  for (const parsed of found.narrower) remove(parsed);
  return changes;
}

/** Class changes as edit operations on one element. */
export function classOperations(target: string, changes: ClassChange[]): EditOperation[] {
  return changes.map((change) => ({ op: 'replace-class', target, from: change.from, to: change.to }));
}

/** A plain-words title for the change, used on the review card and as the commit message. */
export function changeLabel(id: PropertyId, before: string | null, value: string | null): string {
  const name = spec(id).label;
  const show = (v: string) => v || 'default';
  if (value === null) return `${name}: removed`;
  return before === null ? `${name}: set to ${show(value)}` : `${name}: ${show(before)} to ${show(value)}`;
}
