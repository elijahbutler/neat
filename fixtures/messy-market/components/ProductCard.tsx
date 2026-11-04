type Props = { name: string; price: number; image?: string; onSale?: boolean };

export function ProductCard({ name, price, onSale }: Props) {
  return (
    <div className="border rounded p-4 shadow-sm">
      <div className="h-40 bg-gray-100 rounded mb-3" />
      <h3 className="font-bold text-lg">{name}</h3>
      <p className={onSale ? 'text-red-600' : 'text-gray-700'}>${price.toFixed(2)}</p>
      <button className="px-4 py-2 bg-[#0a7d5a] text-white rounded mt-2">Add to cart</button>
    </div>
  );
}
