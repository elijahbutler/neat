import { BillingToggle } from '@/components/billing-toggle';
import { PricingCard } from '@/components/pricing-card';

const plans = [
  { name: 'Starter', price: '$0', description: 'For side projects.', features: ['1 project', '10k events a month'] },
  { name: 'Team', price: '$49', description: 'For growing products.', features: ['10 projects', '1M events a month', 'Alerts'], highlighted: true },
  { name: 'Scale', price: '$199', description: 'For larger teams.', features: ['Unlimited projects', '20M events a month', 'SSO'] },
];

export default function PricingPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-24">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-4xl font-bold tracking-tight">Pricing</h1>
        <BillingToggle />
      </div>
      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {plans.map((plan) => (
          <PricingCard key={plan.name} {...plan} />
        ))}
      </div>
    </main>
  );
}
