import { expect, test } from 'bun:test';
import { moveTarget, patchLines, targetTags, type SelectedTarget } from './direct';

const target: SelectedTarget = {
  src: 'components/Card.tsx:5:3', inst: 'app/page.tsx:12:7', element: 'div', text: '',
  ancestors: [{ src: 'app/page.tsx:10:5', inst: null, childIndex: 0 }, { src: null, inst: 'app/page.tsx:8:3', childIndex: 1 }],
};

test('every distinct tag the selection holds is handed to the worker', () => {
  expect(targetTags(target)).toEqual(['components/Card.tsx:5:3', 'app/page.tsx:12:7', 'app/page.tsx:10:5', 'app/page.tsx:8:3']);
  expect(targetTags({ ...target, inst: null, ancestors: [] })).toEqual(['components/Card.tsx:5:3']);
});

test('the selection follows its tags, and a tag the worker did not mention stays', () => {
  const next = moveTarget(target, { 'app/page.tsx:12:7': 'app/page.tsx:13:7', 'app/page.tsx:10:5': 'app/page.tsx:11:5' })!;
  expect([next.src, next.inst]).toEqual(['components/Card.tsx:5:3', 'app/page.tsx:13:7']);
  expect(next.ancestors.map((a) => [a.src, a.inst])).toEqual([['app/page.tsx:11:5', null], [null, 'app/page.tsx:8:3']]);
});

test('losing the element that edits target loses the selection, while losing an ancestor does not', () => {
  expect(moveTarget(target, { 'app/page.tsx:12:7': null })).toBeNull();
  expect(moveTarget({ ...target, inst: null }, { 'components/Card.tsx:5:3': null })).toBeNull();
  const kept = moveTarget(target, { 'app/page.tsx:10:5': null, 'app/page.tsx:8:3': null })!;
  expect(kept.ancestors.map((a) => [a.src, a.inst])).toEqual([[null, null], [null, null]]);
  expect(kept.inst).toBe('app/page.tsx:12:7');
});

test('a step diff shows hunks, additions, removals, and context, and drops the file headers', () => {
  const patch = 'diff --git a/app/page.tsx b/app/page.tsx\nindex 1..2 100644\n--- a/app/page.tsx\n+++ b/app/page.tsx\n@@ -3,3 +3,3 @@ export default\n   <main>\n-    <h1>Hello</h1>\n+    <h1>Welcome</h1>\n   </main>\n\\ No newline at end of file\n';
  expect(patchLines(patch)).toEqual([
    { kind: 'hunk', text: '@@ -3,3 +3,3 @@' },
    { kind: ' ', text: '  <main>' },
    { kind: '-', text: '    <h1>Hello</h1>' },
    { kind: '+', text: '    <h1>Welcome</h1>' },
    { kind: ' ', text: '  </main>' },
  ]);
});
