import Link from 'next/link';
import { Button } from '@/components/ui/button';

export function SiteHeader() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="text-lg font-semibold">Acme Analytics</Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" size="sm">Docs</Button>
          <Button variant="ghost" size="sm">Sign in</Button>
          <Button size="sm">Start free trial</Button>
        </nav>
      </div>
    </header>
  );
}
