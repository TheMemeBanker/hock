export function PageIntro({ title, kicker, children }: { title: string; kicker?: string; children?: React.ReactNode }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
        <h1 className="wm" style={{ margin: 0, fontSize: "clamp(40px,5vw,72px)", lineHeight: 1 }}>{title}</h1>
        {kicker && <span style={{ fontSize: 16, color: "var(--muted)" }}>{kicker}</span>}
      </div>
      {children && <p style={{ margin: "0 0 28px", maxWidth: "70ch", color: "var(--body)" }}>{children}</p>}
    </>
  );
}

export function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
      <span className="lab">{label}</span>
      <span className="mono" style={{ fontSize: 22, fontWeight: 800, overflowWrap: "anywhere" }}>{value}</span>
      {sub && <span style={{ fontSize: 13, color: "var(--muted)" }}>{sub}</span>}
    </div>
  );
}
