import { describe, expect, test } from 'bun:test';
import { findToken, normalizeValue, substituteTokens } from './token-match';
import type { CssVariable, TokenProfile } from './types';

const variable = (name: string, value: string, scope: string): CssVariable => ({ name, value, resolved: value, scope, file: 'app/globals.css', line: 1 });
const profile = (variables: CssVariable[]): TokenProfile => ({ variables, colors: {}, fonts: {}, radius: {}, unresolved: [] });

describe('token matching', () => {
  test('normalizes short hex and case', () => {
    expect(normalizeValue('#0A7')).toBe('#00aa77');
    expect(normalizeValue(' RGB(1, 2, 3) ')).toBe('rgb(1,2,3)');
  });

  test('names a utility only for Tailwind v4 @theme variables', () => {
    const theme = profile([variable('--color-brand', '#0a7d5a', '@theme')]);
    const root = profile([variable('--color-brand', '#0a7d5a', ':root')]);
    expect(substituteTokens('bg-[#0a7d5a]', theme, 4).classes).toBe('bg-brand');
    expect(substituteTokens('hover:bg-[#0a7d5a]', root, 4).classes).toBe('hover:bg-(--color-brand)');
    expect(substituteTokens('bg-[#0a7d5a]', theme, 3).classes).toBe('bg-[var(--color-brand)]');
  });

  test('prefers the @theme alias and refuses values with two roles', () => {
    const aliased = profile([variable('--brand', '#0a7d5a', ':root'), variable('--color-brand', '#0a7d5a', '@theme')]);
    expect(findToken(aliased, '#0a7d5a', 'color')?.name).toBe('--color-brand');
    const twoRoles = profile([variable('--color-card', '#ffffff', '@theme'), variable('--color-white', '#fff', '@theme')]);
    expect(findToken(twoRoles, '#fff', 'color')).toBeNull();
    expect(findToken(twoRoles, '#000', 'color')).toBeNull();
  });
});
