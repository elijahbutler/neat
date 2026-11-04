import { ProductCard } from '../components/ProductCard';
import { LegacyBanner } from '../components/legacy-banner';
import PromoBanner from '../components/promo-banner';

const products = [
  { name: 'Canvas tote', price: 24, onSale: false },
  { name: 'Enamel mug', price: 18, onSale: true },
  { name: 'Linen apron', price: 42, onSale: false },
];

export default function Page() {
  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: 24 }}>
      <PromoBanner message="Free shipping over $50" />
      <LegacyBanner title="Summer market" subtitle="New goods every Friday" />
      <h1 className="text-[34px] font-bold mt-8 mb-4">Shop everything</h1>
      <div className="grid grid-cols-3 gap-6">
        {products.map((p) => <ProductCard key={p.name} {...p} />)}
      </div>
      <div className="mt-10 flex gap-3">
        <button className="px-4 py-2 bg-[#0a7d5a] text-white rounded">Shop mugs</button>
        <button className="px-4 py-2 bg-[#0a7d5a] text-white rounded">Shop totes</button>
        <button className="px-4 py-2 bg-[#0a7d5a] text-white rounded">Shop aprons</button>
      </div>
    </main>
  );
}
