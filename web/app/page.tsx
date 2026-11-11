import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Mark } from "@/components/Mark";
import { getBoard, getPoolSummary } from "@/lib/data/reads";

export const revalidate = 15;

export default async function Home() {
  const [board, pool] = await Promise.all([getBoard(6), getPoolSummary()]);
  return (
    <div className="wrap">
      <Header />

      <section id="top" style={{ display: "flex", flexWrap: "wrap", gap: 56, alignItems: "center", padding: "clamp(56px,8vw,120px) 0 clamp(56px,7vw,100px)" }}>
        <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 30 }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 10, alignSelf: "flex-start", fontSize: 13, letterSpacing: ".14em", color: "var(--green-2)", fontWeight: 800, background: "var(--green-lite)", padding: "8px 14px", borderRadius: 999 }}>
            LAUNCHPAD WITH BUILT-IN LENDING
          </span>
          <h1 className="wm" style={{ margin: 0, fontSize: "clamp(68px,9.5vw,148px)", lineHeight: 0.92 }}>
            Launch it.<br /><span style={{ color: "var(--green)" }}>Hock it.</span>
          </h1>
          <p style={{ margin: 0, fontSize: "clamp(19px,1.6vw,24px)", maxWidth: "56ch", color: "var(--body)" }}>
            Every coin launched on HOCK is born collateral. Launch in one signature, borrow SOL against your coin once it clears the gate, and never hand over your keys.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <Link className="btn green" href="/launch">Launch a coin</Link>
            <Link className="btn ink" href="/borrow">Borrow against yours</Link>
          </div>
          <div style={{ display: "flex", gap: 34, flexWrap: "wrap", fontSize: 15, color: "var(--muted)", fontWeight: 500 }}>
            <span>Non-custodial. You sign, we never hold keys.</span>
            <span>Collateral stays in the vault. Always.</span>
          </div>
        </div>

        <aside aria-label="How a ticket works" style={{ flex: "0 1 440px", minWidth: 0, background: "var(--gold)", color: "var(--ink)", borderRadius: 24, overflow: "hidden", boxShadow: "0 40px 80px -36px rgba(255,184,0,.9)", transform: "rotate(-1.5deg)" }}>
          <div style={{ padding: "20px 26px", borderBottom: "2px dashed rgba(20,20,20,.35)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span className="wm" style={{ fontSize: 18, letterSpacing: ".08em" }}>PAWN TICKET</span>
            <span className="pill" style={{ background: "#141414", color: "#FFB800" }}>Example</span>
          </div>
          <div style={{ padding: 26, display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <span className="lab" style={{ color: "#5a4400" }}>Collateral</span>
              <span className="mono" style={{ fontSize: 17, fontWeight: 700 }}>your coin, in the vault</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "baseline" }}>
              <span className="lab" style={{ color: "#5a4400" }}>Borrow</span>
              <span className="mono" style={{ fontSize: 34, fontWeight: 800 }}>SOL</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12 }}>
              {[["LTV", "up to 30%"], ["Term", "2 to 7 days"], ["Fee", "from 1.5%"]].map(([k, v]) => (
                <div key={k} style={{ background: "rgba(255,255,255,.55)", borderRadius: 12, padding: "12px 14px" }}>
                  <span className="lab" style={{ fontSize: 10, color: "#5a4400" }}>{k}</span>
                  <b className="mono" style={{ display: "block", fontSize: 18 }}>{v}</b>
                </div>
              ))}
            </div>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: "#4a3a00" }}>
              Price attested on chain, capped by a 30-minute TWAP. Repay any time to unlock. If the coin falls to the trigger, the vault sells only enough to make the lender whole and returns the rest.
            </p>
            <Link className="btn ink" href="/borrow" style={{ borderRadius: 14 }}>Hock it</Link>
          </div>
        </aside>
      </section>

      <section id="how" style={{ padding: "clamp(48px,6vw,88px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 34 }}>
          <h2 className="wm" style={{ margin: 0, fontSize: "clamp(34px,3.6vw,52px)", lineHeight: 1.05 }}>Three steps, one wallet</h2>
          <span style={{ fontSize: 16, color: "var(--muted)" }}>No account. No custody. No platform fee to launch.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 22 }}>
          {[
            { n: "1", c: "var(--ink)", t: "Launch", p: "Name it, drop the art, sign once. Metadata is stored permanently on Arweave and the coin goes live on a bonding curve. Creating is free; an initial buy pays only the router fee.", l: ["Transaction simulated before you sign", "Mint keypair generated in your browser", "Vanity suffix optional"] },
            { n: "2", c: "var(--pink)", t: "Clear the gate", p: "A coin becomes collateral only when it proves it can be sold: pooled liquidity, trading velocity, routability on the aggregators, holder concentration and a Token-2022 extension audit. The gate fails closed.", l: ["Checked continuously, not once", "Delisted the moment it stops clearing", "Progress shown on the coin's page"] },
            { n: "3", c: "var(--green)", t: "Hock it", p: "Lock the coin in the vault and borrow SOL from the pool at a fixed term. Repay to unlock. Set a limit-close so the vault exits for you at your price, and the lender is always made whole first.", l: ["Memecoin tiers: 30 / 25 / 20% LTV at 2 / 3 / 7 days", "Partial repay, add collateral, extend", "Every exit happens inside the vault"] },
          ].map((s) => (
            <article key={s.n} className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <span className="wm" style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 14, fontSize: 16, color: "#fff", background: s.c }}>{s.n}</span>
              <h3 style={{ margin: 0, fontSize: 24 }}>{s.t}</h3>
              <p style={{ margin: 0, color: "var(--body)", fontSize: 16.5 }}>{s.p}</p>
              <ul style={{ margin: 0, paddingLeft: 20, color: "var(--muted)", fontSize: 15, lineHeight: 1.8 }}>{s.l.map((x) => <li key={x}>{x}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section id="board" style={{ padding: "clamp(48px,6vw,88px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 34 }}>
          <h2 className="wm" style={{ margin: 0, fontSize: "clamp(34px,3.6vw,52px)", lineHeight: 1.05 }}>The board</h2>
          <span style={{ fontSize: 16, color: "var(--muted)" }}>Launched here, graded live.</span>
          <Link href="/board" style={{ marginLeft: "auto", fontWeight: 700 }}>Full board</Link>
        </div>
        <div style={{ overflowX: "auto", background: "var(--card)", border: "1px solid var(--line)", borderRadius: 24, boxShadow: "var(--shadow-card)" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
            <thead>
              <tr>{["Coin", "Age", "Market cap", "Liquidity", "Gate", "LTV", "Borrowable", ""].map((h) => <th key={h} style={{ fontSize: 12, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--muted)", textAlign: "left", padding: "14px 18px", borderBottom: "1px solid var(--line)", fontWeight: 800 }}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {board.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 28, color: "var(--muted)" }}>Nothing launched yet. The first coin on HOCK will appear here the moment its transaction confirms.</td></tr>
              )}
              {board.map((r) => (
                <tr key={r.mint}>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}><strong>{r.name}</strong> <span className="mono" style={{ color: "var(--muted)" }}>${r.symbol}</span></td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.age}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.marketCap ?? "—"}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.liquidity ?? "—"}</td>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}><span className={`pill ${r.verdictClass}`}>{r.verdictLabel}</span></td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.ltv ?? "—"}</td>
                  <td className="mono" style={{ padding: 18, borderBottom: "1px solid var(--line)" }}>{r.borrowable ?? "—"}</td>
                  <td style={{ padding: 18, borderBottom: "1px solid var(--line)" }}><Link href={`/coin/${r.mint}`} style={{ fontWeight: 800 }}>{r.verdictClass === "ready" ? "Hock" : "View"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section id="lend" style={{ padding: "clamp(48px,6vw,88px) 0" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 48, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 18 }}>
            <h2 className="wm" style={{ margin: 0, fontSize: "clamp(34px,3.6vw,52px)", lineHeight: 1.05 }}>Be the pawnbroker</h2>
            <p style={{ margin: 0, color: "var(--body)" }}>Supply SOL to a pool and earn the borrow fees on every ticket written against it. Loans are short, over-collateralised and auto-exited at the trigger, so the pool is made whole before anyone else.</p>
            <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Yields are computed from on-chain pool state, never typed in. Deposits can lose value if a collateral coin becomes unsellable faster than the vault can exit; read the risk page.</p>
          </div>
          <div style={{ flex: "1 1 520px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 16 }}>
            {pool.tiers.map((t) => (
              <div key={t.label} className="card" style={{ padding: 24, display: "flex", flexDirection: "column", gap: 10, borderRadius: 20 }}>
                <span className="lab">{t.label}</span>
                <span className="wm mono" style={{ fontSize: 32, color: "var(--green)" }}>{t.apy ?? "—"}</span>
                <small style={{ fontSize: 13, color: "var(--body)" }}>{t.fee} fee per ticket · {t.ltv} LTV</small>
              </div>
            ))}
            <div style={{ background: "var(--green)", color: "#fff", borderRadius: 20, padding: 24, display: "flex", flexDirection: "column", gap: 10 }}>
              <span className="lab" style={{ color: "#fff" }}>Pool total</span>
              <span className="wm mono" style={{ fontSize: 32 }}>{pool.totalSol ?? "—"}</span>
              <Link href="/lend" style={{ color: "#fff", fontWeight: 800 }}>Supply SOL</Link>
            </div>
          </div>
        </div>
      </section>

      <section id="promise" style={{ padding: "clamp(48px,6vw,88px) 0" }}>
        <div style={{ background: "var(--ink)", color: "#fff", borderRadius: 28, padding: "clamp(32px,4.5vw,64px)", display: "flex", flexWrap: "wrap", gap: 40, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <h2 className="wm" style={{ margin: "0 0 12px", fontSize: "clamp(30px,3vw,42px)" }}>The vault promise</h2>
            <p style={{ margin: 0, color: "#C9C4B6", fontSize: 16 }}>What the program enforces, not what we promise.</p>
          </div>
          <ul style={{ flex: "2 1 560px", minWidth: 0, margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 20, fontSize: 16, color: "#EDE9DF" }}>
            {[
              ["Your keys stay yours.", "Every borrow, repay and exit is signed in your wallet."],
              ["Collateral never leaves the vault.", "Exits swap inside the program through audited routes only."],
              ["Prices are attested, then capped.", "A 30-minute TWAP and a 15% pump guard decide what counts."],
              ["Nothing is hard-coded.", "Every number on this site is read from chain state when you load it."],
              ["You are warned before a trigger.", "Add collateral, repay part, or let the limit-close run."],
              ["Audited program, open source.", "Program id, IDL and build hash published on the security page."],
            ].map(([a, b]) => (
              <li key={a} style={{ display: "flex", gap: 14 }}>
                <i style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--gold)", marginTop: 9, flexShrink: 0 }} />
                <span><strong>{a}</strong> {b}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section style={{ paddingBottom: "clamp(48px,6vw,88px)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap", border: "2px dashed #E3C97A", background: "var(--gold-lite)", borderRadius: 20, padding: "22px 26px", fontSize: 16, color: "var(--body)" }}>
          <Mark size={38} />
          <span className="wm" style={{ fontSize: 22, color: "var(--ink)" }}>$HOCK</span>
          <span>The contract address is published here first. Until it appears on this page, every $HOCK is an impostor.</span>
          <code className="mono" style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)", background: "#fff", padding: "10px 14px", borderRadius: 10, border: "1px solid var(--line)" }}>not yet published</code>
        </div>
      </section>

      <Footer />
    </div>
  );
}
