import { sharedTag } from './fixture.mjs';

// A real HTTP endpoint for the production model adapter. The browser still sends
// Ask through the worker; no worker responses or edit operations are mocked.
export function startScriptedProvider(port) {
  const calls = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/chat/completions') return new Response('Not found', { status: 404 });
    try {
      const body = await request.json();
      const message = body.messages?.find(m => m.role === 'user')?.content;
      if (typeof message !== 'string') throw new Error('Expected a context message');
      const data = /<context>\s*([\s\S]*?)\s*<\/context>/.exec(message)?.[1];
      if (!data) throw new Error('Missing context packet');
      const context = JSON.parse(data);
      const selected = context.source?.elements?.find(el => el.element === 'h1');
      let operations;
      if (message.endsWith('Request: acceptance insert before heading')) {
        if (!selected || typeof selected.tag !== 'string') throw new Error('Missing heading source tag');
        operations = [{ op: 'insert-jsx', anchor: selected.tag, position: 'before', jsx: '<p>Inserted by scripted Ask</p>' }];
      } else if (message.endsWith('Request: acceptance shared label')) {
        operations = [{ op: 'set-text', target: sharedTag(), text: 'Confirmed shared label' }];
      } else throw new Error('Unexpected scripted instruction');
      calls.push({ instruction: message.split('Request: ').at(-1), operations });
      return Response.json({ choices: [{ message: { content: JSON.stringify({ operations }) } }], usage: { prompt_tokens: 100, completion_tokens: 30 } });
    } catch (error) {
      return Response.json({ error: error.message }, { status: 400 });
    }
  } });
  return { calls, close: () => server.stop(true) };
}
