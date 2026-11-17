"use client";

/**
 * Demo dashboard for the investor wallet. A real dashboard layout: identity, KPI strip, coins table,
 * gate ring, ticket card, earnings chart, activity feed. The program arithmetic is the program's;
 * the market is a modelled scenario chosen from the selector. Nothing is read from chain.
 */
import { useMemo, useState } from "react";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";
import { Mark } from "@/components/Mark";
import { MILESTONE_TIERS, evaluateMilestones, boostFor } from "@/lib/rewards";

export const INVESTOR_WALLET = process.env.NEXT_PUBLIC_INVESTOR_WALLET || "BFceiceSoKBFCibgqdkitH83TVDesxvNPhGLc5zHJu88";

const LINE = 50_000;
const DAYS = 14;
const COIN = { name: "Orbit", symbol: "ORBIT" };

type Scenario = { id: string; name: string; mc: number; vol: number; hold: number; shape: (t: number) => number; desc: string };
const SCENARIOS: Scenario[] = [
  { id: "quiet", name: "Quiet launch", mc: 18_000, vol: 9_000, hold: 4, shape: (t) => 0.25 + 0.75 * (1 - Math.exp(-t / 5)), desc: "Most launches. Tops out around $18k and never reaches the line, so the gate stays shut: no ticket, no lender exposure, no one gets hurt." },
  { id: "cross", name: "Crosses the line", mc: 84_000, vol: 60_000, hold: 3, shape: (t) => 1 / (1 + Math.exp(-(t - 3.2) * 1.1)) * 0.92 + 0.08, desc: "A good launch. Climbs for three days, holds $50k on day four, and the launcher takes a ticket instead of selling into their own chart." },
  { id: "runner", name: "Runner", mc: 650_000, vol: 1_400_000, hold: 2, shape: (t) => Math.min(1, 0.06 + Math.pow(t / 10, 1.6)), desc: "The breakout. Crosses on day one and keeps going to $650k; rewards compound with volume and the ticket is a small fraction of the position." },
];

const usd = (n: number, dp = 0) => n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 10_000 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toLocaleString("en-US", { maximumFractionDigits: dp })}`;
const sol = (n: number, dp = 2) => `${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })} SOL`;
const pc = (x: number, dp = 0) => `${(x * 100).toFixed(dp)}%`;
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

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
  const [tierIdx, setTierIdx] = useState(2);
  const [solUsd, setSolUsd] = useState(72);
  const [creatorBps, setCreatorBps] = useState(5);
  const [util, setUtil] = useState(0.5);
  const pick = (id: string) => { const s = SCENARIOS.find((x) => x.id === id)!; setSid(id); setMc(s.mc); setVol(s.vol); setHold(s.hold); };

  const tier = MEMECOIN_TIERS[tierIdx];
  const m = useMemo(() => {
    const peak = Math.max(...Array.from({ length: DAYS + 1 }, (_, t) => sc.shape(t)));
    const path = Array.from({ length: DAYS + 1 }, (_, t) => (sc.shape(t) / peak) * mc);
    const crossDay = path.findIndex((v) => v >= LINE);
    const ready = crossDay >= 0;
    const volByDay = path.map((v, t) => (t === 0 ? 0 : vol * (v / mc)));
    const cumVol = volByDay.reduce((a, b) => a + b, 0);
    const rewardByDay = volByDay.map((v) => v * (creatorBps / 10_000));
    const creator = rewardByDay.reduce((a, b) => a + b, 0);
    const liquidity = mc * 0.08;
    const holdingsUsd = mc * (hold / 100);
    const holdingsSol = holdingsUsd / solUsd;
    const ltv = tier.ltvBps / 10_000, fee = tier.feeBps / 10_000;
    const principal = holdingsSol * ltv;
    const feeSol = Math.ceil(principal * fee * 1e9) / 1e9;
    const receive = principal - feeSol;
    const v24 = vol, impact = (0.5 * solUsd) / Math.max(liquidity, 1);
    const checks = [
      { k: "Market cap ≥ $50k", ok: mc >= LINE },
      { k: "Liquidity", ok: liquidity >= 2_500 },
      { k: "Velocity", ok: v24 >= 5_000 },
      { k: "Routability", ok: impact <= 0.08 },
      { k: "Holders", ok: hold <= 40 },
      { k: "Extensions", ok: true },
    ];
    const gateOk = checks.every((c) => c.ok);
    const apy = (fee / tier.durationDays) * 365 * util * 0.99;
    const poolSize = 1_250; // modelled pool, SOL
    const protocolMonthly = principal * fee * 0.1 * 40 * 30;
    const dayOfTicket = ready ? crossDay : null;
    const boost = boostFor({ neverSold: true, hocked: ready && gateOk });
    const milestones = evaluateMilestones(path, { boost: boost.mult, gatePasses: gateOk, launcherRetainedPct: 100, today: DAYS });
    const milestoneSol = milestones.reduce((a, r) => a + r.paidSol, 0);
    const next = milestones.find((r) => r.status !== "paid") ?? null;
    const portfolio = holdingsUsd + (ready ? receive * solUsd : 0) + creator + milestoneSol * solUsd;
    return { path, crossDay, ready: ready && gateOk, cumVol, rewardByDay, creator, liquidity, holdingsUsd, holdingsSol, principal, feeSol, receive, ltv, checks, apy, poolSize, protocolMonthly, dayOfTicket, portfolio, boost, milestones, milestoneSol, next };
  }, [sc, mc, vol, hold, tier, solUsd, creatorBps, util]);

  // sparkline + bars geometry
  const SW = 300, SH = 64;
  const smax = Math.max(LINE * 1.15, ...m.path);
  const sx = (t: number) => (t / DAYS) * SW;
  const sy = (v: number) => SH - 4 - (v / smax) * (SH - 8);
  const spark = m.path.map((v, t) => `${t ? "L" : "M"}${sx(t).toFixed(1)} ${sy(v).toFixed(1)}`).join(" ");
  const BW = 420, BH = 120;
  const rmax = Math.max(1, ...m.rewardByDay);
  const ringPct = Math.min(1, mc / LINE);
  const C = 2 * Math.PI * 54;
  const due = new Date(Date.now() + tier.durationDays * 86_400_000);
  const dueLabel = due.toLocaleDateString("en-US", { month: "short", day: "numeric" });

  const activity = [
    { d: 0, t: "Launched", s: `${COIN.name} · 1,000,000,000 supply · art on Arweave`, k: "" },
    { d: 1, t: "Grading", s: "gate reading market cap, liquidity, velocity, route, holders", k: "" },
    ...m.milestones.filter((r) => r.status === "paid").map((r) => ({ d: r.dayReached ?? 0, t: `Milestone · ${r.name}`, s: `${usd(r.capUsd)} held 24h on TWAP · ${sol(r.paidSol)} paid${m.boost.mult > 1 ? ` (${m.boost.mult.toFixed(2)}x boost)` : ""}`, k: "hot" })),
    ...(m.ready ? [
      { d: m.crossDay, t: "Crossed $50,000", s: "collateral ready · price feed initialised", k: "hot" },
      { d: m.crossDay, t: "Ticket written", s: `${sol(m.principal)} principal · ${tier.name} · ${pct(tier.feeBps)} fee to the pool`, k: "hot" },
      { d: Math.min(DAYS, m.crossDay + tier.durationDays), t: "Repay due", s: `${sol(m.principal)} unlocks ${sol(m.holdingsSol)} of ${COIN.symbol}`, k: "" },
    ] : [{ d: DAYS, t: "Still below the line", s: "no ticket can exist; no lender is exposed", k: "" }]),
  ];

  activity.sort((a, b) => a.d - b.d);

  return (
    <div className="db">
      {/* identity bar */}
      <div className="db-id">
        <span className="db-avatar"><Mark size={26} tone="var(--ink)" small label="" /></span>
        <div className="db-who">
          <b className="mono">{short(wallet)}</b>
          <span>Launcher · 1 coin · joined day 0</span>
        </div>
        <div className="db-scn">
          <span className="lab">Scenario</span>
          <div className="db-seg" role="tablist">
            {SCENARIOS.map((s) => <button key={s.id} role="tab" type="button" aria-selected={s.id === sid} className={s.id === sid ? "on" : ""} onClick={() => pick(s.id)}>{s.name}</button>)}
          </div>
          <span className="db-model">modelled</span>
        </div>
        <p className="db-scn-desc"><b>{sc.name}.</b> {sc.desc}</p>
      </div>

      {/* KPI strip */}
      <div className="db-kpis">
        <div><span>Portfolio</span><b className="mono">{usd(m.portfolio)}</b><small>{COIN.symbol} + SOL in hand + rewards</small></div>
        <div><span>Borrowing power</span><b className="mono" style={{ color: m.ready ? "var(--accent)" : undefined }}>{m.ready ? sol(m.principal) : "—"}</b><small>{m.ready ? `${pct(tier.ltvBps)} of ${usd(m.holdingsUsd)} at ${tier.name}` : "opens at the $50k line"}</small></div>
        <div><span>Open tickets</span><b className="mono">{m.ready ? "1" : "0"}</b><small>{m.ready ? `${sol(m.principal)} owed · due ${dueLabel}` : "nothing outstanding"}</small></div>
        <div><span>Earned, 14 days</span><b className="mono">{usd(m.creator + m.milestoneSol * solUsd)}</b><small>{usd(m.creator)} creator rewards + {sol(m.milestoneSol)} milestones</small></div>
      </div>

      <div className="db-grid">
        {/* coins */}
        <section className="db-panel span2">
          <header><h2>Your coins</h2><span className="mono">1 launched</span></header>
          <div className="db-scroll"><table className="db-table">
            <thead><tr><th>Coin</th><th>14d</th><th>Mkt cap</th><th>24h vol</th><th>You hold</th><th>Gate</th><th>Borrow</th></tr></thead>
            <tbody>
              <tr>
                <td><div className="db-coin"><span className="art-ph" style={{ width: 32, height: 32 }}><Mark size={16} tone="var(--line-2)" hot="var(--line-2)" /></span><div><strong>{COIN.name}</strong><span className="mono">${COIN.symbol}</span></div></div></td>
                <td><svg viewBox={`0 0 ${SW} ${SH}`} className="db-spark" aria-hidden><line x1="0" x2={SW} y1={sy(LINE)} y2={sy(LINE)} stroke="var(--accent)" strokeDasharray="3 4" strokeWidth="1" /><path d={spark} fill="none" stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" />{m.ready && <circle cx={sx(m.crossDay)} cy={sy(m.path[m.crossDay])} r="4" fill="var(--accent)" />}</svg></td>
                <td className="mono">{usd(mc)}</td>
                <td className="mono">{usd(vol)}</td>
                <td className="mono">{usd(m.holdingsUsd)}<small>{hold.toFixed(1)}%</small></td>
                <td><span className={`pill ${m.ready ? "ready" : mc >= LINE ? "grading" : "grading"}`}>{m.ready ? "Collateral ready" : `Gate ${m.checks.filter((c) => c.ok).length} of 6`}</span></td>
                <td className="mono" style={{ color: m.ready ? "var(--accent)" : "var(--muted)" }}>{m.ready ? sol(m.principal) : "—"}</td>
              </tr>
            </tbody>
          </table></div>
        </section>

        {/* gate */}
        <section className="db-panel">
          <header><h2>The $50k line</h2><span className="mono">{COIN.symbol}</span></header>
          <div className="db-ring-wrap">
            <svg viewBox="0 0 128 128" className="db-ring" role="img" aria-label={`${pc(ringPct)} of the way to $50,000`}>
              <circle cx="64" cy="64" r="54" fill="none" stroke="var(--line-2)" strokeWidth="8" />
              <circle cx="64" cy="64" r="54" fill="none" stroke={m.ready ? "var(--accent)" : "var(--warn)"} strokeWidth="8" strokeLinecap="round" strokeDasharray={`${C * ringPct} ${C}`} transform="rotate(-90 64 64)" />
              <text x="64" y="60" textAnchor="middle" className="db-ring-n">{pc(ringPct)}</text>
              <text x="64" y="78" textAnchor="middle" className="db-ring-s">{usd(mc)}</text>
            </svg>
            <ul className="db-checks">{m.checks.map((c) => <li key={c.k}><i style={{ background: c.ok ? "var(--accent)" : "var(--line-2)" }} />{c.k}</li>)}</ul>
          </div>
        </section>

        {/* ticket */}
        <section className="db-panel">
          <header><h2>Ticket</h2>{m.ready ? <span className="pill ready">open</span> : <span className="pill launched">none</span>}</header>
          {m.ready ? (
            <div className="db-ticket">
              <div className="db-ticket-top"><span>You received</span><b className="mono">{sol(m.receive)}</b><small>≈ {usd(m.receive * solUsd)} · {tier.name} · {pct(tier.feeBps)} fee</small></div>
              <dl>
                <div><dt>Collateral</dt><dd className="mono">{sol(m.holdingsSol)} {COIN.symbol}</dd></div>
                <div><dt>Repay</dt><dd className="mono">{sol(m.principal)}</dd></div>
                <div><dt>Due</dt><dd className="mono">{dueLabel} · {tier.durationDays} d</dd></div>
              </dl>
              <div className="db-health">
                <div className="db-health-head"><span>Health</span><b className="mono">coin can fall {pc(1 - m.ltv)}</b></div>
                <div className="db-health-bar"><i style={{ width: `${(1 - m.ltv) * 100}%` }} /></div>
              </div>
              <div className="db-tiers">{MEMECOIN_TIERS.map((t, i) => <button key={t.option} type="button" className={i === tierIdx ? "on" : ""} onClick={() => setTierIdx(i)}>{t.durationDays}d · {pct(t.ltvBps)}</button>)}</div>
            </div>
          ) : (
            <div className="db-empty"><b>Below the line</b><span>A coin that has not held $50,000 cannot be collateral. The gate fails closed; no lender is exposed.</span></div>
          )}
        </section>

        {/* earnings */}
        <section className="db-panel span2">
          <header><h2>Earnings</h2><span className="mono">creator rewards · {(creatorBps / 100).toFixed(2)}% of volume</span></header>
          <div className="db-earn">
            <svg viewBox={`0 0 ${BW} ${BH}`} className="db-bars" role="img" aria-label="Creator rewards per day">
              {m.rewardByDay.map((r, t) => t > 0 && <rect key={t} x={(t - 1) * (BW / DAYS) + 6} y={BH - 18 - (r / rmax) * (BH - 28)} width={BW / DAYS - 12} height={(r / rmax) * (BH - 28)} rx="3" fill={m.ready && t >= m.crossDay ? "var(--accent)" : "var(--line-2)"} />)}
              <text x="0" y={BH - 4} className="st-tick">day 1</text><text x={BW} y={BH - 4} textAnchor="end" className="st-tick">day 14</text>
            </svg>
            <div className="db-earn-side">
              <div><span>Total</span><b className="mono">{usd(m.creator)}</b></div>
              <div><span>Best day</span><b className="mono">{usd(rmax)}</b></div>
              <div><span>Unlocked without selling</span><b className="mono" style={{ color: m.ready ? "var(--accent)" : undefined }}>{m.ready ? sol(m.principal) : "—"}</b></div>
            </div>
          </div>
        </section>

        {/* milestones */}
        <section className="db-panel span2">
          <header><h2>Milestones</h2><span className="mono">{sol(m.milestoneSol)} paid · boost {m.boost.mult.toFixed(2)}x</span></header>
          <div className="db-ms">
            <ol className="db-ladder">
              {m.milestones.map((r) => (
                <li key={r.rank} className={r.status}>
                  <span className="db-ms-cap mono">{r.capUsd >= 1e6 ? `$${r.capUsd / 1e6}M` : `$${r.capUsd / 1e3}k`}</span>
                  <i />
                  <b>{r.name}</b>
                  <small className="mono">{r.status === "paid" ? `${sol(r.paidSol)} paid` : r.status === "claimable" ? `${sol(r.rewardSol * m.boost.mult)} claimable` : r.status === "holding" ? `holding · ${Math.round(r.holdPct * 100)}%` : r.status === "forfeited" ? "forfeited" : `${r.rewardSol} SOL`}</small>
                </li>
              ))}
            </ol>
            <div className="db-ms-side">
              <div><span>Next</span><b className="mono">{m.next ? `${m.next.name} · ${usd(m.next.capUsd)}` : "ladder complete"}</b><small>{m.next ? `${sol(m.next.rewardSol * m.boost.mult)} when held 24h on TWAP` : `${MILESTONE_TIERS.length} of ${MILESTONE_TIERS.length} paid`}</small></div>
              <div><span>Boosts</span><b className="mono">{m.boost.active.length ? m.boost.active.map((b) => b.name).join(" · ") : "none yet"}</b><small>{m.boost.active.length ? `+${Math.round((m.boost.mult - 1) * 100)}% on every tier` : "never sell, or hock instead of selling"}</small></div>
              <div><span>Rules</span><b className="mono">24h hold · gate open · still holding</b><small>spikes, dumps and one-wallet coins don't pay</small></div>
            </div>
          </div>
        </section>

        {/* pool */}
        <section className="db-panel">
          <header><h2>Pool</h2><span className="mono">lender side</span></header>
          <dl className="db-dl">
            <div><dt>Pool size</dt><dd className="mono">{sol(m.poolSize, 0)}</dd></div>
            <div><dt>Utilisation</dt><dd className="mono">{pc(util)}</dd></div>
            <div><dt>Lender yield</dt><dd className="mono" style={{ color: "var(--accent)" }}>{pc(m.apy)}</dd></div>
            <div><dt>Fee per ticket</dt><dd className="mono">{pct(tier.feeBps)} / {tier.durationDays} d</dd></div>
            <div><dt>To HOCK, per month</dt><dd className="mono">{usd(m.protocolMonthly * solUsd)}</dd></div>
          </dl>
        </section>

        {/* activity */}
        <section className="db-panel span3">
          <header><h2>Activity</h2><span className="mono">{COIN.symbol} · last 14 days</span></header>
          <ol className="db-feed">
            {activity.map((a, i) => (
              <li key={i} className={a.k}><span className="mono db-day">day {a.d}</span><b>{a.t}</b><span>{a.s}</span></li>
            ))}
          </ol>
        </section>
      </div>

      <details className="st-assume">
        <summary><span className="mono">Assumptions</span><span>modelled scenario · program constants fixed · nothing read from chain</span></summary>
        <div className="st-assume-grid">
          <Range label="Market cap on day 14" value={mc} min={5_000} max={3_000_000} log onChange={setMc} fmt={(v) => usd(v)} />
          <Range label="24h volume" value={vol} min={1_000} max={10_000_000} log onChange={setVol} fmt={(v) => usd(v)} />
          <Range label="Supply you hold" value={hold} min={0.1} max={15} step={0.1} onChange={setHold} fmt={(v) => `${v.toFixed(1)}%`} />
          <Range label="SOL price" value={solUsd} min={20} max={400} step={1} onChange={setSolUsd} fmt={(v) => `$${v}`} />
          <Range label="Creator fee share of volume" value={creatorBps} min={0} max={100} step={1} onChange={setCreatorBps} fmt={(v) => `${(v / 100).toFixed(2)}%`} />
          <Range label="Pool utilisation" value={util} min={0.05} max={0.95} step={0.05} onChange={setUtil} fmt={(v) => pc(v)} />
        </div>
        <p className="st-fine">Program constants: tiers 30 / 25 / 20% LTV at 2 / 3 / 7 days for 3 / 2 / 1.5%; collateral valued at the lower of spot and a 30-minute TWAP; 15% pump guard; exits never below TWAP minus 15%. Liquidity modelled at 8% of market cap. Creator rewards are paid by the launch venue. Protocol line assumes 10% of fees on 40 tickets a day. Pool size is illustrative.</p>
      </details>
    </div>
  );
}
