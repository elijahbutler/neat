import Link from 'next/link';
import Tag from './Tag';

export type Project = { slug: string; title: string; client: string; year: number; tags: string[] };

export function ProjectCard({ project }: { project: Project }) {
  return (
    <Link href={`/work/${project.slug}`} className="group block rounded-card border border-rule p-6 transition-colors hover:border-ink">
      <p className="font-body text-sm text-ink-muted">{project.client}, {project.year}</p>
      <h3 className="mt-2 font-display text-2xl group-hover:text-brand">{project.title}</h3>
      <div className="mt-4 flex flex-wrap gap-2">
        {project.tags.map((t) => <Tag key={t}>{t}</Tag>)}
      </div>
    </Link>
  );
}
