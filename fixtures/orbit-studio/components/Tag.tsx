import type { ReactNode } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

const tag = cva('inline-block rounded-full px-3 py-1 font-body text-xs uppercase tracking-wide', {
  variants: {
    tone: {
      neutral: 'bg-paper text-ink-muted ring-1 ring-rule',
      brand: 'bg-brand text-brand-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export default function Tag({ tone, children }: VariantProps<typeof tag> & { children: ReactNode }) {
  return <span className={tag({ tone })}>{children}</span>;
}
