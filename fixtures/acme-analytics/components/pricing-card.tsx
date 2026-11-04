import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export interface PricingCardProps {
  name: string;
  price: string;
  description: string;
  features: string[];
  highlighted?: boolean;
}

export function PricingCard({ name, price, description, features, highlighted = false }: PricingCardProps) {
  return (
    <Card className={highlighted ? 'border-primary shadow-md' : undefined}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>{name}</CardTitle>
          {highlighted && <Badge>Popular</Badge>}
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-3xl font-bold">
          {price}
          <span className="text-sm font-normal text-muted-foreground">/mo</span>
        </p>
        <ul className="space-y-2 text-sm">
          {features.map((feature) => (
            <li key={feature} className="flex gap-2">
              <span aria-hidden>✓</span>
              {feature}
            </li>
          ))}
        </ul>
        <Button className="w-full" variant={highlighted ? 'default' : 'outline'}>Choose {name}</Button>
      </CardContent>
    </Card>
  );
}
