import type { ReactNode } from 'react';

const tones = { paper: 'bg-paper text-ink', ink: 'bg-ink text-paper' };
const widths = { narrow: 'max-w-3xl', wide: 'max-w-6xl' };

export function Section({ tone = 'paper', width = 'wide', children }: { tone?: 'paper' | 'ink'; width?: 'narrow' | 'wide'; children: ReactNode }) {
  return (
    <section className={`${tones[tone]} py-20`}>
      <div className={`mx-auto px-6 ${widths[width]}`}>{children}</div>
    </section>
  );
}
