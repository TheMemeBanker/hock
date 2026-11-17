"use client";

/**
 * Investor demo dashboard. Shown in place of the live dashboard when the demo wallet connects.
 * Everything on it is a MODELLED SCENARIO: the program arithmetic (tiers, fees, LTV, TWAP cap,
 * slippage floor) is the real arithmetic the chain enforces; prices, volumes and holdings are
 * inputs the viewer drags. Nothing here is read from chain and nothing pretends to be.
 */
import { useMemo, useState } from "react";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";
import { Mark } from "@/components/Mark";

export const INVESTOR_WALLET = process.env.NEXT_PUBLIC_INVESTOR_WALLET || "BFceiceSoKBFCibgqdkitH83TVDesxvNPhGLc5zHJu88";

const LINE_USD = 50_000;
const HORIZON = 14; // days charted
const LENDER_SHARE = 0.99; // 99% of borrow fees stay in the pool
const SLIPPAGE_FLOOR = 0.15; // conversion floor = TWAP minus 15%
const PUMP_GUARD = 0.15; // spot may sit at most 15% above TWAP

type Preset = { id: string; name: string; blurb: string; mc: number; vol: number; hold: number; shape: (t: number) => number };
const PRESETS: Preset[] = [
  { id: "quiet", name: "Quiet launch", blurb: "Finds a few holders, never reaches the line. The gate keeps it out, nobody can borrow against it, nobody gets hurt.", mc: 18_000, vol: 9_000, hold: 4, shape: (t) => 0.25 + 0.75 * (1 - Math.exp(-t / 5)) },
  { id: "cross", name: "Crosses the line", blurb: "A normal good launch. Climbs for three days, holds $50k, and the launcher writes a ticket instead of selling.", mc: 84_000, vol: 60_000, hold: 3, shape: (t) => 1 / (1 + Math.exp(-(t - 3.2) * 1.1)) * 0.92 + 0.08 },
  { id: "runner", name: "Runner", blurb: "Breaks out on day one. Volume compounds the creator rewards; the ticket is a fraction of what the coin is worth.", mc: 650_000, vol: 1_400_000, hold: 2, shape: (t) => Math.min(1, 0.06 + Math.pow(t / 10, 1.6)) },
];

const usd = (n: number, dp = 0) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toLocaleString("en-US", { maximumFractionDigits: dp })}`;
const sol = (n: number, dp = 3) => `${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })} SOL`;
const pctf = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;

function Slider({ label, value, min, max, step, onChange, fmt, log }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; fmt: (v: number) => string; log?: boolean }) {
  const toPos = (v: number) => log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
  const fromPos = (p: number) => log ? Math.exp(Math.log(min) + p * (Math.log(max) - Math.log(min))) : min + p * (max - min);
  return (
    <label className="demo-slider">
      <span className="lab">{label}</span>
      <input type="range" min={0} max={1000} value={Math.round(toPos(value) * 1000)} onChange={(e) => { const v = fromPos(Number(e.target.value) / 1000); onChange(step ? Math.round(v / step) * step : v); }} />
      <b className="mono">{fmt(value)}</b>
    </label>
  );
}

function Stat({ label, value, sub, hot }: { label: string; value: React.ReactNode; sub?: React.ReactNode; hot?: boolean }) {
  return (
    <div className="demo-stat">
      <span className="lab">{label}</span>
      <b className="mono" style={{ color: hot ? "var(--accent)" : undefined }}>{value}</b>
      {sub && <small>{sub}</small>}
    </div>
  );
}

export function InvestorDemo({ wallet }: { wallet: string }) {
  const [presetId, setPresetId] = useState("cross");
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const [mc, setMc] = useState(preset.mc);
  const [vol, setVol] = useState(preset.vol);
  const [hold, setHold] = useState(preset.hold);
  const [tierIdx, setTierIdx] = useState(0);
  const [solUsd, setSolUsd] = useState(72);
  const [creatorBps, setCreatorBps] = useState(5); // pump.fun pays creators about 0.05% of volume
  const [day, setDay] = useState(HORIZON);
  const [move7d, setMove7d] = useState(0.6); // what the coin does after the ticket is written
  const [util, setUtil] = useState(0.6);
  const [ticketsPerDay, setTicketsPerDay] = useState(40);
  const [protocolShare, setProtocolShare] = useState(0.01);
  const [fireRate, setFireRate] = useState(0.15);

  function applyPreset(p: Preset) { setPresetId(p.id); setMc(p.mc); setVol(p.vol); setHold(p.hold); setDay(HORIZON); }

  const tier = MEMECOIN_TIERS[tierIdx];
  const m = useMemo(() => {
    // ---- the coin's path over the horizon ----
    const peak = Math.max(...Array.from({ length: HORIZON + 1 }, (_, t) => preset.shape(t)));
    const path = Array.from({ length: HORIZON + 1 }, (_, t) => ({ t, mc: (preset.shape(t) / peak) * mc }));
    const crossDay = path.findIndex((p) => p.mc >= LINE_USD);
    const mcAtDay = path[Math.min(day, HORIZON)].mc;
    const cumVol = path.slice(1, Math.min(day, HORIZON) + 1).reduce((a, p) => a + vol * (p.mc / mc), 0);
    // ---- gate at the chosen day ----
    const liquidity = mcAtDay * 0.08; // a bonding-curve coin holds roughly 8% of its market cap as SOL-side liquidity
    const v24 = vol * (mcAtDay / mc);
    const impact = (0.5 * solUsd) / Math.max(liquidity, 1);
    const checks = [
      { k: "Market cap at or above $50,000", ok: mcAtDay >= LINE_USD, d: usd(mcAtDay) },
      { k: "Pooled liquidity", ok: liquidity >= 2_500, d: usd(liquidity) },
      { k: "Trading velocity", ok: v24 >= 5_000 && v24 / 24 >= 250, d: `${usd(v24)} / 24h` },
      { k: "Routability at loan size", ok: impact <= 0.08, d: `${pctf(impact, 1)} impact on 0.5 SOL` },
      { k: "Holder concentration", ok: hold <= 40, d: `you hold ${hold.toFixed(1)}%` },
      { k: "Token program extensions", ok: true, d: "clean" },
    ];
    const ready = checks.every((c) => c.ok);
    // ---- the ticket, in the program's arithmetic ----
    const holdingsUsd = mcAtDay * (hold / 100);
    const holdingsSol = holdingsUsd / solUsd;
    const ltv = tier.ltvBps / 10_000, fee = tier.feeBps / 10_000;
    const principal = holdingsSol * ltv;
    const feeSol = Math.ceil(principal * fee * 1e9) / 1e9; // rounded up to the lamport
    const receive = principal - feeSol;
    const cushion = 1 - ltv; // how far the coin can fall before principal exceeds the collateral
    // ---- what the launcher earns ----
    const creatorEarned = cumVol * (creatorBps / 10_000);
    // ---- sell vs hock ----
    const sellImpact = Math.min(0.9, holdingsUsd / Math.max(liquidity, 1));
    const sellProceeds = holdingsUsd * (1 - sellImpact / 2);
    const laterValue = holdingsUsd * (1 + move7d);
    const hockNet = laterValue - principal * solUsd + receive * solUsd; // keep the coin, have the SOL, owe the principal
    // ---- lender ----
    const apy = (fee / tier.durationDays) * 365 * util * LENDER_SHARE;
    // ---- protocol ----
    // protocol share of the borrow fee, plus the 1% skim on limit-close proceeds for the tickets that fire (proceeds ≈ principal recovered)
    const perTicket = principal * fee * protocolShare + fireRate * principal * 0.01;
    const monthly = perTicket * ticketsPerDay * 30;
    return { path, crossDay, mcAtDay, cumVol, checks, ready, holdingsUsd, holdingsSol, principal, feeSol, receive, cushion, creatorEarned, sellImpact, sellProceeds, laterValue, hockNet, apy, perTicket, monthly, liquidity, v24 };
  }, [preset, mc, vol, hold, tier, solUsd, creatorBps, day, move7d, util, ticketsPerDay, protocolShare, fireRate]);

  // chart geometry
  const W = 720, H = 220, PX = 44, PY = 18;
  const maxY = Math.max(LINE_USD * 1.25, ...m.path.map((p) => p.mc));
  const x = (t: number) => PX + (t / HORIZON) * (W - PX - 12);
  const y = (v: number) => H - PY - (v / maxY) * (H - PY * 2);
  const d = m.path.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)} ${y(p.mc).toFixed(1)}`).join(" ");
  const area = `${d} L${x(HORIZON).toFixed(1)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const dueDate = new Date(Date.now() + tier.durationDays * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const status = m.mcAtDay >= LINE_USD && m.ready ? "collateral ready" : day === 0 ? "launched" : "grading";

  return (
    <div className="demo">
      <div className="demo-banner">
        <span className="pill ready" style={{ background: "var(--accent-dim)" }}>Investor demo</span>
        <span>Modelled scenario for <span className="mono">{wallet.slice(0, 4)}…{wallet.slice(-4)}</span>. The tier, fee, LTV, TWAP and floor arithmetic is the program's. Market cap, volume and holdings are yours to drag. Nothing on this page is read from chain.</span>
      </div>

      {/* ---- scenario ---- */}
      <section className="demo-sec">
        <div className="demo-head">
          <h2 className="wm">Pick a launch</h2>
          <span className="mono muted">three shapes a coin can take in its first two weeks</span>
        </div>
        <div className="demo-presets">
          {PRESETS.map((p) => (
            <button key={p.id} type="button" className={`demo-preset${p.id === presetId ? " on" : ""}`} onClick={() => applyPreset(p)}>
              <span className="lab">{p.id === "quiet" ? "01" : p.id === "cross" ? "02" : "03"}</span>
              <strong>{p.name}</strong>
              <small>{p.blurb}</small>
              <span className="mono demo-preset-nums">{usd(p.mc)} mc · {usd(p.vol)} / 24h · you hold {p.hold}%</span>
            </button>
          ))}
        </div>
        <div className="demo-controls">
          <Slider label="Market cap today" value={mc} min={5_000} max={3_000_000} log onChange={setMc} fmt={(v) => usd(v)} />
          <Slider label="24h volume" value={vol} min={1_000} max={10_000_000} log onChange={setVol} fmt={(v) => usd(v)} />
          <Slider label="Supply you hold" value={hold} min={0.1} max={15} step={0.1} onChange={setHold} fmt={(v) => `${v.toFixed(1)}%`} />
          <Slider label="SOL price" value={solUsd} min={20} max={400} step={1} onChange={setSolUsd} fmt={(v) => `$${v}`} />
        </div>
      </section>

      {/* ---- the coin's path ---- */}
      <section className="demo-sec card">
        <div className="demo-head">
          <h2 className="wm">The path to the line</h2>
          <span className={`pill ${status === "collateral ready" ? "ready" : status === "grading" ? "grading" : "launched"}`}>{status}</span>
          <span className="mono muted" style={{ marginLeft: "auto" }}>day {day} of {HORIZON}</span>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="demo-chart" role="img" aria-label="Market cap over fourteen days against the $50,000 line">
          <defs><linearGradient id="demo-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".35" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
          {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={PX} x2={W - 12} y1={y(maxY * f)} y2={y(maxY * f)} stroke="var(--line)" strokeDasharray="2 6" />)}
          {[0.5, 1].map((f) => <text key={f} x={PX - 6} y={y(maxY * f) + 4} textAnchor="end" className="demo-tick">{usd(maxY * f)}</text>)}
          <path d={area} fill="url(#demo-area)" />
          <path d={d} fill="none" stroke="var(--ink)" strokeWidth="2.5" strokeLinejoin="round" />
          <line x1={PX} x2={W - 12} y1={y(LINE_USD)} y2={y(LINE_USD)} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="6 5" />
          <text x={W - 14} y={y(LINE_USD) - 6} textAnchor="end" className="demo-tick hot">$50,000 · borrowing opens</text>
          {m.crossDay >= 0 && <g><circle cx={x(m.crossDay)} cy={y(m.path[m.crossDay].mc)} r="7" fill="var(--accent)" /><circle cx={x(m.crossDay)} cy={y(m.path[m.crossDay].mc)} r="13" fill="none" stroke="var(--accent)" strokeOpacity=".4" /><text x={x(m.crossDay) + 18} y={y(m.path[m.crossDay].mc) + 4} textAnchor="start" className="demo-tick hot">day {m.crossDay}: crosses the line</text></g>}
          <line x1={x(day)} x2={x(day)} y1={PY} y2={H - PY} stroke="var(--signal)" strokeWidth="1" strokeDasharray="3 4" />
          <circle cx={x(day)} cy={y(m.mcAtDay)} r="4.5" fill="var(--signal)" />
          {m.path.map((p) => p.t % 2 === 0 && <text key={p.t} x={x(p.t)} y={H - 2} textAnchor="middle" className="demo-tick">d{p.t}</text>)}
        </svg>
        <div className="demo-controls one">
          <Slider label="Scrub the timeline" value={day} min={0} max={HORIZON} step={1} onChange={setDay} fmt={(v) => `day ${v} · ${usd(m.mcAtDay)} market cap`} />
        </div>
        <div className="demo-grid3">
          <Stat label="Market cap on this day" value={usd(m.mcAtDay)} sub={m.crossDay >= 0 ? `crossed the line on day ${m.crossDay}` : "never reaches the line in this scenario"} hot={m.mcAtDay >= LINE_USD} />
          <Stat label="Volume so far" value={usd(m.cumVol)} sub={`${usd(m.v24)} in the last 24h`} />
          <Stat label="Your holding" value={usd(m.holdingsUsd)} sub={`${hold.toFixed(1)}% of supply · ${sol(m.holdingsSol, 2)}`} />
        </div>
        <ul className="demo-checks">
          {m.checks.map((c) => <li key={c.k}><i style={{ background: c.ok ? "var(--accent)" : "var(--danger)" }} /><span>{c.k}</span><span className="mono muted">{c.d}</span></li>)}
        </ul>
      </section>

      {/* ---- the ticket ---- */}
      <section className="demo-sec">
        <div className="demo-head">
          <h2 className="wm">What the ticket looks like</h2>
          <span className="mono muted">the exact numbers the program would write on day {day}</span>
        </div>
        <div className="demo-two">
          <div className="readout">
            <div className="readout-head"><span>Ticket · {m.ready ? "available" : "not available yet"}</span><span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "var(--accent)" }}><Mark size={16} tone="var(--muted)" small label="" /> HOCK</span></div>
            <div className="demo-tiers">
              {MEMECOIN_TIERS.map((t, i) => (
                <button key={t.option} type="button" className={`demo-tier${i === tierIdx ? " on" : ""}`} onClick={() => setTierIdx(i)}>
                  <span className="lab">{t.name}</span><b className="mono">{pct(t.ltvBps)} LTV</b><small>{t.durationDays} days · {pct(t.feeBps)} fee</small>
                </button>
              ))}
            </div>
            <div className="readout-row"><span className="lab">Collateral locked</span><span className="mono">{sol(m.holdingsSol, 2)} of your coin</span></div>
            <div className="readout-row"><span className="lab">Valuation</span><span className="mono">lower of spot and 30-min TWAP</span></div>
            <div className="readout-row"><span className="lab">Principal</span><span className="mono" style={{ fontSize: 22, color: "var(--accent)" }}>{sol(m.principal)}</span></div>
            <div className="readout-row"><span className="lab">Fee, paid into the pool</span><span className="mono">{sol(m.feeSol)} ({pct(tier.feeBps)})</span></div>
            <div className="readout-row"><span className="lab">You receive now</span><span className="mono" style={{ color: "var(--ink)", fontWeight: 600 }}>{sol(m.receive)} ≈ {usd(m.receive * solUsd)}</span></div>
            <div className="readout-row"><span className="lab">Repay to unlock</span><span className="mono">{sol(m.principal)} by {dueDate}</span></div>
            <div className="readout-grid">
              <div><span className="lab" style={{ fontSize: 10 }}>Cushion</span><b className="mono">{pctf(m.cushion)}</b><small>the coin can fall this far before the loan is worth more than the collateral</small></div>
              <div><span className="lab" style={{ fontSize: 10 }}>Pump guard</span><b className="mono">{pctf(PUMP_GUARD)}</b><small>spot above TWAP is ignored past this; nobody borrows against a spike</small></div>
              <div><span className="lab" style={{ fontSize: 10 }}>Exit floor</span><b className="mono">TWAP −{pctf(SLIPPAGE_FLOOR)}</b><small>if a limit-close fires, the vault never sells below this</small></div>
            </div>
            {!m.ready && <div className="demo-note">Below the line the ticket is grey: the gate has not opened borrowing for this coin on day {day}. Drag the timeline forward or pick a bigger launch.</div>}
          </div>
          <div className="demo-copy">
            <h3 className="wm">Why this matters to the launcher</h3>
            <p>Today a launcher who needs SOL has one move: sell. Selling into a young curve is the single most destructive thing they can do to their own coin. HOCK gives them a second move. Lock the coin in a vault the program controls, take a short loan against it, and keep every token.</p>
            <p>The ticket is deliberately conservative. The principal is sized off the lower of spot and a 30-minute average, so a spike buys nothing. Loans are two to seven days. The fee is paid up front into the pool that lent the SOL. If the launcher never comes back, the vault sells only what it must and returns the rest.</p>
            <h3 className="wm">Sell it, or hock it</h3>
            <div className="demo-vs">
              <div>
                <span className="lab">Sell {hold.toFixed(1)}% today</span>
                <b className="mono">{usd(m.sellProceeds)}</b>
                <small>{pctf(m.sellImpact, 0)} price impact into {usd(m.liquidity)} of liquidity. Position gone, chart damaged.</small>
              </div>
              <div className="hot">
                <span className="lab">Hock it, coin moves {move7d >= 0 ? "+" : ""}{pctf(move7d)} in a week</span>
                <b className="mono">{usd(m.hockNet)}</b>
                <small>{usd(m.receive * solUsd)} in hand now, coin worth {usd(m.laterValue)} at week's end, {usd(m.principal * solUsd)} owed. No sell pressure on the curve.</small>
              </div>
            </div>
            <div className="demo-controls one"><Slider label="What the coin does after the ticket" value={move7d} min={-0.8} max={3} step={0.05} onChange={setMove7d} fmt={(v) => `${v >= 0 ? "+" : ""}${pctf(v)}`} /></div>
          </div>
        </div>
      </section>

      {/* ---- what the launcher earns ---- */}
      <section className="demo-sec card">
        <div className="demo-head">
          <h2 className="wm">What the launcher earns</h2>
          <span className="mono muted">rewards compound with volume, borrowing power compounds with market cap</span>
        </div>
        <div className="demo-grid3">
          <Stat label={`Creator rewards by day ${day}`} value={usd(m.creatorEarned, 0)} sub={`${(creatorBps / 100).toFixed(2)}% of ${usd(m.cumVol)} traded`} hot />
          <Stat label="Borrowing power unlocked" value={m.ready ? sol(m.principal, 2) : "—"} sub={m.ready ? `${usd(m.principal * solUsd)} without selling a token` : "opens at the $50k line"} />
          <Stat label="Still held" value={usd(m.holdingsUsd)} sub="the whole position stays on the books" />
        </div>
        <div className="demo-controls one"><Slider label="Creator fee share of volume" value={creatorBps} min={0} max={100} step={1} onChange={setCreatorBps} fmt={(v) => `${(v / 100).toFixed(2)}% of volume`} /></div>
        <p className="demo-fine">Creator rewards are paid by the launch venue, not by HOCK; the default matches the common 0.05% of traded volume. HOCK adds the second line: a loan against the coin the moment it proves itself.</p>
      </section>

      {/* ---- lenders and protocol ---- */}
      <section className="demo-sec">
        <div className="demo-two">
          <div className="card corners">
            <div className="demo-head"><h2 className="wm" style={{ fontSize: 24 }}>The pawnbroker's side</h2></div>
            <p className="demo-fine">Lenders supply SOL to one pool. Every ticket pays its fee into the pool up front; 99% of fees stay with lenders. Loans are short and over-collateralised, so capital turns over every few days.</p>
            <div className="demo-grid3" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Stat label="Fee per cycle at this tier" value={`${pct(tier.feeBps)} / ${tier.durationDays} d`} sub="paid up front, 99% to the pool" />
              <Stat label="Annualised, if every ticket repays" value={pctf(m.apy, 0)} sub={`${pctf(util)} of the pool lent out, recycled every ${tier.durationDays} days; a conversion or liquidation lowers this`} hot />
                          </div>
            <div className="demo-controls one"><Slider label="Pool utilisation" value={util} min={0.05} max={0.95} step={0.05} onChange={setUtil} fmt={(v) => pctf(v)} /></div>
          </div>
          <div className="card corners">
            <div className="demo-head"><h2 className="wm" style={{ fontSize: 24 }}>The protocol's side</h2></div>
            <p className="demo-fine">HOCK takes a share of every borrow fee (set on the pool, adjustable by governance) and a 1% skim on limit-close proceeds. Launching stays free, so the funnel is wide and revenue follows the tickets.</p>
            <div className="demo-grid3" style={{ gridTemplateColumns: "1fr 1fr" }}>
              <Stat label="Revenue per ticket like this one" value={sol(m.perTicket, 4)} sub={`≈ ${usd(m.perTicket * solUsd, 2)}`} />
              <Stat label="At this ticket rate" value={usd(m.monthly * solUsd, 0) + " / mo"} sub={`${ticketsPerDay} tickets a day, average principal ${sol(m.principal, 2)}`} hot />
            </div>
            <div className="demo-controls">
              <Slider label="Protocol share of borrow fees" value={protocolShare} min={0.01} max={0.5} step={0.01} onChange={setProtocolShare} fmt={(v) => pctf(v)} />
              <Slider label="Tickets written per day" value={ticketsPerDay} min={1} max={2000} log onChange={(v) => setTicketsPerDay(Math.round(v))} fmt={(v) => `${Math.round(v)}`} />
              <Slider label="Tickets that end in a limit-close" value={fireRate} min={0} max={0.6} step={0.05} onChange={setFireRate} fmt={(v) => pctf(v)} />
            </div>
          </div>
        </div>
      </section>

      <p className="demo-fine" style={{ textAlign: "center", padding: "8px 0 24px" }}>
        Program constants shown here: memecoin tiers 30 / 25 / 20% LTV at 2 / 3 / 7 days for 3 / 2 / 1.5%, 30-minute TWAP with 8 samples minimum, 15% pump guard, 15% maximum conversion slippage, 1% keeper reward. Everything else is an input.
      </p>
    </div>
  );
}
