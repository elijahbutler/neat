import { notFound } from 'next/navigation';
import { Section } from '@/components/Section';
import { projects } from '@/lib/projects';

export function generateStaticParams() {
  return projects.map((project) => ({ slug: project.slug }));
}

export default async function WorkPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const project = projects.find((p) => p.slug === slug);
  if (!project) notFound();
  return (
    <main>
      <Section width="narrow">
        <p className="font-body text-sm text-ink-muted">{project.client}</p>
        <h1 className="mt-2 font-display text-5xl">{project.title}</h1>
      </Section>
    </main>
  );
}
