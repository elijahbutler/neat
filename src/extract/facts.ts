import type { ComponentInfo, Fact, UsageProfile } from './types';

/** Facts computed from the profile. Each one cites at least one location. */
export function buildFacts(components: ComponentInfo[], usage: UsageProfile): Fact[] {
  const facts: Fact[] = [];
  const usageByKey = new Map(usage.components.map((u) => [`${u.file}:${u.line}`, u]));

  for (const c of components) {
    const u = usageByKey.get(`${c.file}:${c.line}`);
    if (u && u.uses >= 2) {
      for (const group of c.variants) {
        const counts: Record<string, number> = { ...(u.props[group.prop] ?? {}) };
        const explicit = Object.values(counts).reduce((a, b) => a + b, 0);
        if (group.defaultValue !== undefined && u.uses > explicit) counts[group.defaultValue] = (counts[group.defaultValue] ?? 0) + (u.uses - explicit);
        const [top] = Object.entries(counts)
          .filter(([value]) => value !== '{expression}')
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
        // Only a strict majority is a convention; ties and pluralities would teach the agent a rule that isn't there.
        if (top && top[1] * 2 > u.uses) facts.push({ id: `variant:${c.name}:${group.prop}`, text: `${c.name} uses ${group.prop}="${top[0]}" in ${top[1]} of ${u.uses} places`, evidence: u.sites.slice(0, 5) });
      }
    }
    if (c.kind === 'component' && c.exported && !u) {
      facts.push({ id: `unused:${c.name}`, text: `${c.name} is exported but never rendered in this repo`, evidence: [{ file: c.file, line: c.line }] });
    }
  }

  const byName = new Map<string, ComponentInfo[]>();
  for (const c of components) if (c.kind === 'component') byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  for (const [name, list] of byName) {
    const files = new Set(list.map((c) => c.file));
    if (files.size > 1) facts.push({ id: `duplicate:${name}`, text: `${name} is defined in ${files.size} files`, evidence: list.map((c) => ({ file: c.file, line: c.line })) });
  }

  for (const category of ['radius', 'fontSize'] as const) {
    const list = usage.classes[category];
    const total = list.reduce((a, b) => a + b.count, 0);
    const [top, second] = list;
    if (top && top.count >= 2 && (!second || top.count > second.count)) facts.push({ id: `common:${category}`, text: `${top.value} is the most common ${category === 'radius' ? 'radius' : 'font size'} class (${top.count} of ${total})`, evidence: [top.example] });
  }

  if (usage.bypasses.length) {
    const arbitrary = usage.bypasses.filter((b) => b.kind === 'arbitrary-class').length;
    const inline = usage.bypasses.length - arbitrary;
    const first = usage.bypasses[0]!;
    facts.push({
      id: 'bypass',
      text: `${usage.bypasses.length} values bypass tokens (${arbitrary} arbitrary classes, ${inline} inline styles), for example ${first.value} at ${first.file}:${first.line}`,
      evidence: usage.bypasses.slice(0, 5).map(({ file, line }) => ({ file, line })),
    });
  }

  const byToken = new Map<string, typeof usage.bypasses>();
  for (const b of usage.bypasses) if (b.token) byToken.set(b.token, [...(byToken.get(b.token) ?? []), b]);
  for (const [token, list] of byToken) {
    facts.push({ id: `token:${token}`, text: `${list.length} hardcoded values equal ${token}, for example ${list[0]!.value}; use the token instead`, evidence: list.slice(0, 5).map(({ file, line }) => ({ file, line })) });
  }

  for (const r of usage.repeatedClassLists) {
    facts.push({ id: `repeated:${r.tag}:${r.classes}`, text: `<${r.tag}> repeats the class list "${r.classes}" ${r.count} times; this may be a missing component`, evidence: r.examples });
  }

  return facts.sort((a, b) => a.id.localeCompare(b.id));
}
