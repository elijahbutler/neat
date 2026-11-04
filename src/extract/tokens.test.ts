import { describe, expect, test } from 'bun:test';
import { mapRoles, parseCssVariables, resolveVariables } from './tokens';

const css = `@import "tailwindcss";
/* a comment with { braces } and --fake: 1; */
:root {
  --background: #fff;
  --primary: oklch(0.5 0.2 260);
  --primary-foreground: #fafafa;
  --radius: 0.5rem;
}
.dark {
  --background: #000;
}
@theme inline {
  --color-background: var(--background);
  --radius-md: calc(var(--radius) - 2px);
  --font-sans: ui-sans-serif, system-ui;
}
`;

describe('parseCssVariables', () => {
  test('reads custom properties with scope and line, skipping comments', () => {
    const vars = parseCssVariables(css, 'app/globals.css');
    expect(vars.map((v) => `${v.scope}|${v.name}|${v.line}`)).toEqual([
      ':root|--background|4',
      ':root|--primary|5',
      ':root|--primary-foreground|6',
      ':root|--radius|7',
      '.dark|--background|10',
      '@theme inline|--color-background|13',
      '@theme inline|--radius-md|14',
      '@theme inline|--font-sans|15',
    ]);
    expect(vars[1]!.value).toBe('oklch(0.5 0.2 260)');
  });
});

describe('resolveVariables', () => {
  test('resolves var() references using light-scope values', () => {
    const vars = resolveVariables(parseCssVariables(css, 'app/globals.css'));
    expect(vars.find((v) => v.name === '--color-background')!.resolved).toBe('#fff');
    expect(vars.find((v) => v.name === '--radius-md')!.resolved).toBe('calc(0.5rem - 2px)');
  });

  test('uses the fallback for unknown variables', () => {
    const [v] = resolveVariables(parseCssVariables(':root { --a: var(--missing, 4px); }', 'x.css'));
    expect(v!.resolved).toBe('4px');
  });

  // Review focus 5: cycles must stop.
  test('stops on reference cycles', () => {
    const vars = resolveVariables(parseCssVariables(':root { --a: var(--b); --b: var(--a); }', 'x.css'));
    expect(vars.map((v) => v.resolved)).toEqual(['var(--a)', 'var(--b)']);
  });
});

describe('mapRoles', () => {
  test('maps shadcn-style names and reports gaps', () => {
    const profile = mapRoles(resolveVariables(parseCssVariables(css, 'app/globals.css')));
    expect(profile.colors.bg).toEqual({ variable: '--background', value: '#fff' });
    expect(profile.colors.accent).toEqual({ variable: '--primary', value: 'oklch(0.5 0.2 260)' });
    expect(profile.colors.accentInk?.variable).toBe('--primary-foreground');
    expect(profile.radius.control).toEqual({ variable: '--radius-md', value: 'calc(0.5rem - 2px)' });
    expect(profile.fonts.body?.variable).toBe('--font-sans');
    expect(profile.unresolved).toEqual(['color.bgElevated', 'color.border', 'color.fg', 'color.fgMuted', 'font.display', 'font.mono', 'radius.pill', 'radius.surface']);
  });

  test('maps custom @theme names', () => {
    const custom = '@theme { --color-paper: #f7f4ee; --color-ink: #111; --color-ink-muted: #555; --color-brand: #e4572e; --color-brand-ink: #fff; --color-rule: #ddd; --radius-card: 1rem; }';
    const profile = mapRoles(resolveVariables(parseCssVariables(custom, 'g.css')));
    expect(profile.colors).toMatchObject({
      bg: { variable: '--color-paper' },
      fg: { variable: '--color-ink' },
      fgMuted: { variable: '--color-ink-muted' },
      accent: { variable: '--color-brand' },
      accentInk: { variable: '--color-brand-ink' },
      border: { variable: '--color-rule' },
    });
    expect(profile.radius.surface?.variable).toBe('--radius-card');
  });
});
