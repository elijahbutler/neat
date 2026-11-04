'use client';

import { useState } from 'react';
import { ProductCard } from '../../components/product-card-old';

export default function CartPage() {
  const [count, setCount] = useState(1);
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 28, fontWeight: 'bold' }}>Your cart</h1>
      <ProductCard title="Enamel mug" cost="$18.00" />
      <div className="flex items-center gap-2 mt-4">
        <button className="border px-2" onClick={() => setCount(count - 1)}>-</button>
        <span>{count}</span>
        <button className="border px-2" onClick={() => setCount(count + 1)}>+</button>
      </div>
    </main>
  );
}
