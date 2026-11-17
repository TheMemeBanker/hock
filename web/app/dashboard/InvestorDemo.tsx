"use client";

/**
 * Investor demo. A guided story, not a workbench: one scenario, four moments, one number per moment.
 * The program arithmetic (tiers, fee, LTV, TWAP cap, floor) is real; prices, volume and holdings are
 * modelled inputs that live behind the Assumptions drawer. Nothing is read from chain.
 */
import { useMemo, useState } from "react";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";
import { Mark } from "@/components/Mark";

export const INVESTOR_WALLET = process.env.NEXT_PUBLIC_INVESTOR_WALLET || "BFceiceSoKBFCibgqdkitH83TVDesxvNPhGLc5zHJu88";

const LINE = 50_000;
const DAYS = 14;

type Scenario = { id: string; name: string; mc: number; vol: number; hold: number; shape: (t: number) => number; line: string };
const SCENARIOS: Scenario[] = [
  { id: "quiet", name: "Quiet launch", mc: 18_000, vol: 9_000, hold: 4, shape: (t) => 0.25 + 0.75 * (1 - Math.exp(-t / 5)), line: "Never reaches the line. The gate stays shut and nobody can borrow against it." },
  { id: "cross", name: "Crosses the line", mc: 84_000, vol: 60_000, hold: 3, shape: (t) => 1 / (1 + Math.exp(-(t - 3.2) * 1.1)) * 0.92 + 0.08, line: "A good launch. Holds $50k on day four and the launcher writes a ticket instead of selling." },
  { id: "runner", name: "Runner", mc: 650_000, vol: 1_400_000, hold: 2, shape: (t) => Math.min(1, 0.06 + Math.pow(t / 10, 1.6)), line: "Breaks out on day one. The ticket is a fraction of the coin; the rewards compound with volume." },
];

const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `$${(n / 1e3).toFixed(1)}k` : `$${Math.round(n).toLocaleString("en-US")}`;
const sol = (n: number, dp = 2) => `${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })} SOL`;
const pc = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;

function Range({ label, value, min, max, step, log, onChange, fmt }: { label: string; value: number; min: number; max: number; step?: number; log?: boolean; onChange: (v: number) => void; fmt: (v: number) => string }) {
  const toPos = (v: number) => log ? (Math.log(v) - Math.log(min)) / (Math.log(max) - Math.log(min)) : (v - min) / (max - min);
  const fromPos = (p: number) => log ? Math.exp(Math.log(min) + p * (Math.log(max) - Math.log(min))) : min + p * (max - min);
  return (
    <label className="st-range">
      <span>{label}</span>
      <input type="range" min={0} max={1000} value={Math.round(toPos(value) * 1000)} onChange={(e) => { const v = fromPos(Number(e.target.value) / 1000); onChange(step ? Math.round(v / step) * step : v); }} />
      <b className="mono">{fmt(value)}</b>
    </label>
  );
}

export function InvestorDemo({ wallet }: { wallet: string }) {
  const [sid, setSid] = useState("cross");
  const sc = SCENARIOS.find((s) => s.id === sid)!;
  const [mc, setMc] = useState(sc.mc);
  const [vol, setVol] = useState(sc.vol);
  const [hold, setHold] = useState(sc.hold);
  const [tierIdx, setTierIdx] = useState(2); // Standard: the calm default
  const [solUsd, setSolUsd] = useState(72);
  const [creatorBps, setCreatorBps] = useState(5);
  const [move, setMove] = useState(0.5);
  const [util, setUtil] = useState(0.5);
  const [perDay, setPerDay] = useState(40);
  const [share, setShare] = useState(0.1);
  const pick = (s: Scenario) => { setSid(s.id); setMc(s.mc); setVol(s.vol); setHold(s.hold); };

  const tier = MEMECOIN_TIERS[tierIdx];
  const m = useMemo(() => {
    const peak = Math.max(...Array.from({ length: DAYS + 1 }, (_, t) => sc.shape(t)));
    const path = Array.from({ length: DAYS + 1 }, (_, t) => (sc.shape(t) / peak) * mc);
    const crossDay = path.findIndex((v) => v >= LINE);
    const ready = crossDay >= 0;
    const cumVol = path.slice(1).reduce((a, v) => a + vol * (v / mc), 0);
    const liquidity = mc * 0.08;
    const holdingsUsd = mc * (hold / 100);
    const holdingsSol = holdingsUsd / solUsd;
    const ltv = tier.ltvBps / 10_000, fee = tier.feeBps / 10_000;
    const principal = holdingsSol * ltv;
    const feeSol = Math.ceil(principal * fee * 1e9) / 1e9;
    const receive = principal - feeSol;
    const sellImpact = Math.min(0.9, holdingsUsd / Math.max(liquidity, 1));
    const sellProceeds = holdingsUsd * (1 - sellImpact / 2);
    const later = holdingsUsd * (1 + move);
    const hockNet = later + receive * solUsd - principal * solUsd;
    const creator = cumVol * (creatorBps / 10_000);
    const apy = (fee / tier.durationDays) * 365 * util * 0.99;
    const perTicket = principal * fee * share;
    const monthly = perTicket * perDay * 30;
    return { path, crossDay, ready, cumVol, liquidity, holdingsUsd, holdingsSol, principal, feeSol, receive, ltv, sellImpact, sellProceeds, later, hockNet, creator, apy, perTicket, monthly };
  }, [sc, mc, vol, hold, tier, solUsd, creatorBps, move, util, perDay, share]);

  // chart
  const W = 760, H = 200, L = 10, R = 10, T = 16, B = 26;
  const maxY = Math.max(LINE * 1.3, ...m.path);
  const X = (t: number) => L + (t / DAYS) * (W - L - R);
  const Y = (v: number) => T + (1 - v / maxY) * (H - T - B);
  const d = m.path.map((v, t) => `${t ? "L" : "M"}${X(t).toFixed(1)} ${Y(v).toFixed(1)}`).join(" ");
  const area = `${d} L${X(DAYS)} ${Y(0)} L${X(0)} ${Y(0)} Z`;
  const due = new Date(Date.now() + tier.durationDays * 86_400_000).toLocaleDateString("en-US", { month: "short", day: "numeric" });

  return (
    <div className="st">
      <div className="st-switch" role="tablist" aria-label="Scenario">
        {SCENARIOS.map((s) => <button key={s.id} role="tab" aria-selected={s.id === sid} type="button" className={s.id === sid ? "on" : ""} onClick={() => pick(s)}>{s.name}</button>)}
        <span className="st-tag">modelled scenario</span>
      </div>

      {/* 01 the coin */}
      <section className="st-slide">
        <span className="st-n">01</span>
        <div className="st-text">
          <h2 className="wm">A coin launches on HOCK.</h2>
          <p>{sc.line}</p>
        </div>
        <div className="st-chart">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Market cap over fourteen days against the $50,000 line">
            <defs><linearGradient id="st-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--accent)" stopOpacity=".28" /><stop offset="1" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
            <path d={area} fill="url(#st-area)" />
            <line x1={L} x2={W - R} y1={Y(LINE)} y2={Y(LINE)} stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="6 6" />
            <text x={W - R} y={Y(LINE) - 8} textAnchor="end" className="st-tick hot">$50,000</text>
            <path d={d} fill="none" stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
            {m.ready && <g><circle cx={X(m.crossDay)} cy={Y(m.path[m.crossDay])} r="16" fill="var(--accent)" fillOpacity=".18" /><circle cx={X(m.crossDay)} cy={Y(m.path[m.crossDay])} r="7" fill="var(--accent)" stroke="var(--bg)" strokeWidth="3" /></g>}
            <text x={X(0)} y={H - 6} className="st-tick">launch</text>
            <text x={X(DAYS)} y={H - 6} textAnchor="end" className="st-tick">day 14</text>
          </svg>
          <div className="st-kpis">
            <div><span>Market cap, day 14</span><b className="mono">{usd(mc)}</b></div>
            <div><span>Traded in two weeks</span><b className="mono">{usd(m.cumVol)}</b></div>
            <div className={m.ready ? "hot" : ""}><span>The $50k line</span><b className="mono">{m.ready ? `crossed on day ${m.crossDay}` : "not reached"}</b></div>
          </div>
        </div>
      </section>

      {/* 02 the ticket */}
      <section className={`st-slide${m.ready ? "" : " dim"}`}>
        <span className="st-n">02</span>
        <div className="st-text">
          <h2 className="wm">{m.ready ? "Borrowing opens. The launcher writes a ticket." : "Below the line, no ticket exists."}</h2>
          <p>{m.ready ? `Holding ${hold.toFixed(1)}% of the supply, worth ${usd(m.holdingsUsd)}, locked in a vault the program controls. ${pct(tier.ltvBps)} of that value comes out as SOL. Repay in ${tier.durationDays} days to unlock. Not one token is sold.` : "The gate fails closed. A coin that has not held $50,000 of market cap cannot be collateral, so nobody can borrow against it and no lender is exposed to it."}</p>
          <div className="st-tiers" role="tablist" aria-label="Tier">
            {MEMECOIN_TIERS.map((t, i) => <button key={t.option} role="tab" aria-selected={i === tierIdx} type="button" className={i === tierIdx ? "on" : ""} onClick={() => setTierIdx(i)}>{t.durationDays} days · {pct(t.ltvBps)}</button>)}
          </div>
        </div>
        <div className="st-ticket">
          <div className="st-ticket-head"><span>Ticket</span><Mark size={18} tone="var(--muted)" small label="" /></div>
          <div className="st-big"><span>You receive now</span><b className="mono">{sol(m.receive)}</b><small>≈ {usd(m.receive * solUsd)}, after the {pct(tier.feeBps)} fee paid into the pool</small></div>
          <div className="st-rows">
            <div><span>Collateral locked</span><b className="mono">{sol(m.holdingsSol)} of your coin</b></div>
            <div><span>Repay to unlock</span><b className="mono">{sol(m.principal)} by {due}</b></div>
            <div><span>Room before trouble</span><b className="mono">coin can fall {pc(1 - m.ltv)}</b></div>
          </div>
        </div>
      </section>

      {/* 03 sell vs hock */}
      <section className={`st-slide${m.ready ? "" : " dim"}`}>
        <span className="st-n">03</span>
        <div className="st-text">
          <h2 className="wm">Why this beats selling.</h2>
          <p>Selling {hold.toFixed(1)}% of a young coin into {usd(m.liquidity)} of liquidity moves the price {pc(m.sellImpact)} and ends the position. Hocking it puts SOL in hand today and keeps every token for whatever comes next.</p>
        </div>
        <div className="st-vs">
          <div>
            <span>Sell today</span>
            <b className="mono">{usd(m.sellProceeds)}</b>
            <small>once, and the chart carries the damage</small>
          </div>
          <div className="hot">
            <span>Hock it, coin {move >= 0 ? "up" : "down"} {pc(Math.abs(move))} in a week</span>
            <b className="mono">{usd(m.hockNet)}</b>
            <small>{usd(m.receive * solUsd)} in hand, coin worth {usd(m.later)}, {usd(m.principal * solUsd)} owed</small>
          </div>
        </div>
      </section>

      {/* 04 who earns */}
      <section className="st-slide">
        <span className="st-n">04</span>
        <div className="st-text">
          <h2 className="wm">Three people get paid.</h2>
          <p>The launcher earns from volume and borrows without selling. Lenders earn the ticket fees. HOCK takes a share of every fee, on a pad where launching is free.</p>
        </div>
        <div className="st-three">
          <div><span>Launcher</span><b className="mono">{usd(m.creator)}</b><small>creator rewards on {usd(m.cumVol)} of volume, plus {m.ready ? sol(m.principal) : "borrowing"} unlocked without selling</small></div>
          <div><span>Lenders</span><b className="mono">{pc(m.apy)}</b><small>annualised at {pc(util)} utilisation, if every ticket repays; {pct(tier.feeBps)} per {tier.durationDays}-day ticket</small></div>
          <div className="hot"><span>HOCK, per month</span><b className="mono">{usd(m.monthly * solUsd)}</b><small>{pc(share)} of fees on {perDay} tickets a day like this one</small></div>
        </div>
      </section>

      <details className="st-assume">
        <summary><span className="mono">Assumptions</span><span>the dials behind the numbers · program constants are fixed</span></summary>
        <div className="st-assume-grid">
          <Range label="Market cap on day 14" value={mc} min={5_000} max={3_000_000} log onChange={setMc} fmt={usd} />
          <Range label="24h volume at that cap" value={vol} min={1_000} max={10_000_000} log onChange={setVol} fmt={usd} />
          <Range label="Supply the launcher holds" value={hold} min={0.1} max={15} step={0.1} onChange={setHold} fmt={(v) => `${v.toFixed(1)}%`} />
          <Range label="SOL price" value={solUsd} min={20} max={400} step={1} onChange={setSolUsd} fmt={(v) => `$${v}`} />
          <Range label="Coin move in the week after the ticket" value={move} min={-0.8} max={3} step={0.05} onChange={setMove} fmt={(v) => `${v >= 0 ? "+" : ""}${pc(v)}`} />
          <Range label="Creator fee share of volume" value={creatorBps} min={0} max={100} step={1} onChange={setCreatorBps} fmt={(v) => `${(v / 100).toFixed(2)}%`} />
          <Range label="Pool utilisation" value={util} min={0.05} max={0.95} step={0.05} onChange={setUtil} fmt={(v) => pc(v)} />
          <Range label="Tickets written per day" value={perDay} min={1} max={2000} log onChange={(v) => setPerDay(Math.round(v))} fmt={(v) => `${Math.round(v)}`} />
          <Range label="HOCK's share of borrow fees" value={share} min={0.01} max={0.5} step={0.01} onChange={setShare} fmt={(v) => pc(v)} />
        </div>
        <p className="st-fine">Fixed by the program: tiers 30 / 25 / 20% LTV at 2 / 3 / 7 days for 3 / 2 / 1.5%; collateral valued at the lower of spot and a 30-minute TWAP; a 15% pump guard; exits never below TWAP minus 15%. Liquidity is modelled as 8% of market cap, which is what a bonding-curve coin holds. Creator rewards are paid by the launch venue, not HOCK. Wallet {wallet.slice(0, 4)}…{wallet.slice(-4)}.</p>
      </details>
    </div>
  );
}
