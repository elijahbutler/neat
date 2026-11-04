import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractComponents } from './components';
import { buildFacts } from './facts';
import { loadProject } from './project';
import { extractUsage } from './usage';

let root = '';
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'neat-usage-'));
  const files: Record<string, string> = {
    'components/button.tsx': `
export function Button({ tone = 'solid', children }: { tone?: 'solid' | 'ghost'; children?: unknown }) {
  return <button className={tone === 'solid' ? 'rounded-lg bg-primary px-4' : 'rounded-lg px-4'}>{children as never}</button>;
}
export function Unused() { return <i />; }
`,
    'components/dupe-a.tsx': 'export function Card() { return <div className="rounded-lg p-4" />; }\n',
    'components/dupe-b.tsx': 'export function Card() { return <div className="rounded p-2" />; }\n',
    'app/page.tsx': `
import { Button } from '../components/button';
import { Card } from '../components/dupe-a';
export default function Page() {
  return (
    <main style={{ padding: 24 }}>
      <Button>One</Button>
      <Button tone="ghost">Two</Button>
      <Button>Three</Button>
      <Card />
      <a className="px-2 bg-[#123456] text-sm">x</a>
      <a className="text-sm px-2 bg-[#123456]">y</a>
      <a className="bg-[#123456] px-2 text-sm">z</a>
    </main>
  );
}
`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { jsx: 'preserve', strict: true } }));
});
afterAll(() => rm(root, { recursive: true, force: true }));

function run() {
  const project = loadProject(root);
  const components = extractComponents(project, root);
  const usage = extractUsage(project, root, components);
  return { components, usage, facts: buildFacts(components, usage) };
}

describe('extractUsage', () => {
  test('counts component uses and literal prop values, resolving imports', () => {
    const button = run().usage.components.find((u) => u.component === 'Button')!;
    expect(button.uses).toBe(3);
    expect(button.props).toEqual({ tone: { ghost: 1 } });
    expect(button.sites.every((s) => s.file === 'app/page.tsx')).toBe(true);
    const card = run().usage.components.find((u) => u.component === 'Card')!;
    expect(card.file).toBe('components/dupe-a.tsx');
  });

  test('counts classes by category with an example location', () => {
    const { classes } = run().usage;
    expect(classes.radius[0]).toMatchObject({ value: 'rounded-lg', count: 3 });
    expect(classes.spacing.find((c) => c.value === 'px-2')?.count).toBe(3);
  });

  test('records arbitrary values and inline styles as bypasses', () => {
    const { bypasses } = run().usage;
    expect(bypasses.filter((b) => b.kind === 'arbitrary-class')).toHaveLength(3);
    expect(bypasses.find((b) => b.kind === 'inline-style')).toMatchObject({ value: '{ padding: 24 }', file: 'app/page.tsx' });
  });

  test('finds repeated class lists regardless of order', () => {
    expect(run().usage.repeatedClassLists).toEqual([
      { tag: 'a', classes: 'bg-[#123456] px-2 text-sm', count: 3, examples: [{ file: 'app/page.tsx', line: 11 }, { file: 'app/page.tsx', line: 12 }, { file: 'app/page.tsx', line: 13 }] },
    ]);
  });
});

describe('buildFacts', () => {
  test('skips ties and pluralities', () => {
    const components = [{ name: 'Chip', file: 'c.tsx', line: 1, kind: 'component' as const, exported: true, client: false, props: [], variants: [{ prop: 'tone', options: ['a', 'b', 'c'] }] }];
    const usage = {
      components: [{ component: 'Chip', file: 'c.tsx', line: 1, uses: 4, sites: [{ file: 'p.tsx', line: 1 }], props: { tone: { a: 2, b: 1, c: 1 } } }],
      classes: { spacing: [], radius: [{ value: 'rounded', count: 1, example: { file: 'p.tsx', line: 1 } }, { value: 'rounded-lg', count: 1, example: { file: 'p.tsx', line: 2 } }], fontSize: [], color: [] },
      bypasses: [],
      repeatedClassLists: [],
    };
    expect(buildFacts(components, usage)).toEqual([]);
  });

  test('every fact has evidence', () => {
    expect(run().facts.every((f) => f.evidence.length > 0)).toBe(true);
  });

  test('reports dominant variants counting defaults, duplicates, unused exports, and bypasses', () => {
    const ids = new Map(run().facts.map((f) => [f.id, f.text]));
    expect(ids.get('variant:Button:tone')).toBe('Button uses tone="solid" in 2 of 3 places');
    expect(ids.get('duplicate:Card')).toBe('Card is defined in 2 files');
    expect(ids.get('unused:Unused')).toBe('Unused is exported but never rendered in this repo');
    expect(ids.get('bypass')).toContain('4 values bypass tokens');
    expect(ids.get('repeated:a:bg-[#123456] px-2 text-sm')).toContain('3 times');
  });
});
