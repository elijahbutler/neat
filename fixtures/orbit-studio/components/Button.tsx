import { forwardRef, type ReactNode } from 'react';
import Link from 'next/link';

const intents = {
  primary: 'bg-brand text-brand-ink hover:opacity-90',
  quiet: 'border border-rule text-ink hover:bg-ink hover:text-paper',
} as const;

type ButtonProps = {
  intent?: keyof typeof intents;
  href?: string;
  children: ReactNode;
};

const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ intent = 'primary', href, children }, ref) {
  const className = `inline-flex items-center gap-2 rounded-full px-5 py-2.5 font-body text-sm ${intents[intent]}`;
  if (href) {
    return <Link href={href} className={className}>{children}</Link>;
  }
  return <button ref={ref} className={className}>{children}</button>;
});

export { Button };
