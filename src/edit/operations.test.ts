import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractDesignSystem } from '../extract/profile';
import { checkEdit } from './check';
import { buildRepoIndex, loadEditProject } from './index';
import { applyEdits, type EditOperation } from './operations';
import type { EditScope } from './scope';

function setup(name: string) {
  const root = join(import.meta.dir, '..', '..', 'fixtures', name);
  const project = loadEditProject(root);
  const index = buildRepoIndex(extractDesignSystem(root), project, root);
  const run = (ops: EditOperation[] | unknown, scope: EditScope | null = null) => {
    const result = applyEdits(project, root, index, ops, scope);
    return { result, check: result.ok ? checkEdit(project, root, index, result.changes) : null };
  };
  return { root, project, index, run };
}

const orbit = setup('orbit-studio');
const messy = setup('messy-market');
const after = (result: ReturnType<typeof orbit.run>['result'], file: string) => result.changes.find((c) => c.file === file)!.after;

describe('applying edit operations', () => {
  test('retexts a heading and passes every check', () => {
    const { result, check } = orbit.run([{ op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'Five people, one studio' }]);
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/about/page.tsx')).toContain('<h1 className="mt-4 font-display text-5xl">Five people, one studio</h1>');
    expect(check).toEqual({ ok: true, errors: [], pending: ['lint', 'render'] });
  });

  test('inserts a team component and imports it the way the repo does', () => {
    const { result, check } = orbit.run([{ op: 'insert-jsx', anchor: 'app/about/page.tsx:10:9', position: 'after', jsx: '<Button intent="quiet" href="/">See our work</Button>' }]);
    const text = after(result, 'app/about/page.tsx');
    expect(text).toContain("import Tag from '@/components/Tag';\nimport { Button } from '@/components/Button';");
    expect(text).toContain('</p>\n        <Button intent="quiet" href="/">See our work</Button>\n      </Section>');
    expect(check?.errors).toEqual([]);
  });

  test('inserts as first and last child with the parent indentation', () => {
    const { result, check } = orbit.run([
      { op: 'insert-jsx', anchor: 'app/about/page.tsx:7:7', position: 'first-child', jsx: '<p>First</p>' },
      { op: 'insert-jsx', anchor: 'app/about/page.tsx:7:7', position: 'last-child', jsx: '<p>Last</p>' },
    ]);
    const text = after(result, 'app/about/page.tsx');
    expect(text).toContain('<Section width="narrow">\n        <p>First</p>\n        <Tag');
    expect(text).toContain('</p>\n        <p>Last</p>\n      </Section>');
    expect(check?.ok).toBe(true);
  });

  test('replaces arbitrary values with the matching token', () => {
    const { result, check } = messy.run([
      { op: 'replace-class', target: 'app/page.tsx:21:9', from: 'rounded', to: 'rounded-lg' },
      { op: 'set-prop', target: 'app/page.tsx:22:9', name: 'className', value: 'px-4 py-2 bg-[#0A7D5A] text-white rounded' },
    ]);
    const text = after(result, 'app/page.tsx');
    expect(text).toContain('<button className="px-4 py-2 bg-[#0a7d5a] text-white rounded-lg">Shop mugs</button>');
    expect(text).toContain('<button className="px-4 py-2 bg-(--main-color) text-white rounded">Shop totes</button>');
    expect(result.substitutions).toEqual([{ from: 'bg-[#0A7D5A]', to: 'bg-(--main-color)' }]);
    expect(check?.ok).toBe(true);
  });

  test('rejects a variant value the component does not define', () => {
    const { check } = orbit.run([{ op: 'set-prop', target: 'app/page.tsx:14:11', name: 'intent', value: 'loud' }]);
    expect(check?.ok).toBe(false);
    expect(check?.errors.find((e) => e.check === 'variants')?.message).toBe('Button has no intent="loud"; options are "primary", "quiet"');
  });

  test('reports new type errors but not the ones already there', () => {
    const { check } = orbit.run([{ op: 'set-prop', target: 'app/about/page.tsx:8:9', name: 'tone', value: { expression: '42' } }]);
    expect(check?.ok).toBe(false);
    expect(check?.errors.map((e) => e.check)).toEqual(['typecheck']);
    expect(check?.errors[0]?.line).toBe(8);
  });

  test('removes a prop', () => {
    const { result } = orbit.run([{ op: 'set-prop', target: 'app/page.tsx:14:11', name: 'intent', value: null }]);
    expect(after(result, 'app/page.tsx')).toContain('<Button href="/work/harbor-coffee">See our work</Button>');
  });

  test('refuses components outside the repo, bad JSX, stale tags, and overlaps, all or nothing', () => {
    const cases: Array<[unknown, string]> = [
      [[{ op: 'insert-jsx', anchor: 'app/about/page.tsx:9:9', position: 'after', jsx: '<Fancy />' }], 'unknown-component'],
      [[{ op: 'insert-jsx', anchor: 'app/about/page.tsx:9:9', position: 'after', jsx: '<p>one</p><p>two</p>' }], 'bad-jsx'],
      [[{ op: 'set-text', target: 'app/about/page.tsx:9:10', text: 'x' }], 'target-not-found'],
      [[{ op: 'set-text', target: 'app/about/page.tsx:7:7', text: 'x' }], 'not-plain-text'],
      [[{ op: 'replace-class', target: 'app/about/page.tsx:9:9', from: 'mt-8', to: 'mt-2' }], 'class-not-found'],
      [[{ op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'a' }, { op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'b' }], 'overlap'],
      [[{ op: 'rewrite-file', file: 'app/page.tsx' }], 'invalid'],
      [[], 'invalid'],
    ];
    for (const [ops, code] of cases) {
      const { result } = orbit.run(ops);
      expect(result.ok).toBe(false);
      expect(result.changes).toEqual([]);
      expect(result.errors.map((e) => e.code)).toContain(code as never);
    }
  });

  test('check flags a new package import and restores the project', () => {
    const sf = orbit.project.getSourceFileOrThrow(join(orbit.root, 'app', 'about', 'page.tsx'));
    const before = sf.getFullText();
    const check = checkEdit(orbit.project, orbit.root, orbit.index, [{ file: 'app/about/page.tsx', before, after: `import 'left-pad';\n${before}` }]);
    expect(check.errors.some((e) => e.check === 'imports' && e.message.startsWith('imports left-pad'))).toBe(true);
    expect(orbit.project.getSourceFileOrThrow(join(orbit.root, 'app', 'about', 'page.tsx')).getFullText()).toBe(before);
  });
});

describe('review regressions', () => {
  test('replace-class keeps whitespace that joins concatenated strings, and merges edits to one string', () => {
    const { result } = messy.run([
      { op: 'replace-class', target: 'app/page.tsx:21:9', from: 'px-4', to: 'px-6' },
      { op: 'replace-class', target: 'app/page.tsx:21:9', from: 'rounded', to: '' },
      { op: 'replace-class', target: 'app/page.tsx:21:9', from: 'py-2', to: 'py-3' },
    ]);
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/page.tsx')).toContain('<button className="px-6 py-3 bg-[#0a7d5a] text-white">Shop mugs</button>');
  });

  test('rejects anchors whose parent is not JSX', () => {
    const { result } = orbit.run([{ op: 'insert-jsx', anchor: 'app/page.tsx:20:38', position: 'after', jsx: '<p>x</p>' }]);
    expect(result.errors.map((e) => e.code)).toEqual(['bad-anchor']);
  });

  test('rejects two operations setting the same prop', () => {
    expect(orbit.run([
      { op: 'set-prop', target: 'app/about/page.tsx:9:9', name: 'title', value: 'a' },
      { op: 'set-prop', target: 'app/about/page.tsx:9:9', name: 'title', value: 'b' },
    ]).result.errors.map((e) => e.code)).toEqual(['overlap']);
  });

  test('rejects a class that would break out of its string', () => {
    const { result } = messy.run([{ op: 'replace-class', target: 'app/page.tsx:21:9', from: 'rounded', to: 'font-["Inter"]' }]);
    expect(result.errors.map((e) => e.code)).toEqual(['invalid']);
  });
});

describe('adding a class', () => {
  test('an empty from appends to a plain class string, once', () => {
    const { result, check } = orbit.run([
      { op: 'replace-class', target: 'app/about/page.tsx:9:9', from: '', to: 'text-brand' },
      { op: 'replace-class', target: 'app/about/page.tsx:9:9', from: 'mt-4', to: 'mt-6' },
      { op: 'replace-class', target: 'app/about/page.tsx:9:9', from: '', to: 'font-display' },
    ]);
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/about/page.tsx')).toContain('<h1 className="mt-6 font-display text-5xl text-brand">');
    expect(check?.ok).toBe(true);
  });

  test('an element with no className gets one, and several adds share it', () => {
    const { result } = messy.run([
      { op: 'replace-class', target: 'app/page.tsx:13:5', from: '', to: 'px-4' },
      { op: 'replace-class', target: 'app/page.tsx:13:5', from: '', to: 'bg-[#0a7d5a]' },
    ]);
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/page.tsx')).toContain("<main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }} className=\"px-4 bg-(--main-color)\">");
  });

  test('refuses to add to classes built in code, and an operation with neither side', () => {
    expect(orbit.run([{ op: 'replace-class', target: 'components/Tag.tsx:15:10', from: '', to: 'px-4' }]).result.errors.map((e) => e.code)).toEqual(['class-not-found']);
    expect(orbit.run([{ op: 'replace-class', target: 'components/Section.tsx:8:5', from: '', to: 'px-4' }]).result.errors.map((e) => e.code)).toEqual(['class-not-found']);
    expect(orbit.run([{ op: 'replace-class', target: 'app/about/page.tsx:9:9', from: '', to: '' }]).result.errors.map((e) => e.code)).toEqual(['invalid']);
  });
});

describe('selection scope', () => {
  // The first Section on orbit's home page: the heading, the paragraph, and two Buttons.
  const hero = { selection: 'app/page.tsx:9:7' };
  const codes = (ops: EditOperation[], scope: EditScope) => orbit.run(ops, scope).result.errors.map((e) => e.code);

  test('accepts the selected element itself', () => {
    const { result, check } = orbit.run([{ op: 'set-prop', target: 'app/page.tsx:9:7', name: 'tone', value: 'ink' }], hero);
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/page.tsx')).toContain('<Section tone="ink">\n        <h1');
    expect(check?.ok).toBe(true);
  });

  test('accepts targets nested at any depth inside the selection', () => {
    const { result } = orbit.run([
      { op: 'set-text', target: 'app/page.tsx:10:9', text: 'Brands people remember' },
      { op: 'set-prop', target: 'app/page.tsx:14:11', name: 'intent', value: null },
      { op: 'insert-jsx', anchor: 'app/page.tsx:12:9', position: 'last-child', jsx: '<Button intent="quiet" href="/about">About us</Button>' },
    ], hero);
    expect(result.errors).toEqual([]);
    expect(result.changes.map((c) => c.file)).toEqual(['app/page.tsx']);
  });

  test('accepts an insert right before or after the selection, with the import it needs', () => {
    const { result } = orbit.run([{ op: 'insert-jsx', anchor: 'app/about/page.tsx:9:9', position: 'after', jsx: '<Button href="/">See our work</Button>' }], { selection: 'app/about/page.tsx:9:9' });
    expect(result.errors).toEqual([]);
    expect(after(result, 'app/about/page.tsx')).toContain("import { Button } from '@/components/Button';");
  });

  test('rejects a target in the same file outside the selection', () => {
    // A sibling section, the parent, and a sibling of a nested selection.
    expect(codes([{ op: 'set-text', target: 'app/page.tsx:18:9', text: 'Recent work' }], hero)).toEqual(['out-of-scope']);
    expect(codes([{ op: 'insert-jsx', anchor: 'app/page.tsx:8:5', position: 'first-child', jsx: '<p>x</p>' }], hero)).toEqual(['out-of-scope']);
    expect(codes([{ op: 'set-text', target: 'app/page.tsx:11:9', text: 'x' }], { selection: 'app/page.tsx:10:9' })).toEqual(['out-of-scope']);
  });

  test('rejects a target in a file the selection has nothing to do with', () => {
    const { result } = orbit.run([{ op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'x' }], hero);
    expect(result.ok).toBe(false);
    expect(result.changes).toEqual([]);
    expect(result.errors).toEqual([{ op: 0, code: 'out-of-scope', message: 'That target is outside the selected element (app/page.tsx:9:7). Only the selected element and the elements inside it can change.' }]);
    // Nav is rendered by the layout, not by this section.
    expect(codes([{ op: 'replace-class', target: 'components/Nav.tsx:11:5', from: 'bg-paper', to: 'bg-ink' }], hero)).toEqual(['out-of-scope']);
  });

  test('a shared component the selection renders needs confirmation, then passes once allowed', () => {
    const op: EditOperation = { op: 'set-prop', target: 'components/Section.tsx:8:5', name: 'id', value: 'top' };
    const refused = orbit.run([op], hero).result;
    expect(refused.changes).toEqual([]);
    expect(refused.errors.map((e) => e.code)).toEqual(['needs-confirmation']);
    const section = orbit.index.components.find((card) => card.name === 'Section')!;
    expect(refused.errors[0]!.confirm).toEqual({ allow: section.id, component: 'Section', file: 'components/Section.tsx', line: section.source.line, uses: section.uses });

    expect(orbit.run([op], { ...hero, allow: [section.id] }).result.errors).toEqual([]);
    expect(orbit.run([op], { ...hero, allow: ['components/Section.tsx'] }).result.errors).toEqual([]);
    // Allowing one component doesn't open the rest of the repo.
    expect(codes([{ op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'x' }], { ...hero, allow: [section.id] })).toEqual(['out-of-scope']);
  });

  test('components rendered through other components count as rendered by the selection', () => {
    // The second Section maps projects to ProjectCard, which renders Tag.
    const work = { selection: 'app/page.tsx:17:7' };
    expect(codes([{ op: 'replace-class', target: 'components/ProjectCard.tsx:10:7', from: 'mt-2', to: 'mt-3' }], work)).toEqual(['needs-confirmation']);
    expect(codes([{ op: 'set-prop', target: 'components/Tag.tsx:15:10', name: 'title', value: 'x' }], work)).toEqual(['needs-confirmation']);
    // The hero renders no ProjectCard, so its definition is simply out of scope there.
    expect(codes([{ op: 'replace-class', target: 'components/ProjectCard.tsx:10:7', from: 'mt-2', to: 'mt-3' }], hero)).toEqual(['out-of-scope']);
  });

  test('a selection inside a component definition is held to its own subtree', () => {
    const title = { selection: 'components/ProjectCard.tsx:10:7' };
    expect(orbit.run([{ op: 'replace-class', target: 'components/ProjectCard.tsx:10:7', from: 'mt-2', to: 'mt-3' }], title).result.errors).toEqual([]);
    expect(codes([{ op: 'replace-class', target: 'components/ProjectCard.tsx:9:7', from: 'text-sm', to: 'text-xs' }], title)).toEqual(['out-of-scope']);
  });

  test('one operation outside the scope fails the whole request, and a stale selection fails before any operation', () => {
    const mixed = orbit.run([
      { op: 'set-text', target: 'app/page.tsx:10:9', text: 'Fine' },
      { op: 'set-text', target: 'app/page.tsx:18:9', text: 'Not fine' },
    ], hero).result;
    expect(mixed.changes).toEqual([]);
    expect(mixed.errors.map((e) => [e.op, e.code])).toEqual([[1, 'out-of-scope']]);
    expect(orbit.run([{ op: 'set-text', target: 'app/page.tsx:10:9', text: 'x' }], { selection: 'app/page.tsx:9:8' }).result.errors.map((e) => [e.op, e.code])).toEqual([[-1, 'target-not-found']]);
  });
});

describe('following the selection across an edit', () => {
  const heading = 'app/about/page.tsx:9:9';
  const lineOf = (text: string, needle: string) => text.split('\n').findIndex((line) => line.includes(needle)) + 1;

  test('an import and an inserted sibling above move the selection down, and a later edit uses the new tag', () => {
    const first = orbit.run([{ op: 'insert-jsx', anchor: heading, position: 'before', jsx: '<Button intent="quiet" href="/">Hi</Button>' }], { selection: heading });
    const text = after(first.result, 'app/about/page.tsx');
    const moved = first.result.nextTag!;
    expect(moved).toBe(`app/about/page.tsx:${lineOf(text, '<h1')}:9`);
    expect(moved).not.toBe(heading);
    // The same project after the first edit, as the worker would hold it, accepts the new tag and refuses the old one.
    const sf = orbit.project.getSourceFileOrThrow(join(orbit.root, 'app/about/page.tsx'));
    const original = sf.getFullText();
    try {
      sf.replaceWithText(text);
      const second = orbit.run([{ op: 'set-text', target: moved, text: 'Moved' }], { selection: moved });
      expect(second.result.errors).toEqual([]);
      expect(second.result.nextTag).toBe(moved);
      // The old tag still names an element, just not the heading: following the selection is not optional.
      expect(sf.getFullText().split('\n')[8]).not.toContain('<h1');
    } finally { sf.replaceWithText(original); }
  });

  test('without a scope there is no selection to follow', () => {
    const none = orbit.run([{ op: 'set-text', target: heading, text: 'Five' }], null);
    expect(none.result.nextTag).toBeNull();
  });

  test('an edit in another file leaves the selection tag as it was', () => {
    const run = orbit.run([{ op: 'set-text', target: heading, text: 'Five' }], { selection: heading });
    expect(run.result.nextTag).toBe(heading);
  });
});
