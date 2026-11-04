import { Button } from '@/components/Button';
import { ProjectCard } from '@/components/ProjectCard';
import { Section } from '@/components/Section';
import { projects } from '@/lib/projects';

export default function Home() {
  return (
    <main>
      <Section>
        <h1 className="font-display text-6xl leading-tight">We design brands that people remember</h1>
        <p className="mt-6 max-w-xl font-body text-lg text-ink-muted">Orbit is a four-person studio working on identity, web, and print.</p>
        <div className="mt-10 flex gap-3">
          <Button href="/about">Start a project</Button>
          <Button intent="quiet" href="/work/harbor-coffee">See our work</Button>
        </div>
      </Section>
      <Section tone="ink">
        <h2 className="font-display text-3xl">Selected work</h2>
        <div className="mt-8 grid gap-6 md:grid-cols-3">
          {projects.map((project) => <ProjectCard key={project.slug} project={project} />)}
        </div>
      </Section>
    </main>
  );
}
