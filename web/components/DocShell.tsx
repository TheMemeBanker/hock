import Link from "next/link";
import { Header } from "./Header";
import { Footer } from "./Footer";

export const DOCS = [
  { href: "/docs", label: "Overview" },
  { href: "/docs/whitepaper", label: "Whitepaper" },
  { href: "/docs/how-it-works", label: "How it works" },
  { href: "/docs/fees", label: "Fees" },
  { href: "/docs/rewards", label: "Rewards" },
  { href: "/docs/security", label: "Security" },
  { href: "/docs/risk", label: "Risk" },
  { href: "/docs/terms", label: "Terms" },
  { href: "/docs/privacy", label: "Privacy" },
];

export function DocShell({ title, kicker, current, children }: { title: string; kicker?: string; current: string; children: React.ReactNode }) {
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0", display: "flex", gap: 40, flexWrap: "wrap", alignItems: "flex-start" }}>
        <nav aria-label="Docs" className="doc-nav">
          {DOCS.map((d) => (
            <Link key={d.href} href={d.href} className={d.href === current ? "current" : undefined}>{d.label}</Link>
          ))}
        </nav>
        <article className="doc" style={{ flex: "1 1 560px", minWidth: 0, maxWidth: 800 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: 20 }}>
            <h1 className="wm" style={{ margin: 0, fontSize: "clamp(36px,4.5vw,60px)", lineHeight: 1 }}>{title}</h1>
            {kicker && <span style={{ color: "var(--muted)" }}>{kicker}</span>}
          </div>
          <div style={{ display: "grid", gap: 18, color: "var(--body)", fontSize: 17 }}>{children}</div>
        </article>
      </section>
      <Footer />
    </div>
  );
}

export function H2({ children }: { children: React.ReactNode }) {
  return <h2 style={{ margin: "18px 0 0", fontSize: 26, color: "var(--ink)" }}>{children}</h2>;
}

export function Table({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
  return (
    <div style={{ overflowX: "auto", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 16 }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 480 }}>
        <thead><tr>{head.map((h) => <th key={h} className="lab" style={{ textAlign: "left", padding: "12px 14px", borderBottom: "1px solid var(--line)" }}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={j > 0 ? "mono" : undefined} style={{ padding: "12px 14px", borderBottom: "1px solid var(--line)", fontSize: 15 }}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}
