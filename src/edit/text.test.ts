import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractDesignSystem } from '../extract/profile';
import { textEditTracker, textOperation } from '../app/editor/direct';
import { directEdit, summarize } from './direct';
import { buildRepoIndex, loadEditProject } from './index';
import { textSource } from './text';

function setup(name: string) {
  const root = join(import.meta.dir, '..', '..', 'fixtures', name);
  const project = loadEditProject(root);
  const index = buildRepoIndex(extractDesignSystem(root), project, root);
  return {
    source: (tag: string, usedAt?: { file: string; line: number }) => textSource(project, root, index, tag, usedAt),
    edit: (tag: string, operations: unknown, extra: { allow?: string[]; label?: string } = {}) => directEdit(project, root, index, { tag, operations, ...extra }),
  };
}

const orbit = setup('orbit-studio');
const messy = setup('messy-market');
const acme = setup('acme-analytics');

describe('where text lives', () => {
  test('text written in the JSX is editable, on a host element or a component instance', () => {
    expect(orbit.source('app/about/page.tsx:9:9')).toEqual({ editable: true, target: 'app/about/page.tsx:9:9', file: 'app/about/page.tsx', line: 9, text: 'Four people, one studio' });
    expect(orbit.source('app/about/page.tsx:8:9')).toMatchObject({ editable: true, text: 'About' });
    expect(orbit.source('app/page.tsx:14:11')).toMatchObject({ editable: true, text: 'See our work' });
    // Text wrapped over several source lines reads the way the page shows it.
    expect(acme.source('app/page.tsx:17:9')).toMatchObject({ editable: true, text: 'Acme Analytics connects to your database and answers product questions in plain charts.' });
  });

  test('text a component receives as a prop names the prop and where it is set', () => {
    expect(orbit.source('components/Tag.tsx:15:10')).toEqual({ editable: false, reason: 'prop', prop: 'children', message: 'This text is the children prop of Tag. It is set where Tag is used.', file: 'components/Tag.tsx', line: 15 });
    expect(orbit.source('components/Tag.tsx:15:10', { file: 'app/about/page.tsx', line: 8 })).toMatchObject({ message: 'This text is the children prop of Tag. It is set where Tag is used, in app/about/page.tsx line 8.', file: 'app/about/page.tsx', line: 8 });
    // forwardRef wraps the component; its parameters are still props.
    expect(orbit.source('components/Button.tsx:20:10')).toMatchObject({ reason: 'prop', prop: 'children' });
    expect(messy.source('components/legacy-banner.jsx:4:7')).toMatchObject({ reason: 'prop', prop: 'title', message: 'This text is the title prop of LegacyBanner. It is set where LegacyBanner is used.' });
    // Literal text next to a value is still not editable in place.
    expect(messy.source('components/ProductCard.tsx:8:7')).toMatchObject({ editable: false, reason: 'prop', prop: 'price' });
  });

  test('text from a list or a variable points at the data', () => {
    // A value looked up from an imported list.
    expect(orbit.source('app/work/[slug]/page.tsx:17:9')).toEqual({ editable: false, reason: 'data', message: "This text comes from data in lib/projects.ts, line 3. It can't be edited on the page.", file: 'lib/projects.ts', line: 3 });
    // A .map() callback parameter leads back to the list in the same file.
    expect(orbit.source('components/Nav.tsx:17:15')).toMatchObject({ reason: 'data', file: 'components/Nav.tsx', line: 4 });
    expect(acme.source('app/page.tsx:29:15')).toMatchObject({ reason: 'data', file: 'app/page.tsx', line: 5 });
    // A list mapped from a prop is the prop's text.
    expect(orbit.source('components/ProjectCard.tsx:12:34')).toMatchObject({ reason: 'prop', prop: 'project' });
  });

  test('elements without text of their own say so', () => {
    expect(orbit.source('app/page.tsx:12:9')).toMatchObject({ editable: false, reason: 'mixed' });
    expect(messy.source('components/ProductCard.tsx:6:7')).toMatchObject({ editable: false, reason: 'empty', message: 'There is no text in this element to edit.' });
    expect(orbit.source('app/about/page.tsx:9:10')).toMatchObject({ editable: false, reason: 'missing' });
  });
});

describe('typed text as an operation', () => {
  test('maps to set-text on the source tag, tidied, and to nothing when empty', () => {
    expect(textOperation('app/about/page.tsx:9:9', '  Five people,\n one studio ')).toEqual({ op: 'set-text', target: 'app/about/page.tsx:9:9', text: 'Five people, one studio' });
    expect(textOperation('app/about/page.tsx:9:9', ' \n ')).toBeNull();
  });
});

describe('overlapping double-clicks', () => {
  test('a late answer for the first element cannot replace the one being edited', () => {
    const edits = textEditTracker();
    const first = edits.ask();
    const second = edits.ask();
    // B is answered and starts editing, then A's answer arrives late.
    expect(edits.answer(second, 'b.tsx:2:3', 'b.tsx:2:3')).toBe(true);
    expect(edits.answer(first, 'a.tsx:1:1', 'a.tsx:1:1')).toBe(false);
    expect(edits.isLatest(first)).toBe(false);
    expect(edits.commit('b.tsx:2:3')).toBe('b.tsx:2:3');
  });

  test('an early answer for the first element is dropped too, and the second still edits', () => {
    const edits = textEditTracker();
    const first = edits.ask();
    const second = edits.ask();
    expect(edits.answer(first, 'a.tsx:1:1', 'a.tsx:1:1')).toBe(false);
    expect(edits.commit('a.tsx:1:1')).toBeNull();
    expect(edits.answer(second, 'b.tsx:2:3', 'page.tsx:9:9')).toBe(true);
    // The commit is written at the source tag the worker named, which can differ from the page element's key.
    expect(edits.commit('b.tsx:2:3')).toBe('page.tsx:9:9');
  });

  test('a commit is used once, and a cancel for another element leaves the edit alone', () => {
    const edits = textEditTracker();
    edits.answer(edits.ask(), 'b.tsx:2:3', 'b.tsx:2:3');
    edits.cancel('a.tsx:1:1');
    expect(edits.commit('a.tsx:1:1')).toBeNull();
    expect(edits.commit('b.tsx:2:3')).toBe('b.tsx:2:3');
    expect(edits.commit('b.tsx:2:3')).toBeNull();
    edits.answer(edits.ask(), 'b.tsx:2:3', 'b.tsx:2:3');
    edits.cancel('b.tsx:2:3');
    expect(edits.commit('b.tsx:2:3')).toBeNull();
  });
});

describe('direct edits', () => {
  const retext = (tag: string, text: string) => [textOperation(tag, text)!];

  test('a text edit changes only that line and is summarized in plain words', () => {
    const result = orbit.edit('app/about/page.tsx:9:9', retext('app/about/page.tsx:9:9', 'Five people, one studio'));
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toBe('Change text to "Five people, one studio"');
    expect(result.changes.map((c) => c.file)).toEqual(['app/about/page.tsx']);
    const before = result.changes[0]!.before.split('\n');
    const after = result.changes[0]!.after.split('\n');
    expect(after.filter((line, i) => line !== before[i])).toEqual(['        <h1 className="mt-4 font-display text-5xl">Five people, one studio</h1>']);
  });

  test('text with characters JSX reserves is written as a string, and can be edited again', () => {
    const result = orbit.edit('app/about/page.tsx:9:9', retext('app/about/page.tsx:9:9', 'Fewer projects {more} care'));
    expect(result.ok && result.changes[0]!.after).toContain('<h1 className="mt-4 font-display text-5xl">{"Fewer projects {more} care"}</h1>');
  });

  test('the same scope applies as for an Ask', () => {
    const outside = orbit.edit('app/about/page.tsx:9:9', retext('app/about/page.tsx:10:9', 'x'));
    expect(outside).toMatchObject({ ok: false, message: 'That change reaches outside the selected element, so it was not made.' });
    expect(!outside.ok && outside.errors.map((e) => e.code)).toEqual(['out-of-scope']);

    const shared = orbit.edit('app/about/page.tsx:8:9', [{ op: 'set-prop', target: 'components/Tag.tsx:15:10', name: 'title', value: 'x' }]);
    expect(!shared.ok && shared.confirm.map((c) => c.component)).toEqual(['Tag']);
    expect(!shared.ok && shared.message).toStartWith('That would change Tag everywhere it is used');
    expect(orbit.edit('app/about/page.tsx:8:9', [{ op: 'set-prop', target: 'components/Tag.tsx:15:10', name: 'title', value: 'x' }], { allow: ['components/Tag.tsx'] }).ok).toBe(true);
  });

  test('the same checks apply as for an Ask', () => {
    const result = orbit.edit('app/page.tsx:14:11', [{ op: 'set-prop', target: 'app/page.tsx:14:11', name: 'intent', value: 'loud' }]);
    expect(result).toMatchObject({ ok: false, message: "That option isn't one this component offers." });
    expect(!result.ok && result.checks.map((c) => c.check)).toContain('variants');
  });

  test('dynamic text, code values, inserted JSX, and no-op edits are refused', () => {
    expect(orbit.edit('components/Tag.tsx:15:10', retext('components/Tag.tsx:15:10', 'x'))).toMatchObject({ ok: false, message: "This text isn't written directly in the code here, so it can't be edited on the page." });
    const code = orbit.edit('app/page.tsx:14:11', [{ op: 'set-prop', target: 'app/page.tsx:14:11', name: 'onClick', value: { expression: 'alert(1)' } }]);
    expect(!code.ok && code.errors.map((e) => e.code)).toEqual(['invalid']);
    const insert = orbit.edit('app/page.tsx:14:11', [{ op: 'insert-jsx', anchor: 'app/page.tsx:14:11', position: 'after', jsx: '<p>x</p>' }]);
    expect(!insert.ok && insert.errors.map((e) => e.code)).toEqual(['invalid']);
    expect(orbit.edit('app/about/page.tsx:9:9', retext('app/about/page.tsx:9:9', 'Four people, one studio'))).toMatchObject({ ok: false, message: 'Nothing changed. The code already says that.' });
    expect(orbit.edit('app/about/page.tsx:9:9', 'nonsense')).toMatchObject({ ok: false });
  });

  test('a label from the control replaces the generated summary', () => {
    const result = messy.edit('app/page.tsx:21:9', [{ op: 'replace-class', target: 'app/page.tsx:21:9', from: 'px-4', to: 'px-6' }], { label: 'Padding left and right: 4 to 6' });
    expect(result.ok && result.summary).toBe('Padding left and right: 4 to 6');
    expect(summarize([{ op: 'replace-class', target: 'a.tsx:1:1', from: 'px-4', to: 'px-6' }, { op: 'replace-class', target: 'a.tsx:1:1', from: 'rounded', to: '' }, { op: 'set-prop', target: 'a.tsx:1:1', name: 'intent', value: 'quiet' }]))
      .toBe('Change px-4 to px-6, remove rounded, set intent to quiet');
  });
});
