export function LegacyBanner({ title, subtitle }) {
  return (
    <div className="bg-green-700 text-white p-6">
      <h2 className="text-2xl font-bold">{title}</h2>
      <p>{subtitle}</p>
    </div>
  );
}
