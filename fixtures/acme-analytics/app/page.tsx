import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const features = [
  { title: 'Live dashboards', description: 'See signups, activation, and revenue update as they happen.' },
  { title: 'Funnels', description: 'Find the step where people drop off, then fix it.' },
  { title: 'Alerts', description: 'Get a Slack message when a metric moves more than you expect.' },
];

export default function HomePage() {
  return (
    <main className="mx-auto max-w-6xl px-6">
      <section className="py-24 text-center">
        <Badge variant="secondary">New: funnel alerts</Badge>
        <h1 className="mt-6 text-5xl font-bold tracking-tight">Know why your numbers moved</h1>
        <p className="mx-auto mt-4 max-w-2xl text-lg text-muted-foreground">
          Acme Analytics connects to your database and answers product questions in plain charts.
        </p>
        <div className="mt-8 flex justify-center gap-3">
          <Button size="lg">Start free trial</Button>
          <Button size="lg" variant="outline">Book a demo</Button>
        </div>
      </section>
      <section className="grid gap-6 pb-24 md:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title}>
            <CardHeader>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <Button variant="link" className="px-0">Learn more</Button>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
