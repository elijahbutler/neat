import { Section } from '@/components/Section';
import Tag from '@/components/Tag';

export default function AboutPage() {
  return (
    <main>
      <Section width="narrow">
        <Tag tone="brand">About</Tag>
        <h1 className="mt-4 font-display text-5xl">Four people, one studio</h1>
        <p className="mt-6 font-body text-lg text-ink-muted">We started Orbit in 2019 to work on fewer projects, more carefully.</p>
      </Section>
    </main>
  );
}
