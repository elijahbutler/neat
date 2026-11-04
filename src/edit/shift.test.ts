import { describe, expect, test } from 'bun:test';
import { invertSpans, lineColumnOf, mapOffset, offsetOf, relocateTag, type Span } from './shift';

const apply = (text: string, edits: Array<{ start: number; end: number; text: string }>) =>
  [...edits].reverse().reduce((out, e) => out.slice(0, e.start) + e.text + out.slice(e.end), text);
const spansOf = (edits: Array<{ start: number; end: number; text: string }>): Span[] => edits.map((e) => ({ start: e.start, end: e.end, length: e.text.length }));

const source = 'const a = 1;\nexport default () => (\n  <main>\n    <b className="x">B</b><i>I</i>\n  </main>\n);\n';

describe('positions', () => {
  test('lines and columns round-trip, counting lines by newline', () => {
    const at = offsetOf(source, 4, 5)!;
    expect(source.slice(at, at + 2)).toBe('<b');
    expect(lineColumnOf(source, at)).toEqual({ line: 4, column: 5 });
    expect(offsetOf(source, 9, 1)).toBeNull();
    expect(offsetOf(source, 1, 99)).toBeNull();
  });

  test('offsets after an insertion move by its length, and an insertion at the offset goes in front', () => {
    expect(mapOffset(10, [{ start: 4, end: 4, length: 3 }])).toBe(13);
    expect(mapOffset(10, [{ start: 10, end: 10, length: 3 }])).toBe(13);
    expect(mapOffset(10, [{ start: 11, end: 11, length: 3 }])).toBe(10);
  });

  test('replaced text before moves the offset by the difference, and an offset inside replaced text has no answer', () => {
    expect(mapOffset(10, [{ start: 2, end: 6, length: 1 }])).toBe(7);
    expect(mapOffset(10, [{ start: 8, end: 12, length: 1 }])).toBeNull();
    expect(mapOffset(10, [{ start: 10, end: 12, length: 5 }])).toBeNull();
    expect(mapOffset(10, [{ start: 5, end: 10, length: 2 }])).toBe(7);
  });

  test('inverted spans take an offset back to where it started', () => {
    const edits = [{ start: 3, end: 3, text: 'abcd' }, { start: 6, end: 9, text: 'z' }];
    const spans = spansOf(edits);
    for (const offset of [0, 2, 3, 9, 12, 20]) {
      const forward = mapOffset(offset, spans);
      expect(mapOffset(forward!, invertSpans(spans))).toBe(offset);
    }
  });
});

describe('relocating a tag', () => {
  const tag = 'app/page.tsx:4:27';
  test('a longer attribute on the same line moves the next element right', () => {
    const start = source.indexOf('x"');
    const edits = [{ start, end: start + 1, text: 'extra-long' }];
    const after = apply(source, edits);
    const moved = relocateTag(tag, source, after, spansOf(edits));
    expect(moved).toBe('app/page.tsx:4:36');
    const at = offsetOf(after, 4, 36)!;
    expect(after.slice(at, at + 2)).toBe('<i');
  });

  test('lines inserted above move the line and keep the column', () => {
    const edits = [{ start: 0, end: 0, text: "import x from 'x';\nimport y from 'y';\n" }];
    expect(relocateTag(tag, source, apply(source, edits), spansOf(edits))).toBe('app/page.tsx:6:27');
  });

  test('a tag that is not on an element, or lands on a different one, is not followed', () => {
    const edits = [{ start: 0, end: 0, text: 'x' }];
    expect(relocateTag('app/page.tsx:1:1', source, apply(source, edits), spansOf(edits))).toBeNull();
    // The spans claim nothing moved, but the text now differs: the tag name check refuses to guess.
    const swapped = source.replace('<i>I</i>', '<u>I</u>');
    expect(relocateTag(tag, source, swapped, [])).toBeNull();
    expect(relocateTag('not a tag', source, source, [])).toBeNull();
  });

  test('an element inside replaced text has no new tag', () => {
    const start = source.indexOf('<b');
    const edits = [{ start, end: start + 30, text: '<span />' }];
    expect(relocateTag('app/page.tsx:4:5', source, apply(source, edits), spansOf(edits))).toBeNull();
  });
});
