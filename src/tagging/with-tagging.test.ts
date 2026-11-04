import { describe, expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { addTagging, withNeatTagging } from './with-tagging';

const opts = { loaderPath: '/neat/loader.cjs', root: '/repo' };
const ctx = { defaultConfig: {} };

describe('addTagging', () => {
  test('adds a development-only rule for tsx and jsx', () => {
    const rules = addTagging({}, opts).turbopack?.rules;
    expect(rules?.['*.tsx']).toEqual({
      loaders: [{ loader: '/neat/loader.cjs', options: { root: '/repo' } }],
      condition: { all: ['development', { not: 'foreign' }] },
    });
    expect(rules?.['*.jsx']).toBeDefined();
    expect(rules?.['*.js']).toBeDefined();
  });

  // Review focus 3: keep the customer's own rules and webpack function.
  test('keeps an existing tsx rule and appends ours', () => {
    const existing = { loaders: ['svgr-loader'], as: '*.js' };
    const rules = addTagging({ turbopack: { rules: { '*.tsx': existing } } }, opts).turbopack?.rules;
    expect(Array.isArray(rules?.['*.tsx'])).toBe(true);
    expect((rules?.['*.tsx'] as unknown[])[0]).toEqual(existing);
  });

  test('lets the preview host use the hot-reload socket, and keeps hosts the repo already lists', () => {
    expect(addTagging({}, opts).allowedDevOrigins).toEqual(['127.0.0.1']);
    expect(addTagging({ allowedDevOrigins: ['dev.example.com', '127.0.0.1'] }, opts).allowedDevOrigins).toEqual(['dev.example.com', '127.0.0.1']);
  });

  test('wraps shorthand loader lists before appending', () => {
    const rules = addTagging({ turbopack: { rules: { '*.tsx': ['a-loader'] } } }, opts).turbopack?.rules;
    expect((rules?.['*.tsx'] as unknown[])[0]).toEqual({ loaders: ['a-loader'] });
  });

  test('chains an existing webpack function and adds the loader only in dev', () => {
    const calls: string[] = [];
    const config = addTagging({ webpack: (c: { module: { rules: unknown[] } }) => { calls.push('user'); return c; } }, opts);
    const dev = config.webpack!({ module: { rules: [] } }, { dev: true } as never);
    const prod = config.webpack!({ module: { rules: [] } }, { dev: false } as never);
    expect(calls).toEqual(['user', 'user']);
    expect(dev.module.rules).toHaveLength(1);
    expect(prod.module.rules).toHaveLength(0);
  });
});

describe('withNeatTagging', () => {
  test('accepts an object config', async () => {
    const config = await withNeatTagging({ poweredByHeader: false }, opts)('phase-development-server', ctx);
    expect(config.poweredByHeader).toBe(false);
    expect(config.turbopack?.rules?.['*.tsx']).toBeDefined();
  });

  test('accepts an async function config and passes the phase through', async () => {
    const input = async (phase: string): Promise<NextConfig> => ({ env: { PHASE: phase } });
    const config = await withNeatTagging(input, opts)('phase-development-server', ctx);
    expect(config.env).toEqual({ PHASE: 'phase-development-server' });
  });
});
