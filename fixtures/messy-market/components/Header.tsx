import Link from 'next/link';

export default function Header() {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '16px 24px', borderBottom: '1px solid #eee' }}>
      <Link href="/" style={{ fontWeight: 700, color: '#0a7d5a' }}>Messy Market</Link>
      <div style={{ display: 'flex', gap: 16 }}>
        <Link href="/">Shop</Link>
        <Link href="/cart">Cart</Link>
      </div>
    </div>
  );
}
