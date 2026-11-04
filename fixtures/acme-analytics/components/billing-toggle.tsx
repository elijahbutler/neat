'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

type Period = 'monthly' | 'yearly';

export function BillingToggle({ initial = 'monthly' }: { initial?: Period }) {
  const [period, setPeriod] = useState<Period>(initial);
  return (
    <div className="inline-flex gap-1 rounded-lg border border-border p-1" role="group" aria-label="Billing period">
      <Button variant={period === 'monthly' ? 'default' : 'ghost'} size="sm" onClick={() => setPeriod('monthly')}>Monthly</Button>
      <Button variant={period === 'yearly' ? 'default' : 'ghost'} size="sm" onClick={() => setPeriod('yearly')}>Yearly</Button>
    </div>
  );
}
