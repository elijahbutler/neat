export function ProductCard(props: { title: string; cost: string }) {
  return (
    <div className="card" style={{ border: '1px solid #ddd', padding: 12 }}>
      <b>{props.title}</b>
      <div>{props.cost}</div>
      <button className="btn-old">Buy</button>
    </div>
  );
}
