import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { EDIT_SYSTEM } from './agent';
import { editOperationsSchema, type EditOperation } from './operations';

export type EditProvider = 'anthropic' | 'openai';

export interface EditModelConfig {
  provider: EditProvider;
  apiKey: string;
  baseURL?: string;
  model: string;
  source: 'NEAT_MODEL_PROXY_URL' | 'LLM_API_KEY' | 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY';
}

export type CallEditModel = (messages: Anthropic.MessageParam[], options?: { signal?: AbortSignal; maxTokens?: number }) => Promise<{
  operations: EditOperation[];
  raw: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}>;

const envelopeSchema = z.object({ operations: editOperationsSchema }).strict();

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The development proxy uses Anthropic's protocol. Direct Anthropic keys take priority over OpenAI. */
export function resolveEditModel(env: Record<string, string | undefined> = process.env): EditModelConfig | null {
  const model = clean(env.LLM_EDIT_MODEL);
  const proxy = clean(env.NEAT_MODEL_PROXY_URL);
  if (proxy) return { provider: 'anthropic', apiKey: clean(env.LLM_API_KEY) ?? 'neat-dev', baseURL: proxy,
    model: model ?? 'gpt-5.5', source: 'NEAT_MODEL_PROXY_URL' };
  const key = clean(env.LLM_API_KEY) ?? clean(env.ANTHROPIC_API_KEY);
  if (key) {
    const provider = clean(env.LLM_PROVIDER)?.toLowerCase() === 'openai' && clean(env.LLM_API_KEY) ? 'openai' : 'anthropic';
    const baseURL = clean(env.LLM_BASE_URL) ?? clean(provider === 'openai' ? env.OPENAI_BASE_URL : env.ANTHROPIC_BASE_URL);
    return { provider, apiKey: key, ...(baseURL ? { baseURL } : {}),
      model: model ?? (provider === 'openai' ? 'gpt-5.5' : 'claude-sonnet-5'),
      source: clean(env.LLM_API_KEY) ? 'LLM_API_KEY' : 'ANTHROPIC_API_KEY' };
  }
  const openai = clean(env.OPENAI_API_KEY);
  return openai ? { provider: 'openai', apiKey: openai,
    baseURL: clean(env.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1', model: model ?? 'gpt-5.5', source: 'OPENAI_API_KEY' } : null;
}

export const MODEL_SETUP_NOTE = 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY to use Ask. Direct edits work without a key.';

export interface EditClient {
  messages: {
    parse(params: Anthropic.MessageCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<{
      parsed_output?: unknown;
      content: Anthropic.ContentBlock[];
      usage: Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'> & Partial<Anthropic.Usage>;
    }>;
  };
}

function messageText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block) => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n\n');
}

export interface OpenAiModelOptions {
  apiKey: string;
  baseURL?: string;
  model: string;
  system?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * Call an OpenAI-compatible `/chat/completions` endpoint with structured JSON output
 * validated through `editOperationsSchema`.
 */
export function openaiEditModel(options: OpenAiModelOptions): CallEditModel {
  const baseURL = (options.baseURL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const fetchFn = options.fetch ?? globalThis.fetch;
  const jsonSchema = z.toJSONSchema(envelopeSchema);

  return async (messages, callOptions = {}) => {
    callOptions.signal?.throwIfAborted();
    const openAiMessages = [
      { role: 'system', content: options.system ?? EDIT_SYSTEM },
      ...messages.map((m) => ({ role: m.role, content: messageText(m.content) })),
    ];

    const res = await fetchFn(`${baseURL}/chat/completions`, {
      method: 'POST',
      signal: callOptions.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        max_completion_tokens: callOptions.maxTokens ?? 16000,
        messages: openAiMessages,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'edit_operations',
            strict: false,
            schema: jsonSchema,
          },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`OpenAI edit model request failed (${res.status}): ${detail.slice(0, 300)}`);
    }

    const tokens = z.number().int().nonnegative();
    const data = z.object({
      choices: z.array(z.object({ message: z.object({ content: z.string().nullable().optional() }).optional() })).optional(),
      usage: z.object({ prompt_tokens: tokens.optional(), completion_tokens: tokens.optional(),
        prompt_tokens_details: z.object({ cached_tokens: tokens.optional() }).optional() }).optional(),
    }).parse(await res.json());

    const raw = data.choices?.[0]?.message?.content;
    if (!raw || typeof raw !== 'string') {
      throw new Error('OpenAI edit model returned no message content');
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (err) {
      throw new Error(`OpenAI edit model returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }

    const operations = Array.isArray(parsedJson)
      ? editOperationsSchema.parse(parsedJson)
      : envelopeSchema.parse(parsedJson).operations;

    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const promptTokens = data.usage?.prompt_tokens ?? 0;
    return {
      operations,
      raw,
      usage: {
        input: Math.max(0, promptTokens - cached),
        output: data.usage?.completion_tokens ?? 0,
        cacheRead: cached,
        cacheWrite: 0,
      },
    };
  };
}

/** Build an `Anthropic`-compatible client for `proposeEdit` from a resolved `EditModelConfig`. */
export function createEditClient(
  config: EditModelConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): EditClient {
  if (config.provider === 'openai') {
    return { messages: { parse: async (params, requestOptions) => {
      const call = openaiEditModel({ ...config, system: typeof params.system === 'string' ? params.system :
        params.system?.map(b => b.text).join('\n\n'), fetch: options.fetch });
      const result = await call(params.messages, { signal: requestOptions?.signal, maxTokens: params.max_tokens });
      return { parsed_output: { operations: result.operations }, content: [{ type: 'text', text: result.raw, citations: null }],
        usage: { input_tokens: result.usage.input, output_tokens: result.usage.output,
          cache_read_input_tokens: result.usage.cacheRead, cache_creation_input_tokens: result.usage.cacheWrite } };
    } } };
  }

  return new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    maxRetries: 0,
  });
}

/** Build a `CallEditModel` function from a resolved `EditModelConfig`. */
export function createEditModel(
  config: EditModelConfig,
  options: { fetch?: typeof globalThis.fetch } = {},
): CallEditModel {
  if (config.provider === 'openai') {
    return openaiEditModel({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      fetch: options.fetch,
    });
  }
  const client = createEditClient(config, options);
  return async (messages, callOptions = {}) => {
    callOptions.signal?.throwIfAborted();
    const response = await client.messages.parse({
      model: config.model,
      max_tokens: callOptions.maxTokens ?? 16000,
      system: [{ type: 'text', text: EDIT_SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { format: { type: 'json_schema', schema: z.toJSONSchema(envelopeSchema) }, effort: 'medium' },
      messages,
    }, { signal: callOptions.signal });
    const operations = envelopeSchema.parse(response.parsed_output).operations;
    return {
      operations,
      raw: JSON.stringify({ operations }),
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0,
        cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      },
    };
  };
}
