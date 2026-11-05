import { expect, test } from 'bun:test';
import type { NextConfig } from 'next';
import { withNeatTagging } from './with-tagging';

const editorOrigin = 'http://127.0.0.1:4460';
const options = { loaderPath: '/neat/loader.cjs', root: '/repo', editorOrigin };
const context = { defaultConfig: {} };
type HeaderRule = Awaited<ReturnType<NonNullable<NextConfig['headers']>>>[number];

async function headers(config: NextConfig): Promise<HeaderRule[]> {
  if (!config.headers) throw new Error('Expected response headers.');
  return config.headers();
}

test('the editor frame policy preserves every other policy and response header', async () => {
  const rules: HeaderRule[] = [{ source: '/:path*', headers: [
    { key: 'Content-Security-Policy', value: "default-src 'self'; frame-ancestors 'none'; script-src 'self'; script-src 'none', img-src data:; FRAME-ANCESTORS 'self'; unknown-directive sample" },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Content-Security-Policy-Report-Only', value: "frame-ancestors 'none'; report-uri /report" },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
  ] }];
  const original = structuredClone(rules);
  let calls = 0;
  let receiver: NextConfig | undefined;
  const config: NextConfig = { poweredByHeader: false, async headers() { receiver = this; calls++; return rules; } };
  const resolved = await withNeatTagging(config, options)('phase-development-server', context);
  expect(calls).toBe(0);
  expect(await headers(resolved)).toEqual([
    { source: '/:path*', headers: [{ key: 'content-security-policy', value: `frame-ancestors ${editorOrigin}` }] },
    { source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: `default-src 'self'; script-src 'self'; script-src 'none';frame-ancestors ${editorOrigin}, img-src data:; unknown-directive sample;frame-ancestors ${editorOrigin}` },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy-Report-Only', value: "frame-ancestors 'none'; report-uri /report" },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
    ] },
  ]);
  expect(calls).toBe(1);
  expect(receiver).toBe(resolved);
  expect(rules).toEqual(original);
});

test('the fallback preserves the effective winner across overlapping mixed-case CSP headers', async () => {
  const config: NextConfig = { async headers() { return [
    { source: '/:path*', headers: [{ key: 'content-security-policy', value: "default-src 'none'" }] },
    { source: '/:path*', headers: [{ key: 'Content-Security-Policy', value: "script-src 'self'" }] },
  ]; } };
  const transformed = await headers(await withNeatTagging(config, options)('phase-development-server', context));
  expect(transformed[0]).toEqual({ source: '/:path*', headers: [{ key: 'Content-security-policy', value: `frame-ancestors ${editorOrigin}` }] });
  // Next groups exact spellings before Node writes names case-insensitively.
  const exactNames = new Map<string, string>();
  for (const rule of transformed) for (const header of rule.headers) exactNames.set(header.key, header.value);
  const response = new Headers();
  for (const [key, value] of exactNames) response.set(key, value);
  expect(response.get('content-security-policy')).toBe(`script-src 'self';frame-ancestors ${editorOrigin}`);
});

test('frame directive matching uses complete names and ASCII whitespace', async () => {
  const config: NextConfig = { headers: () => [{ source: '/:path*', headers: [
    { key: 'Content-Security-Policy', value: "frame-ancestors-extra keep;\tFRAME-ANCESTORS\t'none';\u00a0frame-ancestors retain; frame-ancestors 'self'; default-src 'self'" },
  ] }] };
  const result = await headers(await withNeatTagging(config, options)('phase-development-server', context));
  expect(result[1]?.headers[0]?.value).toBe(`frame-ancestors-extra keep;\u00a0frame-ancestors retain; default-src 'self';frame-ancestors ${editorOrigin}`);
});

test('a preview without configured response headers allows only its editor parent', async () => {
  const result = await withNeatTagging({}, options)('phase-development-server', context);
  expect(await headers(result)).toEqual([{ source: '/:path*', headers: [{ key: 'content-security-policy', value: `frame-ancestors ${editorOrigin}` }] }]);
});

test('missing origins and other Next phases preserve the configured header hook', async () => {
  const originalHeaders = () => [{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }];
  const config: NextConfig = { headers: originalHeaders };
  const missing = await withNeatTagging(config, { loaderPath: options.loaderPath, root: options.root })('phase-development-server', context);
  expect(missing.headers).toBe(originalHeaders);
  for (const phase of ['phase-production-build', 'phase-production-server', 'phase-export']) {
    const resolved = await withNeatTagging(config, options)(phase, context);
    expect(resolved.headers).toBe(originalHeaders);
    expect(await headers(resolved)).toEqual([{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }] }]);
  }
});

test('the preview refuses noncanonical and non-loopback editor origins with a fixed message', async () => {
  for (const editorOrigin of [
    'https://outside.example.test', 'http://localhost:4460', 'http://127.0.0.1:4460/path',
    'http://127.0.0.1:4460/', 'http://127.0.0.1:4460?token=fake', 'http://127.0.0.1:4460#fragment',
    'http://fake:fake@127.0.0.1:4460', 'http://*.example.test', 'http://127.0.0.1:4460\n',
  ]) {
    await expect(Promise.resolve().then(() => withNeatTagging({}, { ...options, editorOrigin })('phase-development-server', context))).rejects.toThrow('Invalid editor origin for preview framing.');
  }
});

test('the original header hook keeps its error behavior', async () => {
  const error = new Error('Header loading failed.');
  const resolved = await withNeatTagging({ headers: () => { throw error; } }, options)('phase-development-server', context);
  await expect(headers(resolved)).rejects.toBe(error);
});
