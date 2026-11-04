import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractDesignSystem } from '../extract/profile';
import { buildContext, buildRepoIndex, loadEditProject, resolveRoute, resolveSelection } from './index';

const fixture = (name: string) => join(import.meta.dir, '..', '..', 'fixtures', name);
const root = fixture('orbit-studio');
const project = loadEditProject(root);
const index = buildRepoIndex(extractDesignSystem(root, { commit: 'fixture-commit' }), project, root);
const id = (name: string) => index.components.find((card) => card.name === name)!.id;

describe('repo index', () => {
  test('indexes app routes and layouts at a commit', () => {
    expect(index.commit).toBe('fixture-commit');
    expect(index.routes.map((route) => route.pattern)).toEqual(['/', '/about', '/work/[slug]']);
    expect(resolveRoute(index, '/work/harbor-coffee')?.page).toBe('app/work/[slug]/page.tsx');
    expect(resolveRoute(index, '/work/harbor-coffee')?.layouts).toEqual(['app/layout.tsx']);
    expect(resolveRoute(index, '/missing')).toBeNull();
    expect(index.components.find((card) => card.name === 'Button')?.variants.some((group) => group.prop === 'intent')).toBe(true);
    for (const name of ['acme-analytics', 'messy-market']) {
      const other = fixture(name);
      const routes = buildRepoIndex(extractDesignSystem(other), loadEditProject(other), other).routes;
      expect(routes.some((route) => route.pattern === '/')).toBe(true);
      expect(routes.every((route) => route.layouts.includes('app/layout.tsx'))).toBe(true);
    }
  });

  test('records which component renders which, and every component a route renders', () => {
    expect(index.renders[id('Nav')]).toEqual([id('Button')]);
    expect(index.renders[id('ProjectCard')]).toContain(id('Tag'));
    const about = resolveRoute(index, '/about')!;
    // The page renders Section and Tag; the layout's Nav brings in Button.
    expect(about.components).toEqual([id('Button'), id('Nav'), id('Section'), id('Tag')].sort());
    expect(resolveRoute(index, '/')!.components).toContain(id('ProjectCard'));
  });
});

describe('selection', () => {
  test('resolves an exact source tag and rejects forged or stale locations', () => {
    const resolved = resolveSelection(project, root, index, 'app/about/page.tsx:9:9');
    expect(resolved?.source).toEqual({ file: 'app/about/page.tsx', line: 9, column: 9 });
    expect(resolved?.tag).toBe('h1');
    expect(resolved?.component).toBeNull();
    expect(resolved?.parents.map((p) => p.tag)).toEqual(['Section', 'main']);
    expect(resolved?.parents[0]?.props).toBe('width="narrow"');
    expect(resolveSelection(project, root, index, '../secret.tsx:9:9')).toBeNull();
    expect(resolveSelection(project, root, index, 'app/about/page.tsx:9:10')).toBeNull();
  });

  test('a tag inside a component definition resolves to its card', () => {
    expect(resolveSelection(project, root, index, 'components/Tag.tsx:15:10')?.component?.name).toBe('Tag');
  });
});

describe('context packet', () => {
  const selection = resolveSelection(project, root, index, 'app/about/page.tsx:9:9')!;

  test('puts route components first and keeps the whole packet within budget', () => {
    const context = buildContext(index, project, root, '/about', selection);
    expect(context.route?.page).toBe('app/about/page.tsx');
    expect(context.omitted).toEqual([]);
    expect(context.source.text).toContain('9:         <h1');
    expect(context.source.elements).toContainEqual({ tag: 'app/about/page.tsx:9:9', element: 'h1' });
    expect(context.source.elements.every(({ tag }) => resolveSelection(project, root, index, tag) !== null)).toBe(true);
    const onRoute = new Set(context.route!.components);
    const firstOff = context.components.findIndex((card) => !onRoute.has(card.id));
    expect(firstOff === -1 || context.components.slice(firstOff).every((card) => !onRoute.has(card.id))).toBe(true);
    expect(context.tokens.colors.accent?.variable).toBe('--color-brand');
    expect(JSON.stringify(context).length).toBeLessThanOrEqual(12000);
  });

  test('cuts facts, cards, then source lines as the budget shrinks', () => {
    const full = JSON.stringify(buildContext(index, project, root, '/about', selection)).length;
    const tight = buildContext(index, project, root, '/about', selection, Math.floor(full * 0.6));
    expect(JSON.stringify(tight).length).toBeLessThanOrEqual(Math.floor(full * 0.6));
    expect(tight.omitted.length).toBeGreaterThan(0);
    expect(tight.source.text).toContain('9:         <h1');
    expect(() => buildContext(index, project, root, '/about', selection, 500)).toThrow('more than 500 characters');
  });

  test('keeps the selected component card when cutting cards', () => {
    const inTag = resolveSelection(project, root, index, 'components/Tag.tsx:15:10')!;
    const full = JSON.stringify(buildContext(index, project, root, '/about', inTag)).length;
    const tight = buildContext(index, project, root, '/about', inTag, Math.floor(full * 0.45));
    expect(tight.components[0]?.name).toBe('Tag');
  });
});
