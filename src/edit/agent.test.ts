import type Anthropic from '@anthropic-ai/sdk';
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { extractDesignSystem } from '../extract/profile';
import type { EditClient } from './model';
import { proposeEdit } from './agent';
import { buildRepoIndex, loadEditProject } from './index';
import type { EditOperation } from './operations';

const root = join(import.meta.dir, '..', '..', 'fixtures', 'orbit-studio');
const project = loadEditProject(root);
const index = buildRepoIndex(extractDesignSystem(root), project, root);

/** A stand-in for the model that answers each call with the next scripted set of operations. No network. */
function scripted(replies: EditOperation[][]) {
  const seen: Anthropic.MessageParam[][] = [];
  const client = {
    messages: {
      parse: async (params: { messages: Anthropic.MessageParam[] }) => {
        seen.push([...params.messages]);
        return { content: [], parsed_output: { operations: replies[seen.length - 1] }, usage: { input_tokens: 1, output_tokens: 1 } };
      },
    },
  } satisfies EditClient;
  const ask = (tag: string, allow?: string[]) => proposeEdit({ client, model: 'test', project, root, index, route: '/', tag, instruction: 'Change it', allow });
  return { seen, ask };
}

test('an out-of-scope operation goes back to the model, and the retry inside the selection is kept', async () => {
  const { seen, ask } = scripted([
    [{ op: 'set-text', target: 'app/page.tsx:18:9', text: 'Recent work' }],
    [{ op: 'set-text', target: 'app/page.tsx:10:9', text: 'Brands people remember' }],
  ]);
  const outcome = await ask('app/page.tsx:10:9');
  expect(outcome.attempts).toBe(2);
  expect(outcome.changes?.map((c) => c.file)).toEqual(['app/page.tsx']);
  expect(outcome.confirm).toEqual([]);
  expect(outcome.errors).toEqual(['operation 0 (out-of-scope): That target is outside the selected element (app/page.tsx:10:9). Only the selected element and the elements inside it can change.']);
  expect(seen[1]!.at(-1)).toEqual({ role: 'user', content: `That didn't work:\n${outcome.errors[0]}\n\nTry again.` });
});

test('a change to a shared component fails with what to confirm, and passes once it is allowed', async () => {
  const section: EditOperation[] = [{ op: 'set-prop', target: 'components/Section.tsx:8:5', name: 'id', value: 'top' }];
  // The selection is the Section instance on the home page; its definition is in another file.
  const script = scripted([section, section, section]);
  const refused = await script.ask('app/page.tsx:9:7');
  expect(script.seen).toHaveLength(1);
  expect(refused.changes).toBeNull();
  expect(refused.attempts).toBe(1);
  expect(refused.confirm.map((c) => [c.component, c.file])).toEqual([['Section', 'components/Section.tsx']]);

  const allowed = await scripted([section]).ask('app/page.tsx:9:7', [refused.confirm[0]!.allow]);
  expect(allowed.changes?.map((c) => c.file)).toEqual(['components/Section.tsx']);
});

test('no model returns setup instructions before resolving a selection', async () => {
  const result = await proposeEdit({ client: null, model: '', project, root, index, route: '/', tag: 'invalid', instruction: 'Edit' });
  expect(result.status).toBe('no-model');
  expect(result.note).toContain('ANTHROPIC_API_KEY');
  expect(result.attempts).toBe(0);
});

test('a token overrun rejects before applying an edit, and abort prevents the model call', async () => {
  const source = project.getSourceFileOrThrow(join(root, 'app/page.tsx')).getFullText();
  let calls = 0;
  const client: EditClient = { messages: { parse: async () => { calls++; return { content: [],
    parsed_output: { operations: [{ op: 'set-text', target: 'app/page.tsx:10:9', text: 'Wrong' }] },
    usage: { input_tokens: 100000, output_tokens: 100000 } }; } } };
  const req = { client, model: 'test', project, root, index, route: '/', tag: 'app/page.tsx:10:9', instruction: 'Edit' };
  await expect(proposeEdit({ ...req, maxTotalTokens: 10 })).rejects.toThrow('token budget exceeded');
  expect(project.getSourceFileOrThrow(join(root, 'app/page.tsx')).getFullText()).toBe(source);
  await expect(proposeEdit({ ...req, signal: AbortSignal.abort() })).rejects.toThrow();
  expect(calls).toBe(0);
  await expect(proposeEdit({ ...req, maxTotalTokens: 64000 })).rejects.toThrow('token budget exceeded');
  expect(calls).toBe(1);
  expect(project.getSourceFileOrThrow(join(root, 'app/page.tsx')).getFullText()).toBe(source);
});

test('attempt budget stops repeated invalid edits', async () => {
  let calls = 0;
  const client: EditClient = { messages: { parse: async () => { calls++; return { content: [],
    parsed_output: { operations: [{ op: 'set-text', target: 'app/page.tsx:18:9', text: 'Outside' }] },
    usage: { input_tokens: 1, output_tokens: 1 } }; } } };
  const result = await proposeEdit({ client, model: 'test', project, root, index, route: '/', tag: 'app/page.tsx:10:9', instruction: 'Edit', maxAttempts: 1 });
  expect(result.errors[0]).toContain('out-of-scope');
  expect(calls).toBe(1);
});

test('confirmation also stops retries when another operation is outside the selection', async () => {
  const script = scripted([[{ op: 'set-prop', target: 'components/Section.tsx:8:5', name: 'id', value: 'top' },
    { op: 'set-text', target: 'app/page.tsx:18:9', text: 'Outside' }]]);
  const result = await script.ask('app/page.tsx:9:7');
  expect(result.confirm.map(c => c.component)).toEqual(['Section']);
  expect(result.changes).toBeNull();
  expect(script.seen).toHaveLength(1);
});
