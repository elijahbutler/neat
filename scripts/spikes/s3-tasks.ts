// Eval tasks for the edit agent on fixtures/orbit-studio. Each grader reads the files after the edit and returns
// null on success or the reason it failed. Graders check the intent, not one exact spelling of the answer.

export interface EvalTask {
  id: string;
  /** Page the user is looking at. */
  route: string;
  /** Source tag of the clicked element. */
  tag: string;
  instruction: string;
  /** Files the edit may change. Anything else changing fails the task. */
  files: string[];
  grade: (read: (file: string) => string) => string | null;
}

/** The first JSX opening tag in `text` that starts with `<name` and contains `marker` before its closing tag. */
function element(text: string, name: string, marker: string): string | null {
  const re = new RegExp(`<${name}\\b[^>]*>[^<]*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 's');
  return re.exec(text)?.[0] ?? null;
}

const classes = (el: string) => (/className="([^"]*)"/.exec(el)?.[1] ?? '').split(/\s+/);

export const TASKS: EvalTask[] = [
  {
    id: 't01-retext',
    route: '/about',
    tag: 'app/about/page.tsx:9:9',
    instruction: 'Change this heading to "Five people, one studio".',
    files: ['app/about/page.tsx'],
    grade: (read) => (read('app/about/page.tsx').includes('>Five people, one studio</h1>') ? null : 'heading text not changed'),
  },
  {
    id: 't02-add-button',
    route: '/about',
    tag: 'app/about/page.tsx:10:9',
    instruction: 'Add a secondary button under this paragraph that says "See our work" and goes to the home page.',
    files: ['app/about/page.tsx'],
    grade: (read) => {
      const text = read('app/about/page.tsx');
      const button = element(text, 'Button', 'See our work');
      if (!button) return 'no <Button> with that label (a new element instead of the team component?)';
      if (!/intent="quiet"/.test(button)) return 'button is not the quiet (secondary) intent';
      if (!/href="\/"/.test(button)) return 'button does not link to /';
      if (text.indexOf(button) < text.indexOf('fewer projects')) return 'button is not under the paragraph';
      return null;
    },
  },
  {
    id: 't03-primary',
    route: '/',
    tag: 'app/page.tsx:14:11',
    instruction: 'Make this the main call to action style instead of the quiet one.',
    files: ['app/page.tsx'],
    grade: (read) => {
      const button = element(read('app/page.tsx'), 'Button', 'See our work');
      if (!button) return 'button is gone';
      return /intent="quiet"/.test(button) ? 'still quiet' : null;
    },
  },
  {
    id: 't04-smaller-heading',
    route: '/',
    tag: 'app/page.tsx:10:9',
    instruction: 'Make this heading one size smaller.',
    files: ['app/page.tsx'],
    grade: (read) => {
      const h1 = element(read('app/page.tsx'), 'h1', 'We design brands');
      if (!h1) return 'heading is gone';
      const list = classes(h1);
      return list.includes('text-5xl') && !list.includes('text-6xl') ? null : `classes are ${list.join(' ')}`;
    },
  },
  {
    id: 't05-add-tag',
    route: '/',
    tag: 'app/page.tsx:18:9',
    instruction: 'Put a small brand-colored label that says "New" above this heading.',
    files: ['app/page.tsx'],
    grade: (read) => {
      const text = read('app/page.tsx');
      const tag = element(text, 'Tag', 'New');
      if (!tag) return 'no <Tag> labelled New (a new element instead of the team component?)';
      if (!/tone="brand"/.test(tag)) return 'label is not the brand tone';
      if (!/import Tag from '@\/components\/Tag'/.test(text)) return 'Tag is not imported the way the repo does';
      return text.indexOf(tag) < text.indexOf('Selected work') ? null : 'label is not above the heading';
    },
  },
  {
    id: 't06-widen',
    route: '/about',
    tag: 'app/about/page.tsx:7:7',
    instruction: 'Let this section use the full content width.',
    files: ['app/about/page.tsx'],
    grade: (read) => {
      const section = /<Section\b[^>]*>/.exec(read('app/about/page.tsx'))?.[0];
      return section && !/width="narrow"/.test(section) ? null : `section is ${section ?? 'gone'}`;
    },
  },
  {
    id: 't07-dark-section',
    route: '/work/harbor-coffee',
    tag: 'app/work/[slug]/page.tsx:15:7',
    instruction: 'Give this section the dark background.',
    files: ['app/work/[slug]/page.tsx'],
    grade: (read) => {
      const section = /<Section\b[^>]*>/.exec(read('app/work/[slug]/page.tsx'))?.[0] ?? '';
      return /tone="ink"/.test(section) ? null : `section is ${section || 'gone'}`;
    },
  },
  {
    id: 't08-muted-line',
    route: '/',
    tag: 'app/page.tsx:18:9',
    instruction: 'Add a short line under this heading in the muted text color: "Recent projects for clients we love."',
    files: ['app/page.tsx'],
    grade: (read) => {
      const text = read('app/page.tsx');
      const line = /<(p|span|div)\b[^>]*>\s*Recent projects for clients we love\.?\s*</.exec(text)?.[0];
      if (!line) return 'line not added';
      // The heading sits in <Section tone="ink">, a dark surface: muted text there is a lighter color, not text-ink-muted.
      const color = classes(line).find((c) => /^text-(?!xs|sm|base|lg|[0-9]xl|left|center|right)/.test(c)) ?? '';
      if (!/^text-paper(\/\d+)?$/.test(color)) return `line color ${color || '(none)'} doesn't read as muted on the dark section`;
      return text.indexOf(line) > text.indexOf('Selected work') ? null : 'line is not under the heading';
    },
  },
  {
    id: 't09-nav-link',
    route: '/',
    tag: 'components/Nav.tsx:21:13',
    instruction: 'Point this button at /contact instead.',
    files: ['components/Nav.tsx'],
    grade: (read) => {
      const button = element(read('components/Nav.tsx'), 'Button', 'Start a project');
      return button && /href="\/contact"/.test(button) ? null : `button is ${button ?? 'gone'}`;
    },
  },
  {
    id: 't10-token-color',
    route: '/',
    tag: 'components/ProjectCard.tsx:10:7',
    instruction: 'Make the project title color #e4572e.',
    files: ['components/ProjectCard.tsx'],
    grade: (read) => {
      const text = read('components/ProjectCard.tsx');
      if (/#e4572e/i.test(text)) return 'hardcoded the hex instead of the brand token';
      const h3 = /<h3\b[^>]*>/.exec(text)?.[0] ?? '';
      return classes(h3).includes('text-brand') ? null : `title classes are ${classes(h3).join(' ')}`;
    },
  },
];
