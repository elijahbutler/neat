import { beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractDesignSystem } from './profile';
import type { DesignSystemProfile } from './types';

const FIXTURES = ['acme-analytics', 'orbit-studio', 'messy-market'] as const;
const repoRoot = join(import.meta.dir, '..', '..');
const profiles = new Map<string, DesignSystemProfile>();

beforeAll(() => {
  for (const name of FIXTURES) {
    const dir = join(repoRoot, 'fixtures', name);
    if (!existsSync(join(dir, 'node_modules'))) throw new Error(`fixtures/${name} has no node_modules. Run: bun run fixtures:install`);
    profiles.set(name, extractDesignSystem(dir));
  }
}, 120_000);

const get = (name: (typeof FIXTURES)[number]) => profiles.get(name)!;
const component = (name: (typeof FIXTURES)[number], component: string) => get(name).components.find((c) => c.name === component);

describe('golden profiles', () => {
  test.each([...FIXTURES])('%s matches its golden file', (name) => {
    const path = join(import.meta.dir, '__golden__', `${name}.json`);
    const actual = JSON.parse(JSON.stringify(get(name))) as DesignSystemProfile;
    if (process.env.UPDATE_GOLDEN) writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`);
    expect(actual).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});

describe('acme-analytics', () => {
  test('reads cva variants with defaults', () => {
    expect(component('acme-analytics', 'Button')?.variants).toEqual([
      { prop: 'size', options: ['default', 'icon', 'lg', 'sm'], defaultValue: 'default' },
      { prop: 'variant', options: ['default', 'ghost', 'link', 'outline', 'secondary'], defaultValue: 'default' },
    ]);
  });

  test('lists only project props, not HTML attributes', () => {
    expect(component('acme-analytics', 'Button')?.props.map((p) => p.name)).toEqual(['size', 'variant']);
  });

  test('records the UI libraries it depends on', () => {
    expect(get('acme-analytics').uiLibraries).toEqual(['class-variance-authority', 'clsx', 'tailwind-merge']);
  });

  test('maps shadcn tokens and finds the client component', () => {
    expect(get('acme-analytics').tokens.colors.accent?.variable).toBe('--primary');
    expect(component('acme-analytics', 'BillingToggle')?.client).toBe(true);
  });

  test('counts Button across pages and components', () => {
    const button = get('acme-analytics').usage.components.find((u) => u.component === 'Button')!;
    expect(button.uses).toBe(9);
  });
});

describe('orbit-studio', () => {
  test('reads object-map variants through forwardRef', () => {
    expect(component('orbit-studio', 'Button')?.variants).toEqual([{ prop: 'intent', options: ['primary', 'quiet'], defaultValue: 'primary' }]);
  });

  test('reads cva on a default export', () => {
    expect(component('orbit-studio', 'Tag')?.variants).toEqual([{ prop: 'tone', options: ['brand', 'neutral'], defaultValue: 'neutral' }]);
  });

  test('maps custom @theme names and reports gaps', () => {
    const { tokens } = get('orbit-studio');
    expect(tokens.colors.bg?.variable).toBe('--color-paper');
    expect(tokens.fonts.display?.variable).toBe('--font-display');
    expect(tokens.unresolved).toContain('radius.control');
  });
});

describe('messy-market', () => {
  test('flags the duplicate ProductCard and the repeated button classes', () => {
    const ids = get('messy-market').facts.map((f) => f.id);
    expect(ids).toContain('duplicate:ProductCard');
    expect(ids.some((id) => id.startsWith('repeated:button:'))).toBe(true);
  });

  test('records inline styles and arbitrary values', () => {
    const kinds = new Set(get('messy-market').usage.bypasses.map((b) => b.kind));
    expect(kinds).toEqual(new Set(['arbitrary-class', 'inline-style']));
  });

  test('names the anonymous default export and reads the .jsx component', () => {
    expect(component('messy-market', 'PromoBanner')?.exported).toBe(true);
    expect(component('messy-market', 'LegacyBanner')?.props.map((p) => p.name)).toEqual(['subtitle', 'title']);
  });

  test('has no warnings', () => {
    expect(get('messy-market').warnings).toEqual([]);
  });
});
