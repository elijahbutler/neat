import type { ReactNode } from 'react';
import Nav from '@/components/Nav';
import './globals.css';

export const metadata = { title: 'Orbit Studio' };

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-paper font-body text-ink">
        <Nav />
        {children}
      </body>
    </html>
  );
}
