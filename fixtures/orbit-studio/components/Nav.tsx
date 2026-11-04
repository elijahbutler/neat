import Link from 'next/link';
import { Button } from './Button';

const links = [
  { href: '/', label: 'Work' },
  { href: '/about', label: 'About' },
];

export default function Nav() {
  return (
    <header className="border-b border-rule bg-paper">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Link href="/" className="font-display text-xl text-ink">Orbit Studio</Link>
        <ul className="flex items-center gap-6 font-body text-sm text-ink-muted">
          {links.map((link) => (
            <li key={link.href}>
              <Link href={link.href} className="hover:text-ink">{link.label}</Link>
            </li>
          ))}
          <li>
            <Button href="/about" intent="quiet">Start a project</Button>
          </li>
        </ul>
      </nav>
    </header>
  );
}
