import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Mark } from "@/components/Mark";
import { LaunchTrack } from "@/components/LaunchTrack";
import { getBoard, getPoolSummary } from "@/lib/data/reads";

export const revalidate = 15;

export default async function Home() {
  const [board, pool] = await Promise.all([getBoard(6), getPoolSummary()]);
  return (
    <div className="wrap">
      <Header />

      <section id="top" className="hero" style={{ display: "flex", flexWrap: "wrap", gap: 48, alignItems: "center", padding: "clamp(48px,7vw,104px) 0 clamp(48px,6vw,88px)" }}>
        <Mark size={640} tone="var(--ink)" hot="var(--accent)" className="hero-ap" label="" />
        <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 28 }}>
          <span className="kicker">Launchpad with built-in lending</span>
          <h1 className="wm hero-h1">Launch it.<br /><em>Hock it.</em></h1>
          <p style={{ margin: 0, fontSize: "clamp(18px,1.5vw,22px)", maxWidth: "54ch", color: "var(--body)" }}>
            Every coin launched on HOCK is born collateral. Launch in one signature, and the moment your coin holds $50k market cap you can borrow SOL against it. Your keys never leave your wallet.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link className="btn primary" href="/launch">Launch a coin</Link>
            <Link className="btn line" href="/borrow" style={{ minHeight: 50, fontSize: 14, padding: "0 24px" }}>Borrow against yours</Link>
          </div>
          <div className="mono" style={{ display: "flex", gap: 28, flexWrap: "wrap", fontSize: 12, color: "var(--muted)", letterSpacing: ".04em" }}>
            <span>NON-CUSTODIAL</span>
            <span>COLLATERAL STAYS IN THE VAULT</span>
            <span>PRICES ATTESTED ON CHAIN</span>
          </div>
        </div>

        <aside aria-label="How a ticket works" className="readout" style={{ flex: "0 1 440px", minWidth: 0 }}>
          <div className="readout-head">
            <span>Ticket · example</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent)" }}><Mark size={16} tone="var(--muted)" small /> HOCK</span>
          </div>
          <div className="readout-row">
            <span className="lab">Collateral</span>
            <span className="mono" style={{ fontSize: 15, color: "var(--ink)" }}>your coin, in the vault</span>
          </div>
          <div className="readout-row">
            <span className="lab">Unlocks at</span>
            <span className="mono" style={{ fontSize: 15, color: "var(--accent)" }}>$50,000 market cap</span>
          </div>
          <div className="readout-row">
            <span className="lab">Borrow</span>
            <span className="mono wm" style={{ fontSize: 36, color: "var(--accent)", lineHeight: 1 }}>SOL</span>
          </div>
          <div className="readout-grid">
            {[["LTV", "up to 30%"], ["Term", "2 to 7 d"], ["Fee", "from 1.5%"]].map(([k, v]) => (
              <div key={k}>
                <span className="lab" style={{ fontSize: 10 }}>{k}</span>
                <b className="mono" style={{ display: "block", fontSize: 18, color: "var(--ink)", marginTop: 4 }}>{v}</b>
              </div>
            ))}
          </div>
          <div style={{ padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.65, color: "var(--body)" }}>
              Price attested on chain, capped by a 30-minute TWAP. Repay any time to unlock. If the coin falls to the trigger, the vault sells only enough to make the lender whole and returns the rest.
            </p>
            <Link className="btn primary" href="/borrow">Hock it</Link>
          </div>
        </aside>
      </section>

      <section id="how" style={{ padding: "clamp(40px,6vw,80px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 28 }}>
          <h2 className="wm" style={{ margin: 0, fontSize: "clamp(30px,3.4vw,48px)", lineHeight: 1.05 }}>Three steps, one wallet</h2>
          <span className="mono" style={{ fontSize: 13, color: "var(--muted)" }}>No account. No custody. No platform fee to launch.</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
          {[
            { n: "01", t: "Launch", p: "Name it, drop the art, sign once. Metadata is stored permanently on Arweave and the coin goes live on a bonding curve. Creating is free; an initial buy pays only the router fee.", l: ["Transaction simulated before you sign", "Mint keypair generated in your browser", "Vanity suffix optional"] },
            { n: "02", t: "Hit $50k market cap", p: "The line is $50,000. When your coin holds it, borrowing opens. Under that one rule a quiet floor keeps the vault honest: the coin has to be sellable, with real volume, a working route on the aggregators, spread-out holders and clean Token-2022 extensions.", l: ["One number to watch, shown live on the coin's page", "Checked continuously, not once", "Closes the moment the coin drops below the line"] },
            { n: "03", t: "Hock it", p: "Lock the coin in the vault and borrow SOL from the pool at a fixed term. Repay to unlock. Set a limit-close so the vault exits for you at your price, and the lender is always made whole first.", l: ["Memecoin tiers: 30 / 25 / 20% LTV at 2 / 3 / 7 days", "Partial repay, add collateral, extend", "Every exit happens inside the vault"] },
          ].map((s, i) => (
            <article key={s.n} className={`card${i === 2 ? " corners" : ""}`} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <span className="step-n">{s.n}</span>
              <h3 className="wm" style={{ margin: 0, fontSize: 22 }}>{s.t}</h3>
              <p style={{ margin: 0, color: "var(--body)", fontSize: 15.5 }}>{s.p}</p>
              <ul className="mono" style={{ margin: 0, paddingLeft: 18, color: "var(--muted)", fontSize: 13, lineHeight: 1.9 }}>{s.l.map((x) => <li key={x}>{x}</li>)}</ul>
            </article>
          ))}
        </div>
      </section>

      <section id="board" style={{ padding: "clamp(40px,6vw,80px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 28 }}>
          <h2 className="wm" style={{ margin: 0, fontSize: "clamp(30px,3.4vw,48px)", lineHeight: 1.05 }}>The board</h2>
          <span className="mono" style={{ fontSize: 13, color: "var(--muted)" }}>Launched here, graded live.</span>
          <Link href="/board" className="mono" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600 }}>Full board →</Link>
        </div>
        {board.length === 0 ? <LaunchTrack /> : (
        <div style={{ overflowX: "auto", background: "var(--card)", border: "1px solid var(--line)", borderRadius: "var(--radius)", boxShadow: "var(--shadow-card)" }}>
          <table className="board">
            <thead>
              <tr>{["Coin", "Age", "Market cap", "Liquidity", "Gate", "LTV", "Borrowable", ""].map((h) => <th key={h}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {board.map((r) => (
                <tr key={r.mint}>
                  <td className="coin-cell"><strong>{r.name}</strong> <span className="mono" style={{ color: "var(--muted)", marginLeft: 6 }}>${r.symbol}</span></td>
                  <td className="mono" data-label="Age">{r.age}</td>
                  <td className="mono" data-label="Mkt cap">{r.marketCap ?? "—"}</td>
                  <td className="mono" data-label="Liquidity">{r.liquidity ?? "—"}</td>
                  <td data-label="Gate"><span className={`pill ${r.verdictClass}`}>{r.verdictLabel}</span></td>
                  <td className="mono" data-label="LTV">{r.ltv ?? "—"}</td>
                  <td className="mono" data-label="Borrowable">{r.borrowable ?? "—"}</td>
                  <td className="action-cell"><Link href={`/coin/${r.mint}`} className="mono" style={{ fontWeight: 600, color: r.verdictClass === "ready" ? "var(--accent)" : undefined }}>{r.verdictClass === "ready" ? "Hock →" : "View →"}</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>

      <section id="lend" style={{ padding: "clamp(40px,6vw,80px) 0" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 40, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 380px", minWidth: 0, display: "flex", flexDirection: "column", gap: 16 }}>
            <h2 className="wm" style={{ margin: 0, fontSize: "clamp(30px,3.4vw,48px)", lineHeight: 1.05 }}>Be the pawnbroker</h2>
            <p style={{ margin: 0, color: "var(--body)" }}>Supply SOL to a pool and earn the borrow fees on every ticket written against it. Loans are short, over-collateralised and auto-exited at the trigger, so the pool is made whole before anyone else.</p>
            <p style={{ margin: 0, fontSize: 14, color: "var(--muted)" }}>Yields are computed from on-chain pool state, never typed in. Deposits can lose value if a collateral coin becomes unsellable faster than the vault can exit; read the risk page.</p>
          </div>
          <div style={{ flex: "1 1 520px", minWidth: 0, display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
            {pool.tiers.map((t) => (
              <div key={t.label} className="card" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 8 }}>
                <span className="lab">{t.label}</span>
                <span className="wm mono" style={{ fontSize: "clamp(22px,1.8vw,28px)", color: "var(--accent)", whiteSpace: "nowrap" }}>{t.apy ?? "—"}</span>
                <small className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>{t.fee} fee · {t.ltv} LTV</small>
              </div>
            ))}
            <div className="card corners" style={{ padding: 22, display: "flex", flexDirection: "column", gap: 8, borderColor: "var(--accent-line)" }}>
              <span className="lab" style={{ color: "var(--accent)" }}>Pool total</span>
              <span className="wm mono" style={{ fontSize: "clamp(22px,1.8vw,28px)", whiteSpace: "nowrap" }}>{pool.totalSol ?? "—"}</span>
              <Link href="/lend" className="mono" style={{ color: "var(--accent)", fontSize: 13, fontWeight: 600 }}>Supply SOL →</Link>
            </div>
          </div>
        </div>
      </section>

      <section id="promise" style={{ padding: "clamp(40px,6vw,80px) 0" }}>
        <div className="promise" style={{ display: "flex", flexWrap: "wrap", gap: 36, alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 320px", minWidth: 0 }}>
            <h2 className="wm" style={{ margin: "0 0 10px", fontSize: "clamp(28px,3vw,40px)" }}>The vault promise</h2>
            <p className="mono" style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>What the program enforces, not what we promise.</p>
          </div>
          <ul style={{ flex: "2 1 560px", minWidth: 0, margin: 0, padding: 0, listStyle: "none", display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 18, fontSize: 15, color: "var(--body)" }}>
            {[
              ["Your keys stay yours.", "Every borrow, repay and exit is signed in your wallet."],
              ["Collateral never leaves the vault.", "Exits swap inside the program through audited routes only."],
              ["Prices are attested, then capped.", "A 30-minute TWAP and a 15% pump guard decide what counts."],
              ["Nothing is hard-coded.", "Every number on this site is read from chain state when you load it."],
              ["You are warned before a trigger.", "Add collateral, repay part, or let the limit-close run."],
              ["Audited program, open source.", "Program id, IDL and build hash published on the security page."],
            ].map(([a, b]) => (
              <li key={a}>
                <i />
                <span><strong style={{ color: "var(--ink)" }}>{a}</strong> {b}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section style={{ paddingBottom: "clamp(40px,6vw,80px)" }}>
        <div className="ca-strip">
          <Mark size={28} />
          <span className="wm" style={{ fontSize: 20, color: "var(--ink)" }}>$HOCK</span>
          <span>The contract address is published here first. Until it appears on this page, every $HOCK is an impostor.</span>
          <code className="mono" style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)", background: "var(--field)", padding: "10px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)" }}>not yet published</code>
        </div>
      </section>

      <Footer />
    </div>
  );
}
