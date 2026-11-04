import type { DesignSystemProfile } from './types';

export function formatProfileSummary(p: DesignSystemProfile): string {
  const components = p.components.filter((c) => c.kind === 'component');
  const roles = [
    ...Object.entries(p.tokens.colors).map(([role, t]) => `color.${role}: ${t.variable}`),
    ...Object.entries(p.tokens.fonts).map(([role, t]) => `font.${role}: ${t.variable}`),
    ...Object.entries(p.tokens.radius).map(([role, t]) => `radius.${role}: ${t.variable}`),
  ];
  const lines = [
    `${p.project}${p.commit ? ` @ ${p.commit}` : ''}`,
    `Next ${p.framework.next ?? 'not found'}, React ${p.framework.react ?? 'not found'}, Tailwind ${p.framework.tailwind ?? 'not found'}`,
    '',
    `${components.length} components (${components.filter((c) => c.exported).length} exported), ${p.components.length - components.length} pages, layouts, and route files`,
    ...components.map((c) => `  ${c.name}  ${c.file}:${c.line}${c.variants.length ? `  variants: ${c.variants.map((v) => `${v.prop}=${v.options.join('|')}`).join(', ')}` : ''}`),
    '',
    `Tokens (${p.tokens.variables.length} variables)`,
    ...roles.map((r) => `  ${r}`),
    ...(p.tokens.unresolved.length ? [`  unresolved: ${p.tokens.unresolved.join(', ')}`] : []),
    '',
    `Facts (${p.facts.length})`,
    ...p.facts.map((f) => `  ${f.text}`),
    ...(p.warnings.length ? ['', 'Warnings', ...p.warnings.map((w) => `  ${w}`)] : []),
  ];
  return lines.join('\n');
}
