import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractComponents } from './components';
import { listSourceFiles, loadProject, projectPath } from './project';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neat-components-'));
  const files: Record<string, string> = {
    'components/badge.tsx': `
const tones = { info: 'bg-blue-100', warn: 'bg-amber-100' } as const;
export function Badge({ tone = 'info', label }: { tone?: keyof typeof tones; label: string }) {
  return <span className={tones[tone]}>{label}</span>;
}
function helper() { return 1; }
export const lowercase = () => <div />;
`,
    'components/pill.tsx': `
import { forwardRef } from 'react';
const Pill = forwardRef<HTMLSpanElement, { text: string }>(function Pill({ text }, ref) {
  return <span ref={ref}>{text}</span>;
});
export { Pill };
`,
    'components/hero-banner.tsx': `export default function ({ title }: { title: string }) { return <h1>{title}</h1>; }\n`,
    'components/legacy.jsx': `export function Legacy({ heading, size = 'lg' }) { return <h2>{heading}</h2>; }\n`,
    'components/local.tsx': `function Internal() { return <p />; }\nexport const Uses = () => <Internal />;\n`,
    'app/page.tsx': `'use client';\nexport default function Home() { return <main />; }\n`,
    'app/layout.tsx': `export default function RootLayout({ children }: { children: unknown }) { return <html>{children as never}</html>; }\n`,
    'lib/util.ts': 'export const x = 1;\n',
    'components/memo.tsx': "import { memo } from 'react';\nfunction CardImpl({ title }: { title: string }) { return <h3>{title}</h3>; }\nexport const Card = memo(CardImpl);\n",
    'components/commented.tsx': "/* License header */\n'use client';\nexport function Commented() { return <i />; }\n",
    'app/loading.tsx': 'export default function Loading() { return <p>Loading</p>; }\n',
    'app/page.js': 'export function Plain() { return <p />; }\n',
    'node_modules/pkg/index.tsx': 'export function Hidden() { return <div />; }\n',
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', allowJs: true, strict: true } }));
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe('project helpers', () => {
  test('lists source files outside node_modules', () => {
    const files = listSourceFiles(root).map((f) => projectPath(root, f));
    expect(files).toContain('components/legacy.jsx');
    expect(files).toContain('lib/util.ts');
    expect(files.some((f) => f?.includes('node_modules'))).toBe(false);
  });
});

describe('extractComponents', () => {
  const byName = () => new Map(extractComponents(loadProject(root), root).map((c) => [c.name, c]));

  test('finds PascalCase functions that render JSX, and nothing else', () => {
    const names = [...byName().keys()].sort();
    expect(names).toEqual(['Badge', 'Card', 'CardImpl', 'Commented', 'HeroBanner', 'Home', 'Internal', 'Legacy', 'Loading', 'Pill', 'Plain', 'RootLayout', 'Uses']);
  });

  test('reads props, optionality, defaults, and union variants', () => {
    const badge = byName().get('Badge')!;
    expect(badge.props).toEqual([
      { name: 'label', type: 'string', optional: false },
      { name: 'tone', type: '"info" | "warn"', optional: true, defaultValue: "'info'" },
    ]);
    expect(badge.variants).toEqual([{ prop: 'tone', options: ['info', 'warn'], defaultValue: 'info' }]);
  });

  test('unwraps forwardRef and follows export lists', () => {
    const pill = byName().get('Pill')!;
    expect(pill.exported).toBe(true);
    expect(pill.props.map((p) => p.name)).toEqual(['text']);
  });

  test('names anonymous default exports after the file', () => {
    expect(byName().get('HeroBanner')?.exported).toBe(true);
  });

  test('falls back to destructured names for untyped JavaScript', () => {
    expect(byName().get('Legacy')?.props).toEqual([
      { name: 'heading', type: 'unknown', optional: true },
      { name: 'size', type: 'unknown', optional: true, defaultValue: "'lg'" },
    ]);
  });

  test('follows memo(Identifier) to the wrapped function', () => {
    const card = byName().get('Card')!;
    expect(card.exported).toBe(true);
    expect(card.props.map((p) => p.name)).toEqual(['title']);
  });

  test('finds use client after a leading comment and classifies special route files', () => {
    const all = byName();
    expect(all.get('Commented')?.client).toBe(true);
    expect(all.get('Loading')?.kind).toBe('route');
  });

  test('marks routes, client files, and unexported components', () => {
    const all = byName();
    expect(all.get('Home')).toMatchObject({ kind: 'page', client: true });
    expect(all.get('RootLayout')?.kind).toBe('layout');
    expect(all.get('Internal')?.exported).toBe(false);
  });
});
