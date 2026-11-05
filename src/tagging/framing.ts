import type { NextConfig } from 'next';

const CSP = 'content-security-policy';
const INVALID_ORIGIN = 'Invalid editor origin for preview framing.';
type HeaderRule = Awaited<ReturnType<NonNullable<NextConfig['headers']>>>[number];

function frameOrigin(value: string): string {
  let origin: URL;
  try { origin = new URL(value); } catch { throw new Error(INVALID_ORIGIN); }
  if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.origin !== value) throw new Error(INVALID_ORIGIN);
  return origin.origin;
}

function framePolicy(value: string, origin: string): string {
  return value.split(',').map(policy => [
    ...policy.split(';').filter(directive => !/^[\t\n\f\r ]*frame-ancestors(?:[\t\n\f\r ]|$)/i.test(directive)),
    `frame-ancestors ${origin}`,
  ].join(';')).join(',');
}

function fallbackName(rules: HeaderRule[]): string {
  const names = new Set(rules.flatMap(rule => rule.headers.filter(header => header.key.toLowerCase() === CSP).map(header => header.key)));
  // Next groups exact spellings before Node writes headers case-insensitively.
  // A fresh spelling preserves the insertion position of every original key.
  const variants = 2 ** CSP.replace(/-/g, '').length;
  for (let mask = 0; mask < variants && mask <= names.size; mask++) {
    let bit = 0;
    const name = CSP.replace(/[a-z]/g, letter => (mask >>> bit++ & 1) ? letter.toUpperCase() : letter);
    if (!names.has(name)) return name;
  }
  throw new Error('Unsupported preview framing header configuration.');
}

/** Allow the generated sandbox to be framed by its own editor. Other CSP directives keep their meaning. */
export function withEditorFraming(config: NextConfig, editorOrigin: string): NextConfig {
  const origin = frameOrigin(editorOrigin);
  const originalHeaders = config.headers;
  return {
    ...config,
    async headers(this: NextConfig) {
      const rules = await originalHeaders?.call(this) ?? [];
      return [
        { source: '/:path*', headers: [{ key: fallbackName(rules), value: `frame-ancestors ${origin}` }] },
        ...rules.map(rule => ({ ...rule, headers: rule.headers.map(header => header.key.toLowerCase() === CSP
          ? { ...header, value: framePolicy(header.value, origin) }
          : { ...header }) })),
      ];
    },
  };
}
