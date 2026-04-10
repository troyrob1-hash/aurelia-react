// src/components/ui/Breadcrumb.jsx
export default function Breadcrumb({ items }) {
  return (
    <nav style={{
      display: "flex", alignItems: "center", gap: 6,
      fontSize: 12, color: "var(--color-text-tertiary, #999)",
      marginBottom: 4,
    }}>
      {items.map((item, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {i > 0 && <span style={{ fontSize: 10 }}>›</span>}
          {i === items.length - 1
            ? <span style={{ color: "var(--color-text-secondary, #666)", fontWeight: 500 }}>{item}</span>
            : <span>{item}</span>
          }
        </span>
      ))}
    </nav>
  );
}
