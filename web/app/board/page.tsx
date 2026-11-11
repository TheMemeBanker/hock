import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { getBoard } from "@/lib/data/reads";
import { getMarkets } from "@/lib/data/market";
import { fmtUsd } from "@/lib/fmt";

export const revalidate = 10;
export const metadata = { title: "The board" };

export default async function BoardPage() {
  const rows = await getBoard(200);
  const markets = await getMarkets(rows.map((r) => r.mint));
  const ready = rows.filter((r) => r.verdictClass === "ready").length;
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
          <h1 className="wm" style={{ margin: 0, fontSize: "clamp(40px,5vw,72px)", lineHeight: 1 }}>The board</h1>
          <span style={{ fontSize: 16, color: "var(--muted)" }}>
            {rows.length} launched here · {ready} collateral ready · graded every minute
          </span>
        </div>
        <p style={{ margin: "0 0 28px", maxWidth: "70ch", color: "var(--body)" }}>
          Every coin launched on HOCK, in launch order. The gate grades five things continuously: pooled liquidity, trading velocity, routability at loan size, holder concentration and the token program's extensions. Five passes twice in a row makes a coin collateral; one failure delists it for new loans.
        </p>
        <div style={{ overflowX: "auto", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 24, boxShadow: "var(--shadow-card)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
            <thead>
              <tr>{["Coin", "Age", "Mkt cap", "Liquidity", "Gate", "LTV", "Borrowable", ""].map((h) => (
                <th key={h} style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", textAlign: "left", padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 800, whiteSpace: "nowrap" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 28, color: "var(--muted)" }}>Nothing launched yet. <Link href="/launch">Be the first.</Link></td></tr>
              )}
              {rows.map((r) => (
                <tr key={r.mint}>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>
                    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
                      {r.imageUrl ? <img src={r.imageUrl} alt="" width={36} height={36} style={{ borderRadius: 10, objectFit: "cover", border: "1px solid var(--line)", flexShrink: 0 }} /> : <span aria-hidden style={{ width: 36, height: 36, borderRadius: 10, background: "var(--line)", flexShrink: 0 }} />}
                      <div style={{ minWidth: 0 }}>
                        <strong>{r.name}</strong> <span className="mono" style={{ color: "var(--muted)" }}>${r.symbol}</span>
                        <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 4, overflowWrap: "anywhere" }}>{r.mint}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.age}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{fmtUsd(markets.get(r.mint)?.marketCapUsd)}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.liquidity ?? fmtUsd(markets.get(r.mint)?.liquidityUsd)}</td>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}><span className={`pill ${r.verdictClass}`}>{r.verdictLabel}</span></td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.ltv ?? "—"}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.borrowable ?? "—"}</td>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>
                    <Link href={`/coin/${r.mint}`} style={{ fontWeight: 800 }}>{r.verdictClass === "ready" ? "Hock" : "View"}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <Footer />
    </div>
  );
}
