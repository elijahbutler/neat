import { describe, expect, test } from 'bun:test';
import { categorizeClass } from './classes';

describe('categorizeClass', () => {
  test.each([
    ['px-4', 'spacing'], ['-mt-2', 'spacing'], ['gap-x-3', 'spacing'], ['space-y-2', 'spacing'], ['p-[13px]', 'spacing'],
    ['rounded', 'radius'], ['rounded-lg', 'radius'], ['rounded-[10px]', 'radius'],
    ['text-sm', 'fontSize'], ['text-sm/6', 'fontSize'], ['text-2xl', 'fontSize'], ['text-[34px]', 'fontSize'],
    ['bg-primary', 'color'], ['text-muted-foreground', 'color'], ['border-border', 'color'], ['bg-primary/90', 'color'], ['bg-[#0a7d5a]', 'color'], ['text-white', 'color'],
  ])('%s is %s', (utility, category) => {
    expect(categorizeClass(utility)).toBe(category as ReturnType<typeof categorizeClass>);
  });

  test.each(['text-center', 'border', 'border-2', 'border-b', 'border-t-2', 'ring-1', 'shadow-sm', 'bg-cover', 'max-w-6xl', 'pointer-events-none', 'flex', 'text-balance', 'bg-clip-text', 'bg-top', 'bg-bottom', 'bg-origin-border'])('%s has no category', (utility) => {
    expect(categorizeClass(utility)).toBeNull();
  });
});
