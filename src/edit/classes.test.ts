import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Project, ts } from 'ts-morph';
import { extractDesignSystem } from '../extract/profile';
import { changeLabel, changeProperty, classFor, classOperations, panelOptions, parseClass, resolveProperty, type PropertyId } from './classes';
import { directEdit } from './direct';
import { buildRepoIndex, loadEditProject } from './index';
import { applyEdits } from './operations';
import { styleSource } from './properties';

const fixtureRoot = (name: string) => join(import.meta.dir, '..', '..', 'fixtures', name);

function setup(name: string) {
  const root = fixtureRoot(name);
  const project = loadEditProject(root);
  const profile = extractDesignSystem(root);
  const index = buildRepoIndex(profile, project, root);
  const options = panelOptions(profile);
  return {
    options,
    style: (tag: string) => styleSource(project, root, tag),
    /** What the panel does for one control: read the classes, work out the change, send it as a direct edit. */
    set: (tag: string, id: PropertyId, value: string | null, allow?: string[]) => {
      const style = styleSource(project, root, tag)!;
      if (style.className.kind !== 'static') throw new Error(style.className.reason);
      const result = directEdit(project, root, index, { tag, operations: classOperations(tag, changeProperty(style.className.classes, id, value, options)), allow });
      if (!result.ok) throw new Error(result.message);
      const before = result.changes[0]!.before.split('\n');
      return result.changes[0]!.after.split('\n').filter((line, i) => line !== before[i]).map((line) => line.trim());
    },
  };
}

const orbit = setup('orbit-studio');
const messy = setup('messy-market');
const acme = setup('acme-analytics');
const o = orbit.options;
const list = (classes: string) => classes.split(' ').filter(Boolean);
const change = (classes: string, id: PropertyId, value: string | null) => changeProperty(list(classes), id, value, o);
const read = (classes: string, id: PropertyId) => resolveProperty(list(classes), id, o);

describe('reading a class list', () => {
  test('splits variants, important marks, and bracketed values', () => {
    expect(parseClass('md:hover:!px-4')).toEqual({ raw: 'md:hover:!px-4', prefix: 'md:hover:', important: 'before', utility: 'px-4' });
    expect(parseClass('px-4!')).toMatchObject({ prefix: '', important: 'after', utility: 'px-4' });
    expect(parseClass('bg-[url(https://a.test/b.png)]')).toMatchObject({ prefix: '', utility: 'bg-[url(https://a.test/b.png)]' });
    expect(parseClass('data-[state=open]:bg-ink')).toMatchObject({ prefix: 'data-[state=open]:', utility: 'bg-ink' });
  });

  test('finds the class that sets each property', () => {
    const classes = 'mt-6 max-w-xl font-body text-lg text-ink-muted font-medium leading-tight bg-paper rounded-card gap-3 px-5 py-2.5';
    const value = (id: PropertyId) => read(classes, id).value;
    expect(value('fontFamily')).toBe('body');
    expect(value('fontWeight')).toBe('medium');
    expect(value('fontSize')).toBe('lg');
    expect(value('textColor')).toBe('ink-muted');
    expect(value('lineHeight')).toBe('tight');
    expect(value('background')).toBe('paper');
    expect(value('radius')).toBe('card');
    expect(value('gap')).toBe('3');
    expect(value('paddingX')).toBe('5');
    expect(value('paddingY')).toBe('2.5');
    expect(value('padding')).toBeNull();
    expect(read(classes, 'padding').overrides).toEqual(['px-5', 'py-2.5']);
    expect(value('marginY')).toBeNull();
    expect(read(classes, 'marginY').overrides).toEqual(['mt-6']);
  });

  test('tells look-alike utilities apart', () => {
    // text- is a size, a color, or alignment; font- is a family or a weight; bg- and rounded- have non-color and corner forms.
    expect(read('text-center text-balance', 'textColor').value).toBeNull();
    expect(read('text-center', 'fontSize').value).toBeNull();
    expect(read('text-[34px]', 'fontSize').value).toBe('[34px]');
    expect(read('text-[34px]', 'textColor').value).toBeNull();
    expect(read('text-[#0a7d5a]', 'textColor').value).toBe('[#0a7d5a]');
    expect(read('text-sm/6', 'fontSize').value).toBe('sm/6');
    expect(read('font-bold', 'fontFamily').value).toBeNull();
    expect(read('font-display', 'fontWeight').value).toBeNull();
    expect(read('bg-cover bg-center bg-no-repeat', 'background').value).toBeNull();
    expect(read('bg-(--main-color)', 'background').value).toBe('(--main-color)');
    expect(read('rounded', 'radius').value).toBe('');
    expect(read('rounded-t-lg', 'radius')).toMatchObject({ value: null, overrides: ['rounded-t-lg'] });
    expect(read('gap-x-4', 'gap')).toMatchObject({ value: null, overrides: ['gap-x-4'] });
    expect(read('-mx-2', 'marginX').value).toBe('-2');
    expect(read('mx-auto', 'marginX').value).toBe('auto');
    // Hand-written class names that only look like spacing are left alone.
    expect(read('my-widget p-card', 'marginY').value).toBeNull();
    expect(read('my-widget p-card', 'padding').value).toBeNull();
  });

  test('a shorthand supplies the value until a more specific class overrides it', () => {
    expect(read('p-4', 'paddingX')).toMatchObject({ value: '4', className: 'p-4', fromShorthand: true });
    expect(read('p-4 px-2', 'paddingX')).toMatchObject({ value: '2', className: 'px-2', fromShorthand: false });
    expect(read('p-4 px-2', 'paddingY')).toMatchObject({ value: '4', fromShorthand: true });
    expect(read('p-4 px-2', 'padding')).toMatchObject({ value: '4', overrides: ['px-2'] });
  });

  test('classes behind a breakpoint or state are reported, never counted as the value', () => {
    expect(read('md:px-8 hover:px-3', 'paddingX')).toMatchObject({ value: null, conditional: ['md:px-8', 'hover:px-3'] });
    expect(read('px-2 md:px-8 md:pl-1', 'paddingX')).toMatchObject({ value: '2', overrides: [], conditional: ['md:px-8', 'md:pl-1'] });
    expect(read('hover:bg-ink hover:text-paper', 'background')).toMatchObject({ value: null, conditional: ['hover:bg-ink'] });
  });
});

describe('changing a class list', () => {
  test('replaces the existing utility', () => {
    expect(change('px-4 py-2 rounded', 'paddingX', '6')).toEqual([{ from: 'px-4', to: 'px-6' }]);
    expect(change('font-display text-5xl', 'fontSize', '4xl')).toEqual([{ from: 'text-5xl', to: 'text-4xl' }]);
    expect(change('text-lg text-ink-muted', 'textColor', 'brand')).toEqual([{ from: 'text-ink-muted', to: 'text-brand' }]);
    expect(change('rounded', 'radius', 'lg')).toEqual([{ from: 'rounded', to: 'rounded-lg' }]);
    expect(change('rounded-lg', 'radius', '')).toEqual([{ from: 'rounded-lg', to: 'rounded' }]);
    expect(change('font-bold font-display', 'fontWeight', 'medium')).toEqual([{ from: 'font-bold', to: 'font-medium' }]);
    expect(change('font-bold font-display', 'fontFamily', 'body')).toEqual([{ from: 'font-display', to: 'font-body' }]);
  });

  test('adds the utility when none is present', () => {
    expect(change('font-display text-5xl', 'textColor', 'brand')).toEqual([{ from: '', to: 'text-brand' }]);
    expect(change('', 'padding', '4')).toEqual([{ from: '', to: 'p-4' }]);
    expect(change('flex', 'marginX', '-2')).toEqual([{ from: '', to: '-mx-2' }]);
  });

  test('leaves breakpoint and state classes exactly as they are', () => {
    expect(change('px-2 md:px-8 hover:px-3', 'paddingX', '6')).toEqual([{ from: 'px-2', to: 'px-6' }]);
    // Only a state sets it: the base value is added beside it, not written over it.
    expect(change('border hover:bg-ink', 'background', 'paper')).toEqual([{ from: '', to: 'bg-paper' }]);
    expect(change('md:p-8 md:pl-2', 'padding', '4')).toEqual([{ from: '', to: 'p-4' }]);
    expect(change('px-2 md:px-8', 'paddingX', null)).toEqual([{ from: 'px-2', to: '' }]);
  });

  test('resolves conflicting shorthands', () => {
    // All sides over p-4 px-2: px-2 would keep winning on the sides, so it goes.
    expect(change('p-4 px-2', 'padding', '6')).toEqual([{ from: 'p-4', to: 'p-6' }, { from: 'px-2', to: '' }]);
    // One axis under a shorthand: the shorthand stays and the axis class overrides it.
    expect(change('p-4', 'paddingX', '6')).toEqual([{ from: '', to: 'px-6' }]);
    expect(change('p-4 px-2', 'paddingX', '6')).toEqual([{ from: 'px-2', to: 'px-6' }]);
    // The shorthand already gives the value: dropping the override is the whole change.
    expect(change('p-4 px-2', 'paddingX', '4')).toEqual([{ from: 'px-2', to: '' }]);
    expect(change('p-4', 'paddingX', '4')).toEqual([]);
    // Single sides under an axis go when the axis is set.
    expect(change('pt-2 pb-4 px-3', 'paddingY', '6')).toEqual([{ from: '', to: 'py-6' }, { from: 'pt-2', to: '' }, { from: 'pb-4', to: '' }]);
    expect(change('mt-8 mb-4 mx-auto', 'margin', '0')).toEqual([{ from: '', to: 'm-0' }, { from: 'mt-8', to: '' }, { from: 'mb-4', to: '' }, { from: 'mx-auto', to: '' }]);
    expect(change('gap-4 gap-x-2', 'gap', '6')).toEqual([{ from: 'gap-4', to: 'gap-6' }, { from: 'gap-x-2', to: '' }]);
    expect(change('rounded-lg rounded-t-none', 'radius', 'full')).toEqual([{ from: 'rounded-lg', to: 'rounded-full' }, { from: 'rounded-t-none', to: '' }]);
  });

  test('handles repeats, important marks, clearing, and no-ops', () => {
    expect(change('px-2 px-4', 'paddingX', '6')).toEqual([{ from: 'px-4', to: 'px-6' }, { from: 'px-2', to: '' }]);
    expect(change('!px-4', 'paddingX', '6')).toEqual([{ from: '!px-4', to: '!px-6' }]);
    expect(change('px-4!', 'paddingX', '6')).toEqual([{ from: 'px-4!', to: 'px-6!' }]);
    expect(change('px-4 pl-2', 'paddingX', null)).toEqual([{ from: 'px-4', to: '' }, { from: 'pl-2', to: '' }]);
    expect(change('px-4', 'paddingX', '4')).toEqual([]);
    expect(change('flex', 'paddingX', null)).toEqual([]);
  });

  test('names the class and the change in plain words', () => {
    expect(classFor('radius', '')).toBe('rounded');
    expect(classFor('marginY', '-4')).toBe('-my-4');
    expect(classFor('background', '(--main-color)')).toBe('bg-(--main-color)');
    expect(changeLabel('paddingX', '4', '6')).toBe('Padding, left and right: 4 to 6');
    expect(changeLabel('textColor', null, 'brand')).toBe('Text color: set to brand');
    expect(changeLabel('radius', 'lg', '')).toBe('Corner radius: lg to default');
    expect(changeLabel('gap', '4', null)).toBe('Gap between items: removed');
  });
});

describe('choices come from the repo', () => {
  const values = (options: Array<{ value: string; group: string }>, group: string) => options.filter((x) => x.group === group).map((x) => x.value);

  test('theme tokens come first, with their colors', () => {
    expect(values(o.textColor, 'Tokens')).toEqual(['paper', 'ink', 'ink-muted', 'brand', 'brand-ink', 'rule']);
    expect(o.background.find((x) => x.value === 'brand')).toEqual({ value: 'brand', label: 'brand', group: 'Tokens', swatch: '#e4572e' });
    expect(values(o.fontFamily, 'Tokens')).toEqual(['display', 'body']);
    expect(values(o.radius, 'Tokens')).toEqual(['card']);
    expect(values(acme.options.radius, 'Tokens')).toEqual(['sm', 'md', 'lg', 'xl']);
    // A token that shares a name with a scale step is listed once.
    expect(acme.options.radius.filter((x) => x.value === 'md')).toHaveLength(1);
    expect(values(acme.options.background, 'Tokens')).toContain('muted-foreground');
  });

  test('a repo without theme colors offers its CSS variables and the palette colors it already uses', () => {
    expect(values(messy.options.background, 'Tokens')).toEqual(['(--main-color)', '(--bg)', '(--text)']);
    expect(values(messy.options.background, 'Used in this repo')).toEqual(['gray-100', 'gray-700', 'green-700', 'red-600', 'white']);
    expect(messy.options.background.some((x) => x.value.includes('#'))).toBe(false);
  });

  test('scales are Tailwind steps, and only margin offers auto', () => {
    expect(o.spacing.find((x) => x.value === '4')).toEqual({ value: '4', label: '4 · 16px', group: 'Tailwind scale' });
    expect(o.spacing.some((x) => x.value === 'auto')).toBe(false);
    expect(o.margin.some((x) => x.value === 'auto')).toBe(true);
    expect(o.fontSize.map((x) => x.value).slice(0, 4)).toEqual(['xs', 'sm', 'base', 'lg']);
    expect(o.fontWeight.find((x) => x.value === 'medium')?.label).toBe('medium · 500');
  });
});

describe('where an element gets its classes', () => {
  test('a plain string, or no className on a host element, can be changed', () => {
    expect(orbit.style('app/about/page.tsx:9:9')?.className).toEqual({ kind: 'static', classes: ['mt-4', 'font-display', 'text-5xl'] });
    expect(messy.style('components/Header.tsx:8:9')?.className).toEqual({ kind: 'static', classes: [] });
    // A component that passes className through takes classes where it is used.
    expect(acme.style('app/page.tsx:21:11')).toEqual({ target: 'app/page.tsx:21:11', className: { kind: 'static', classes: [] }, props: { size: 'lg' } });
    expect(acme.style('app/page.tsx:33:15')?.className).toEqual({ kind: 'static', classes: ['px-0'] });
  });

  test('classes built in code lock the controls and say why', () => {
    const reason = (source: ReturnType<typeof orbit.style>) => (source?.className.kind === 'locked' ? source.className.reason : null);
    expect(reason(acme.style('components/ui/button.tsx:28:10'))).toBe("The styles on this element are built by cn(...) in the code, so these controls can't change them safely. Ask for the change instead.");
    expect(reason(orbit.style('components/Tag.tsx:15:10'))).toStartWith('The styles on this element are built by tag(...)');
    expect(reason(orbit.style('components/Button.tsx:20:10'))).toStartWith('The styles on this element come from className in the code');
    expect(reason(orbit.style('components/Section.tsx:8:5'))).toStartWith('The styles on this element are put together from several pieces');
    expect(reason(messy.style('components/ProductCard.tsx:8:7'))).toStartWith('The styles on this element depend on a condition');
    // A component with no className prop can't be styled where it is used.
    expect(reason(orbit.style('app/page.tsx:14:11'))).toBe("Button doesn't take styles where it is used. Its look is set inside the component. Change its options, or ask for the change.");
    expect(orbit.style('app/page.tsx:14:11')?.props).toEqual({ intent: 'quiet', href: '/work/harbor-coffee' });
    expect(orbit.style('app/page.tsx:14:12')).toBeNull();
  });
});

describe('from a control to the source', () => {
  test('replaces a class in place', () => {
    expect(orbit.set('app/about/page.tsx:9:9', 'fontSize', '4xl')).toEqual(['<h1 className="mt-4 font-display text-4xl">Four people, one studio</h1>']);
  });

  test('adds a class to an existing list, and writes className when there is none', () => {
    expect(orbit.set('app/about/page.tsx:9:9', 'textColor', 'brand')).toEqual(['<h1 className="mt-4 font-display text-5xl text-brand">Four people, one studio</h1>']);
    // Header's own definition shows on every route, so a control there needs the person's confirmation first.
    expect(() => messy.set('components/Header.tsx:8:9', 'paddingX', '4')).toThrow('Confirm it to go ahead');
    expect(messy.set('components/Header.tsx:8:9', 'paddingX', '4', ['components/Header.tsx'])).toEqual(['<Link href="/" className="px-4">Shop</Link>']);
    expect(acme.set('app/page.tsx:21:11', 'radius', 'full')).toEqual(['<Button size="lg" className="rounded-full">Start free trial</Button>']);
  });

  test('keeps state classes and applies several steps to one string', () => {
    expect(orbit.set('components/ProjectCard.tsx:8:5', 'padding', '8')).toEqual(['<Link href={`/work/${project.slug}`} className="group block rounded-card border border-rule p-8 transition-colors hover:border-ink">']);
    expect(messy.set('app/page.tsx:21:9', 'padding', '3')).toEqual(['<button className="bg-[#0a7d5a] text-white rounded p-3">Shop mugs</button>']);
  });

  test('a token choice replaces a hardcoded color', () => {
    expect(messy.set('app/page.tsx:21:9', 'background', '(--main-color)')).toEqual(['<button className="px-4 py-2 bg-(--main-color) text-white rounded">Shop mugs</button>']);
  });
});

describe('important shorthands', () => {
  test('an important shorthand is what applies, over a plain class of the control\'s own', () => {
    expect(read('!p-4', 'paddingX')).toMatchObject({ value: '4', className: '!p-4', fromShorthand: true });
    expect(read('p-4!', 'paddingY')).toMatchObject({ value: '4', className: 'p-4!', fromShorthand: true });
    expect(read('!p-4 px-2', 'paddingX')).toMatchObject({ value: '4', className: '!p-4', fromShorthand: true });
    expect(read('p-4! px-2', 'paddingX')).toMatchObject({ value: '4', className: 'p-4!', fromShorthand: true });
    // Both important: the more specific one wins, as it does when neither is.
    expect(read('!p-4 !px-2', 'paddingX')).toMatchObject({ value: '2', fromShorthand: false });
    expect(read('p-4 !px-2', 'paddingX')).toMatchObject({ value: '2', fromShorthand: false });
    expect(read('!px-2 px-8', 'paddingX')).toMatchObject({ value: '2', className: '!px-2' });
  });

  test('a class written under an important shorthand is important too, in the same form', () => {
    // A plain px-6 would lose to !p-4 and the control would report a change nobody can see.
    expect(change('!p-4', 'paddingX', '6')).toEqual([{ from: '', to: '!px-6' }]);
    expect(change('p-4!', 'paddingX', '6')).toEqual([{ from: '', to: 'px-6!' }]);
    expect(change('!m-4', 'marginY', '-2')).toEqual([{ from: '', to: '!-my-2' }]);
    // A plain axis class beside an important shorthand was already losing; its replacement must win.
    expect(change('!p-4 px-2', 'paddingX', '6')).toEqual([{ from: 'px-2', to: '!px-6' }]);
    expect(change('p-4! px-2', 'paddingX', '6')).toEqual([{ from: 'px-2', to: 'px-6!' }]);
    // An important class of the control's own keeps its own form.
    expect(change('p-4! !px-2', 'paddingX', '6')).toEqual([{ from: '!px-2', to: '!px-6' }]);
    for (const [classes, value] of [['!p-4', '6'], ['p-4!', '6'], ['!p-4 px-2', '6'], ['p-4! px-2', '8']] as const) {
      const next = list(classes).flatMap((c) => { const step = change(classes, 'paddingX', value).find((x) => x.from === c); return step ? [step.to].filter(Boolean) : [c]; })
        .concat(change(classes, 'paddingX', value).filter((x) => !x.from).map((x) => x.to));
      expect(resolveProperty(next, 'paddingX', o).value).toBe(value);
    }
  });

  test('choosing the value an important shorthand already gives only clears what was in its way', () => {
    expect(change('!p-4 px-2', 'paddingX', '4')).toEqual([{ from: 'px-2', to: '' }]);
    expect(change('!p-4 !px-2', 'paddingX', '4')).toEqual([{ from: '!px-2', to: '' }]);
    expect(change('!p-4', 'paddingX', '4')).toEqual([]);
    // A plain shorthand can't cover for an important class of the control's own.
    expect(change('p-4 !px-2', 'paddingX', '4')).toEqual([{ from: '!px-2', to: '!px-4' }]);
    // Among repeats the important one is the one in effect; the rest go.
    expect(change('!px-2 px-8', 'paddingX', '6')).toEqual([{ from: '!px-2', to: '!px-6' }, { from: 'px-8', to: '' }]);
  });
});

describe('utilities that share a prefix, by the repo\'s own token names', () => {
  const root = fixtureRoot('orbit-studio');
  const base = extractDesignSystem(root);
  const token = (name: string, value: string) => ({ name, value, resolved: value, scope: '@theme', file: 'app/globals.css', line: 1 });
  const themed = panelOptions({ ...base, tokens: { ...base.tokens, variables: [...base.tokens.variables,
    token('--font-weight-book', '450'), token('--text-hero', '5rem'), token('--text-hero--line-height', '1'), token('--text-shadow-glow', '0 0 4px #fff'),
    token('--leading-display', '1.05'), token('--radius-s', '2px'), token('--radius-button', '10px'), token('--color-base', '#101010'), token('--color-left', '#00f'),
    token('--spacing-gutter', '1.5rem'),
  ] } });
  const value = (classes: string, id: PropertyId) => resolveProperty(list(classes), id, themed).value;

  test('a theme weight is a weight, not a font family', () => {
    expect(themed.fontWeight.find((x) => x.value === 'book')).toEqual({ value: 'book', label: 'book', group: 'Tokens' });
    expect(themed.fontFamily.some((x) => x.value.includes('book'))).toBe(false);
    expect(value('font-book font-display', 'fontWeight')).toBe('book');
    expect(value('font-book font-display', 'fontFamily')).toBe('display');
    expect(changeProperty(['font-book', 'font-display'], 'fontWeight', 'medium', themed)).toEqual([{ from: 'font-book', to: 'font-medium' }]);
    expect(changeProperty(['font-bold', 'font-display'], 'fontWeight', 'book', themed)).toEqual([{ from: 'font-bold', to: 'font-book' }]);
    expect(changeProperty(['font-book'], 'fontFamily', 'body', themed)).toEqual([{ from: '', to: 'font-body' }]);
    // Without the token, font-book is still read as a family, as in a repo that names a font "book".
    expect(resolveProperty(['font-book'], 'fontWeight', o).value).toBeNull();
    expect(resolveProperty(['font-book'], 'fontFamily', o).value).toBe('book');
  });

  test('a theme size is a size, a theme color is a color, and neither namespace leaks into the other', () => {
    expect(themed.fontSize.filter((x) => x.group === 'Tokens').map((x) => x.value)).toEqual(['hero']);
    expect(value('text-hero text-brand', 'fontSize')).toBe('hero');
    expect(value('text-hero text-brand', 'textColor')).toBe('brand');
    expect(changeProperty(['text-hero', 'text-brand'], 'fontSize', 'lg', themed)).toEqual([{ from: 'text-hero', to: 'text-lg' }]);
    expect(changeProperty(['text-hero', 'text-brand'], 'textColor', 'ink', themed)).toEqual([{ from: 'text-brand', to: 'text-ink' }]);
    // A color token named like an alignment keyword is a color in this repo; a name shared with the size scale stays a size.
    expect(value('text-left', 'textColor')).toBe('left');
    expect(resolveProperty(['text-left'], 'textColor', o).value).toBeNull();
    expect(value('text-base', 'fontSize')).toBe('base');
    expect(value('text-base', 'textColor')).toBeNull();
    expect(value('bg-base', 'background')).toBe('base');
    expect(value('bg-left/50', 'background')).toBe('left/50');
  });

  test('theme line heights, spacing, and radii are read under their own controls', () => {
    expect(value('leading-display', 'lineHeight')).toBe('display');
    expect(value('px-gutter', 'paddingX')).toBe('gutter');
    expect(value('rounded-button', 'radius')).toBe('button');
    // rounded-s is the start side in Tailwind, and the whole radius in a repo whose theme names a radius s.
    expect(resolveProperty(['rounded-s'], 'radius', themed)).toMatchObject({ value: 's', overrides: [] });
    expect(resolveProperty(['rounded-s'], 'radius', o)).toMatchObject({ value: null, overrides: ['rounded-s'] });
    expect(resolveProperty(['rounded-s-lg', 'rounded-t-none'], 'radius', themed)).toMatchObject({ value: null, overrides: ['rounded-s-lg', 'rounded-t-none'] });
    expect(changeProperty(['rounded-s'], 'radius', 'button', themed)).toEqual([{ from: 'rounded-s', to: 'rounded-button' }]);
  });
});

describe('spread props and className', () => {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, strict: true } });
  project.createSourceFile('/repo/app/spread.tsx', [
    'type Styled = { className?: string; id?: string };',
    'type Plain = { id: string; title?: string };',
    'export function A(props: Styled) { return <div {...props}>a</div>; }',
    'export function B(props: Styled) { return <div className="p-4" {...props}>b</div>; }',
    'export function C(props: Styled) { return <div {...props} className="p-4">c</div>; }',
    'export function D(props: Plain) { return <div {...props}>d</div>; }',
    'export function E(props: Plain) { return <div className="p-4" {...props}>e</div>; }',
    'export function F(props: Record<string, string>) { return <div {...props}>f</div>; }',
    'export function G<T extends object>(props: T) { return <div id="g" {...props}>g</div>; }',
    'export function H(props: Plain | Styled) { return <div {...props}>h</div>; }',
    '',
  ].join('\n'));
  const index = buildRepoIndex(extractDesignSystem(fixtureRoot('orbit-studio')), loadEditProject(fixtureRoot('orbit-studio')), fixtureRoot('orbit-studio'));
  const tag = (line: number) => `app/spread.tsx:${line}:${project.getSourceFileOrThrow('/repo/app/spread.tsx').getFullText().split('\n')[line - 1]!.indexOf('<div') + 1}`;
  const style = (line: number) => styleSource(project, '/repo', tag(line))!.className;
  const add = (line: number) => applyEdits(project, '/repo', index, [{ op: 'replace-class', target: tag(line), from: '', to: 'px-6' }], { selection: tag(line) });

  test('a spread that can carry className locks the controls', () => {
    // No className written: the spread may supply one, and a written one would discard it.
    expect(style(3)).toEqual({ kind: 'locked', reason: "The styles on this element can come from {...props} in the code, so these controls can't change them safely. Ask for the change instead." });
    // A spread after a written className overrides it, so no edit to the string would show.
    expect(style(4).kind).toBe('locked');
    // A string index, a type parameter, or one arm of a union could carry it too.
    expect(style(8).kind).toBe('locked');
    expect(style(9).kind).toBe('locked');
    expect(style(10).kind).toBe('locked');
  });

  test('a spread that cannot decide the className leaves the controls on', () => {
    // The written className comes after the spread, so it wins.
    expect(style(5)).toEqual({ kind: 'static', classes: ['p-4'] });
    // The spread's type has no className at all.
    expect(style(6)).toEqual({ kind: 'static', classes: [] });
    expect(style(7)).toEqual({ kind: 'static', classes: ['p-4'] });
  });

  test('the applier refuses to add a class where the spread decides, for every caller', () => {
    for (const line of [3, 4, 8, 9, 10]) {
      const result = add(line);
      expect(result.changes).toEqual([]);
      expect(result.errors.map((e) => e.code)).toEqual(['class-not-found']);
    }
    expect(add(3).errors[0]!.message).toBe("The element's className can come from {...props}, so a class can't be added to it here.");
    const direct = directEdit(project, '/repo', index, { tag: tag(3), operations: [{ op: 'replace-class', target: tag(3), from: '', to: 'px-6' }] });
    expect(direct).toMatchObject({ ok: false, message: "The styles on this element aren't a plain list in the code, so this control can't change them. Ask for the change instead." });
  });

  test('the applier still adds where the written className wins or the spread has none', () => {
    const after = (line: number) => add(line).changes[0]?.after.split('\n')[line - 1];
    expect(after(5)).toBe('export function C(props: Styled) { return <div {...props} className="p-4 px-6">c</div>; }');
    expect(after(6)).toBe('export function D(props: Plain) { return <div {...props} className="px-6">d</div>; }');
    expect(after(7)).toBe('export function E(props: Plain) { return <div className="p-4 px-6" {...props}>e</div>; }');
  });
});
