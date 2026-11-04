import { describe, expect, test } from 'bun:test';
import { createEditModel, openaiEditModel, resolveEditModel } from './model';

describe('resolveEditModel', () => {
  test('returns null when no API key is present', () => {
    expect(resolveEditModel({})).toBeNull();
    expect(resolveEditModel({ LLM_API_KEY: '   ', ANTHROPIC_API_KEY: '' })).toBeNull();
  });

  test('prioritizes LLM_API_KEY first and defaults model based on LLM_BASE_URL', () => {
    expect(
      resolveEditModel({
        LLM_API_KEY: 'proxy-key',
        LLM_BASE_URL: 'http://localhost:8317',
        ANTHROPIC_API_KEY: 'sk-ant-ignored',
        OPENAI_API_KEY: 'sk-proj-ignored',
      }),
    ).toEqual({
      provider: 'anthropic',
      apiKey: 'proxy-key',
      baseURL: 'http://localhost:8317',
      model: 'claude-sonnet-5',
      source: 'LLM_API_KEY',
    });

    expect(resolveEditModel({ LLM_API_KEY: 'direct-key' })).toEqual({
      provider: 'anthropic',
      apiKey: 'direct-key',
      model: 'claude-sonnet-5',
      source: 'LLM_API_KEY',
    });

    expect(
      resolveEditModel({
        LLM_API_KEY: 'custom-key',
        LLM_EDIT_MODEL: 'claude-opus-4-6',
      }),
    ).toEqual({
      provider: 'anthropic',
      apiKey: 'custom-key',
      model: 'claude-opus-4-6',
      source: 'LLM_API_KEY',
    });
  });

  test('resolves ANTHROPIC_API_KEY before OPENAI_API_KEY', () => {
    expect(
      resolveEditModel({
        ANTHROPIC_API_KEY: 'sk-ant-123',
        OPENAI_API_KEY: 'sk-openai-456',
      }),
    ).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-123',
      model: 'claude-sonnet-5',
      source: 'ANTHROPIC_API_KEY',
    });

    expect(
      resolveEditModel({
        ANTHROPIC_API_KEY: 'sk-ant-123',
        ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
        LLM_EDIT_MODEL: 'claude-3-7-sonnet-latest',
      }),
    ).toEqual({
      provider: 'anthropic',
      apiKey: 'sk-ant-123',
      baseURL: 'https://anthropic.example.com',
      model: 'claude-3-7-sonnet-latest',
      source: 'ANTHROPIC_API_KEY',
    });
  });

  test('resolves OPENAI_API_KEY with default gpt-5.5 model and baseURL', () => {
    expect(resolveEditModel({ OPENAI_API_KEY: 'sk-openai-789' })).toEqual({
      provider: 'openai',
      apiKey: 'sk-openai-789',
      baseURL: 'https://api.openai.com/v1',
      model: 'gpt-5.5',
      source: 'OPENAI_API_KEY',
    });

    expect(
      resolveEditModel({
        OPENAI_API_KEY: 'sk-openai-789',
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/',
        LLM_EDIT_MODEL: 'gpt-5.5-mini',
      }),
    ).toEqual({
      provider: 'openai',
      apiKey: 'sk-openai-789',
      baseURL: 'https://openrouter.ai/api/v1/',
      model: 'gpt-5.5-mini',
      source: 'OPENAI_API_KEY',
    });
  });
});

describe('openaiEditModel', () => {
  test('calls /chat/completions with json_schema response_format and validates editOperationsSchema', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                operations: [{ op: 'set-text', target: 'app/page.tsx:10:7', text: 'Updated heading' }],
              }),
            },
          },
        ],
        usage: {
          prompt_tokens: 500,
          completion_tokens: 45,
          prompt_tokens_details: { cached_tokens: 100 },
        },
      });
    }) as unknown as typeof fetch;

    const config = resolveEditModel({
      OPENAI_API_KEY: 'sk-test-openai',
      OPENAI_BASE_URL: 'https://api.example.com/v1/',
    })!;
    const call = createEditModel(config, { fetch: fakeFetch });
    const res = await call([{ role: 'user', content: [{ type: 'text', text: 'Retext heading' }] }]);

    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    expect((capturedInit?.headers as Record<string, string>).authorization).toBe('Bearer sk-test-openai');
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe('gpt-5.5');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.name).toBe('edit_operations');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1]).toEqual({ role: 'user', content: 'Retext heading' });

    expect(res.operations).toEqual([{ op: 'set-text', target: 'app/page.tsx:10:7', text: 'Updated heading' }]);
    expect(res.usage).toEqual({ input: 400, output: 45, cacheRead: 100, cacheWrite: 0 });
  });

  test('rejects malformed operations and HTTP errors', async () => {
    const badSchemaFetch = (async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify({ operations: [{ op: 'unknown-op' }] }) } }],
      })) as unknown as typeof fetch;

    const callBad = openaiEditModel({ apiKey: 'k', model: 'gpt-5.5', fetch: badSchemaFetch });
    await expect(callBad([{ role: 'user', content: 'hi' }])).rejects.toThrow();

    const errorFetch = (async () => new Response('invalid api key', { status: 401 })) as unknown as typeof fetch;
    const callErr = openaiEditModel({ apiKey: 'k', model: 'gpt-5.5', fetch: errorFetch });
    await expect(callErr([{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
  });
});

test('proxy override, whitespace, and provider-specific base URLs resolve explicitly', () => {
  expect(resolveEditModel({ NEAT_MODEL_PROXY_URL: ' http://127.0.0.1:8317 ', ANTHROPIC_API_KEY: 'a' })).toEqual({
    provider: 'anthropic', apiKey: 'neat-dev', model: 'gpt-5.5', baseURL: 'http://127.0.0.1:8317', source: 'NEAT_MODEL_PROXY_URL',
  });
  expect(resolveEditModel({ ANTHROPIC_API_KEY: ' ', OPENAI_API_KEY: ' o ', OPENAI_BASE_URL: ' ' })?.apiKey).toBe('o');
  expect(resolveEditModel({ LLM_API_KEY: 'o', LLM_PROVIDER: 'openai' })?.model).toBe('gpt-5.5');
});

test('Anthropic adapter sends Messages structured output and validates the response', async () => {
  let body: Record<string, unknown> = {};
  let url = '';
  const fakeFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    url = String(input); body = JSON.parse(String(init?.body));
    return Response.json({ id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
      content: [{ type: 'text', text: JSON.stringify({ operations: [{ op: 'set-text', target: 'app/page.tsx:1:1', text: 'Hello' }] }) }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 12, output_tokens: 4 } });
  }, { preconnect: () => {} });
  const call = createEditModel(resolveEditModel({ ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'https://example.test' })!, { fetch: fakeFetch });
  const result = await call([{ role: 'user', content: 'Hello' }], { maxTokens: 50 });
  expect(url).toBe('https://example.test/v1/messages');
  expect(body.max_tokens).toBe(50);
  expect(body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  expect(result.operations).toEqual([{ op: 'set-text', target: 'app/page.tsx:1:1', text: 'Hello' }]);
  expect(result.usage).toEqual({ input: 12, output: 4, cacheRead: 0, cacheWrite: 0 });
});

for (const env of [{ OPENAI_API_KEY: 'test' }, { ANTHROPIC_API_KEY: 'test' }]) {
  test(`cancels an in-flight ${Object.keys(env)[0]} request`, async () => {
    const controller = new AbortController();
    const fakeFetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true });
        controller.abort();
      });
    }, { preconnect: () => {} });
    const call = createEditModel(resolveEditModel(env)!, { fetch: fakeFetch });
    await expect(call([{ role: 'user', content: 'hi' }], { signal: controller.signal })).rejects.toThrow();
  });
}
