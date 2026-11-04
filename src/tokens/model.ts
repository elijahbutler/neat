/**
 * Normalized brand token model.
 *
 * Every renderer, export, and MCP response should read brand values from this
 * model rather than from raw catalogue files. Each token records where its
 * value came from so consumers can distinguish mapped brand values from
 * derived or fallback values.
 */

export type ColorRole = 'bg' | 'bgElevated' | 'fg' | 'fgMuted' | 'accent' | 'accentInk' | 'border';
export type FontRole = 'display' | 'body' | 'mono';
export type RadiusRole = 'control' | 'surface' | 'pill';

/**
 * - `role`: matched from the brand's documented usage description.
 * - `surface`: matched from the brand's surface ladder.
 * - `luminance`: chosen from brand colors by lightness or saturation, without a documented role.
 * - `contrast`: computed pairing against another resolved brand color (accent ink).
 * - `derived`: computed from resolved brand colors because nothing mapped.
 * - `fallback`: generic value; the brand supplied nothing usable.
 */
export type TokenSource = 'role' | 'surface' | 'luminance' | 'contrast' | 'derived' | 'fallback';

export interface ResolvedToken {
  value: string;
  source: TokenSource;
  /** Name of the brand entry the value came from, when one exists. */
  from?: string;
}

export interface ResolvedFont extends ResolvedToken {
  /** First family name only, without the fallback stack. */
  family: string;
  /** True when the brand documented a full CSS stack and `value` is that stack verbatim. */
  documentedStack?: boolean;
}

export interface UnresolvedToken {
  token: string;
  /** Any source other than a documented role or surface mapping. */
  source: Exclude<TokenSource, 'role' | 'surface'>;
  note: string;
}

export interface BrandTokens {
  slug: string;
  brand: string;
  theme: 'light' | 'dark';
  colors: Record<ColorRole, ResolvedToken>;
  fonts: Record<FontRole, ResolvedFont>;
  radius: Record<RadiusRole, ResolvedToken>;
  /**
   * Tokens that are not documented brand mappings: heuristic picks, computed
   * values, and generic fallbacks. Empty when every role mapped from data.
   *
   * Deliberate exceptions to one-color-per-role: `accentInk` normally reuses the
   * background or foreground (ink on a filled control), and monochrome brands
   * reuse the foreground as `accent`; the latter is always listed here.
   */
  unresolved: UnresolvedToken[];
}

export const COLOR_VARIABLES: Record<ColorRole, string> = {
  bg: '--color-bg',
  bgElevated: '--color-bg-elevated',
  fg: '--color-fg',
  fgMuted: '--color-fg-muted',
  accent: '--color-accent',
  accentInk: '--color-accent-ink',
  border: '--color-border',
};

export const FONT_VARIABLES: Record<FontRole, string> = {
  display: '--font-display',
  body: '--font-body',
  mono: '--font-mono',
};

export const RADIUS_VARIABLES: Record<RadiusRole, string> = {
  control: '--radius-control',
  surface: '--radius-surface',
  pill: '--radius-pill',
};

/** Names the component templates use for the same roles. */
export const TEMPLATE_ALIASES: Record<string, string> = {
  '--color-paper': '--color-bg',
  '--color-ink': '--color-fg',
  '--color-muted': '--color-fg-muted',
  '--color-rule': '--color-border',
  '--radius': '--radius-control',
  '--font-family-primary': '--font-body',
};

/** Renders the full `:root` block with every role, alias, and provenance note. */
export function renderThemeCss(tokens: BrandTokens): string {
  const lines = [`/* ${tokens.brand} (${tokens.theme}) — normalized brand tokens */`, ':root {'];
  const emit = (name: string, token: ResolvedToken) => {
    const note = token.from ? ` /* ${token.source}: ${token.from} */` : ` /* ${token.source} */`;
    lines.push(`  ${name}: ${token.value};${note}`);
  };
  for (const role of Object.keys(COLOR_VARIABLES) as ColorRole[]) emit(COLOR_VARIABLES[role], tokens.colors[role]);
  for (const role of Object.keys(FONT_VARIABLES) as FontRole[]) emit(FONT_VARIABLES[role], tokens.fonts[role]);
  for (const role of Object.keys(RADIUS_VARIABLES) as RadiusRole[]) emit(RADIUS_VARIABLES[role], tokens.radius[role]);
  lines.push('', '  /* Aliases used by component templates */');
  for (const [alias, target] of Object.entries(TEMPLATE_ALIASES)) lines.push(`  ${alias}: var(${target});`);
  lines.push('}');
  if (tokens.unresolved.length > 0) {
    lines.push('', '/* Not authentic brand mappings:');
    for (const item of tokens.unresolved) lines.push(` *   ${item.token} (${item.source}): ${item.note}`);
    lines.push(' */');
  }
  return lines.join('\n') + '\n';
}
