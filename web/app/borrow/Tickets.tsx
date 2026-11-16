"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getProgram, getPriceFeed, loanHealth, type LoanState, type PriceFeedState } from "@/lib/solana/program";
import { repayLoan, partialRepay, addCollateral, extendLoan, armConversion, disarmConversion, mintTokenProgram, ata } from "@/lib/solana/ix";
import { useAction, ActionButtons } from "@/lib/solana/useAction";
import { tierForLoan, extensionFee, pct } from "@/lib/tiers";
import { fmtLamports, fmtPriceLamports, fmtTokenAmount, fmtDate, fmtAge, parseUnits, DASH } from "@/lib/fmt";
import { computeExpiryUrgency } from "@/lib/loan/loan-expiry";
import { MAX_PROTOCOL_SLIPPAGE_BPS, BPS_DENOM } from "@/lib/solana/constants";
import { CopyAddress } from "@/components/CopyAddress";

type ReadyMint = { mint: string; name: string; symbol: string; decimals: number };
type LoanJson = Record<string, string | number>;

function fromJson(j: LoanJson): LoanState {
  const b = (k: string) => BigInt(String(j[k]));
  const n = (k: string) => Number(j[k]);
  return {
    address: new PublicKey(String(j.address)),
    loanId: b("loanId"),
    borrower: new PublicKey(String(j.borrower)),
    pool: new PublicKey(String(j.pool)),
    collateralMint: new PublicKey(String(j.collateralMint)),
    collateralVault: new PublicKey(String(j.collateralVault)),
    collateralAmount: b("collateralAmount"),
    currentCollateralAmount: b("currentCollateralAmount"),
    loanAmount: b("loanAmount"),
    repayAmount: b("repayAmount"),
    transactionFee: b("transactionFee"),
    ltvBps: n("ltvBps"),
    durationDays: n("durationDays"),
    startTimestamp: n("startTimestamp"),
    dueTimestamp: n("dueTimestamp"),
    status: String(j.status) as LoanState["status"],
    collateralValueAtStart: b("collateralValueAtStart"),
    category: n("category"),
    solProceedsAmount: b("solProceedsAmount"),
    autoSellsFired: n("autoSellsFired"),
    accruedPoolFees: b("accruedPoolFees"),
    armedTriggerPrice: b("armedTriggerPrice"),
    armedTriggerDirection: n("armedTriggerDirection"),
    armedMaxSliceBps: n("armedMaxSliceBps"),
    armedTotalBps: n("armedTotalBps"),
    armedConvertedBps: n("armedConvertedBps"),
  };
}

export function Tickets({ readyMints }: { readyMints: ReadyMint[] }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [loans, setLoans] = useState<LoanState[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [held, setHeld] = useState<{ mint: ReadyMint; amount: bigint }[] | null>(null);

  const load = useCallback(async () => {
    if (!wallet.publicKey) {
      setLoans(null);
      setHeld(null);
      return;
    }
    try {
      const r = await fetch(`/api/loans?wallet=${wallet.publicKey.toBase58()}`, { cache: "no-store" });
      const j = (await r.json()) as { loans?: LoanJson[]; error?: string };
      if (!r.ok || !j.loans) throw new Error(j.error || `loans read failed (${r.status})`);
      setLoans(j.loans.map(fromJson));
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "loans read failed");
    }
    try {
      const owner = wallet.publicKey;
      const [a, b] = await Promise.all([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
      ]);
      const byMint = new Map<string, bigint>();
      for (const acc of [...a.value, ...b.value]) {
        const info = acc.account.data.parsed?.info;
        if (info?.mint && info?.tokenAmount?.amount) byMint.set(info.mint, (byMint.get(info.mint) ?? 0n) + BigInt(info.tokenAmount.amount));
      }
      setHeld(readyMints.filter((m) => (byMint.get(m.mint) ?? 0n) > 0n).map((m) => ({ mint: m, amount: byMint.get(m.mint)! })));
    } catch {
      setHeld([]);
    }
  }, [connection, wallet.publicKey, readyMints]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  const open = useMemo(() => (loans ?? []).filter((l) => l.status === "active"), [loans]);
  const closed = useMemo(() => (loans ?? []).filter((l) => l.status !== "active"), [loans]);

  if (!wallet.publicKey) return <div className="card" style={{ color: "var(--body)" }}>Connect a wallet to see your tickets and the collateral-ready coins you hold.</div>;

  return (
    <div style={{ display: "grid", gap: 28 }}>
      <section style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <h2 className="wm" style={{ margin: 0, fontSize: 30 }}>Your tickets</h2>
          <span style={{ fontSize: 14, color: "var(--muted)" }}>{loans === null ? "Reading chain…" : `${open.length} open · ${closed.length} closed`}</span>
          <button type="button" className="btn line" onClick={load} style={{ marginLeft: "auto", minHeight: 36, padding: "0 14px", fontSize: 13 }}>Refresh</button>
        </div>
        {err && <span style={{ fontSize: 13, color: "var(--danger)" }}>{err}</span>}
        {loans !== null && open.length === 0 && <div className="card" style={{ color: "var(--body)" }}>No open tickets for this wallet.</div>}
        {open.map((l) => <LoanCard key={l.address.toBase58()} loan={l} onChanged={load} />)}
        {closed.length > 0 && (
          <details>
            <summary style={{ cursor: "pointer", color: "var(--muted)" }}>{closed.length} closed ticket{closed.length === 1 ? "" : "s"}</summary>
            <div style={{ display: "grid", gap: 10, marginTop: 10 }}>
              {closed.map((l) => (
                <div key={l.address.toBase58()} className="card" style={{ padding: 18, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
                  <span className={`pill ${l.status === "repaid" ? "ready" : "delisted"}`}>{l.status}</span>
                  <span className="mono" style={{ fontSize: 13 }}>{fmtLamports(l.loanAmount)} · due {fmtDate(l.dueTimestamp)}</span>
                  <CopyAddress value={l.address.toBase58()} size={11} />
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      <section style={{ display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
          <h2 className="wm" style={{ margin: 0, fontSize: 30 }}>Collateral you hold</h2>
          <span style={{ fontSize: 14, color: "var(--muted)" }}>Collateral-ready coins in this wallet</span>
        </div>
        {held === null && <span style={{ color: "var(--muted)" }}>Reading token accounts…</span>}
        {held && held.length === 0 && <div className="card" style={{ color: "var(--body)" }}>None of the collateral-ready coins are in this wallet. <Link href="/board">See the board</Link>.</div>}
        {held && held.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 14 }}>
            {held.map(({ mint, amount }) => (
              <Link key={mint.mint} href={`/coin/${mint.mint}`} className="card" style={{ padding: 20, display: "grid", gap: 6, color: "var(--ink)" }}>
                <strong>{mint.name} <span className="mono" style={{ color: "var(--muted)" }}>${mint.symbol}</span></strong>
                <span className="mono" style={{ fontSize: 14 }}>{fmtTokenAmount(amount, mint.decimals, mint.symbol)}</span>
                <span className="mono" style={{ fontSize: 11, color: "var(--muted)", overflowWrap: "anywhere" }}>{mint.mint}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

type Mode = "none" | "partial" | "add" | "extend" | "arm";

function LoanCard({ loan, onChanged }: { loan: LoanState; onChanged: () => void }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [feed, setFeed] = useState<PriceFeedState | null>(null);
  const [decimals, setDecimals] = useState<number | null>(null);
  const [symbol, setSymbol] = useState<string>("");
  const [collBal, setCollBal] = useState<bigint | null>(null);
  const [mode, setMode] = useState<Mode>("none");
  const [input, setInput] = useState("");
  const [trigger, setTrigger] = useState("");
  const [direction, setDirection] = useState<0 | 1>(1);
  const [slice, setSlice] = useState("2500");
  const [total, setTotal] = useState("10000");
  const a = useAction("repay");

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const program = getProgram(connection);
        const [f, mintInfo] = await Promise.all([getPriceFeed(program, loan.collateralMint), connection.getAccountInfo(loan.collateralMint, "confirmed")]);
        if (!live) return;
        setFeed(f);
        if (mintInfo && mintInfo.data.length >= 45) setDecimals(mintInfo.data[44]);
        if (wallet.publicKey) {
          const tp = await mintTokenProgram(connection, loan.collateralMint);
          try {
            const b = await connection.getTokenAccountBalance(ata(loan.collateralMint, wallet.publicKey, tp), "confirmed");
            if (live) setCollBal(BigInt(b.value.amount));
          } catch {
            if (live) setCollBal(0n);
          }
        }
        fetch(`/api/mints/${loan.collateralMint.toBase58()}`).then((r) => (r.ok ? r.json() : null)).then((j) => live && j?.symbol && setSymbol(j.symbol)).catch(() => {});
      } catch {
        /* dashes */
      }
    })();
    return () => {
      live = false;
    };
  }, [connection, loan.collateralMint, wallet.publicKey, a.state.phase]);

  useEffect(() => {
    // Re-read the ticket after a confirmed action: once right away and once more a few seconds later so the card
    // reflects chain state even when the RPC's confirmed view lags the confirmation by a slot or two.
    if (a.state.phase !== "done") return;
    onChanged();
    const t = setTimeout(onChanged, 3000);
    return () => clearTimeout(t);
  }, [a.state.phase, onChanged]);

  const tier = tierForLoan(loan.category, loan.ltvBps);
  const health = decimals !== null ? loanHealth(loan, feed, decimals) : null;
  const urgency = computeExpiryUrgency(loan.dueTimestamp * 1000);
  const overdue = Date.now() / 1000 > loan.dueTimestamp;
  const extFee = tier ? extensionFee(loan.repayAmount, tier) : null;
  const armed = loan.armedTriggerPrice > 0n;
  const floor = feed?.twap ? (feed.twap.price * BigInt(BPS_DENOM - MAX_PROTOCOL_SLIPPAGE_BPS)) / BigInt(BPS_DENOM) : null;
  const defaultTrigger = health?.thresholdPrice ? (health.thresholdPrice * 11000n) / 10000n : null;
  const triggerRaw = trigger ? parseUnits(trigger, 9) : defaultTrigger;
  const sliceN = Number(slice);
  const totalN = Number(total);
  const armOk = !!triggerRaw && triggerRaw > 0n && sliceN > 0 && sliceN <= 10000 && totalN >= sliceN && totalN <= 10000 && !overdue;
  // Program valuation with the chosen trigger as price, less max slippage: the floor the engine's min_sol_out must clear at that price.
  const minOutAtTrigger = triggerRaw && decimals !== null ? ((loan.currentCollateralAmount * BigInt(Math.max(1, Math.min(10000, sliceN)))) / 10000n * triggerRaw) / 10n ** BigInt(decimals) * BigInt(BPS_DENOM - MAX_PROTOCOL_SLIPPAGE_BPS) / BigInt(BPS_DENOM) : null;

  const partialRaw = parseUnits(input, 9);
  const addRaw = decimals !== null ? parseUnits(input, decimals) : null;

  function pick(m: Mode) {
    setMode(m === mode ? "none" : m);
    setInput("");
    a.reset();
  }

  const ctx = (program: Parameters<Parameters<typeof a.prepare>[0]>[0]) => ({ program: program.program, connection, wallet: program.wallet, pool: program.pool });

  return (
    <article className="card" style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="wm" style={{ fontSize: 18, letterSpacing: ".06em" }}>TICKET</span>
        <span className={`pill ${overdue ? "delisted" : urgency.tier === "critical" || urgency.tier === "urgent" ? "grading" : "ready"}`}>{overdue ? "Past due" : `Due in ${urgency.label}`}</span>
        {armed && <span className="pill launched">Limit-close armed</span>}
        {health && <span className={`pill ${health.healthy ? "ready" : "delisted"}`}>{health.healthy ? "Healthy" : "Under-collateralised"}</span>}
        <span style={{ marginLeft: "auto" }}><CopyAddress value={loan.address.toBase58()} label="Loan" size={11} /></span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
        <Stat k="Collateral in vault" v={decimals === null ? DASH : fmtTokenAmount(loan.currentCollateralAmount, decimals, symbol || undefined)} s={loan.autoSellsFired ? `${loan.autoSellsFired} slice${loan.autoSellsFired === 1 ? "" : "s"} converted` : "none converted"} />
        <Stat k="Principal" v={fmtLamports(loan.loanAmount)} s={`fee paid ${fmtLamports(loan.transactionFee)}`} />
        <Stat k="Repay" v={fmtLamports(loan.repayAmount)} s={loan.solProceedsAmount > 0n ? `${fmtLamports(loan.solProceedsAmount)} already in proceeds vault` : undefined} />
        <Stat k="Due" v={fmtDate(loan.dueTimestamp)} s={tier ? `${tier.name} · ${pct(tier.ltvBps)} LTV · ${tier.durationDays} d` : `${pct(loan.ltvBps)} LTV`} />
        <Stat k="Valuation price" v={fmtPriceLamports(feed?.valuationPrice ?? null)} s={feed ? `feed ${fmtAge(feed.ageSeconds)} old` : "no feed"} />
        <Stat k="Health threshold" v={fmtPriceLamports(health?.thresholdPrice ?? null)} s="LTV stops covering repay below this" />
        {armed && <Stat k="Trigger" v={fmtPriceLamports(loan.armedTriggerPrice)} s={`${loan.armedTriggerDirection === 1 ? "stop-loss" : "take-profit"} · ${pct(loan.armedMaxSliceBps)} per fire · ${pct(loan.armedTotalBps)} total · ${pct(loan.armedConvertedBps)} done`} />}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button type="button" className="btn ink" style={{ minHeight: 44, padding: "0 18px", fontSize: 14 }} disabled={!wallet.publicKey} onClick={() => { setMode("none"); a.prepare((p) => repayLoan(ctx(p), loan)); }}>Repay {fmtLamports(loan.repayAmount)}</button>
        {(["partial", "add", "extend", "arm"] as Mode[]).map((m) => (
          <button key={m} type="button" className="btn line" style={{ minHeight: 44, padding: "0 16px", fontSize: 14, borderColor: mode === m ? "var(--accent)" : undefined }} disabled={!wallet.publicKey} onClick={() => pick(m)}>
            {m === "partial" ? "Partial repay" : m === "add" ? "Add collateral" : m === "extend" ? "Extend" : armed ? "Re-arm limit-close" : "Arm limit-close"}
          </button>
        ))}
        {armed && <button type="button" className="btn line" style={{ minHeight: 44, padding: "0 16px", fontSize: 14 }} disabled={!wallet.publicKey || overdue} onClick={() => { setMode("none"); a.prepare((p) => disarmConversion(ctx(p), loan)); }}>Disarm</button>}
      </div>

      {mode === "partial" && (
        <Panel title="Partial repay" note="Must leave a remainder; the final payment goes through Repay so the collateral is returned.">
          <Input value={input} onChange={(v) => { setInput(v); a.reset(); }} unit="SOL" />
          <ActionButtons a={a} label="Sign partial repay" disabled={!partialRaw || partialRaw <= 0n || partialRaw >= loan.repayAmount} onSimulate={() => partialRaw && a.prepare((p) => partialRepay(ctx(p), loan, partialRaw))} />
        </Panel>
      )}
      {mode === "add" && (
        <Panel title="Add collateral" note={`No fee. Wallet holds ${collBal === null || decimals === null ? DASH : fmtTokenAmount(collBal, decimals, symbol || undefined)}.`}>
          <Input value={input} onChange={(v) => { setInput(v); a.reset(); }} unit={symbol || "tokens"} />
          <ActionButtons a={a} label="Sign add collateral" disabled={!addRaw || addRaw <= 0n || (collBal !== null && addRaw > collBal)} onSimulate={() => addRaw && a.prepare((p) => addCollateral(ctx(p), loan, addRaw))} />
        </Panel>
      )}
      {mode === "extend" && (
        <Panel title="Extend" note={tier ? `Adds ${tier.durationDays} days for a fee of ${fmtLamports(extFee)} (${pct(tier.feeBps)} of the outstanding repay amount). Only a loan the program can prove healthy from a fresh feed extends without the pool authority; ${health ? (health.healthy ? "this one currently qualifies." : "this one currently does not.") : "health is unknown until the feed is read."}` : "Tier could not be resolved."}>
          <ActionButtons a={a} label="Sign extend" disabled={!extFee || overdue} onSimulate={() => extFee && a.prepare((p) => extendLoan(ctx(p), loan, extFee))} />
        </Panel>
      )}
      {mode === "arm" && (
        <Panel title="Arm limit-close" note="Consent, recorded on chain, for the engine to convert collateral inside the vault once the attested price crosses your trigger. The program also enforces a floor on every conversion: at least the TWAP value of the slice minus 15 percent.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12 }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="lab">Trigger price (SOL per token)</span>
              <input className="mono" value={trigger} placeholder={defaultTrigger ? (Number(defaultTrigger) / 1e9).toString() : ""} onChange={(e) => { setTrigger(e.target.value); a.reset(); }} style={inputStyle} />
              <span style={{ fontSize: 12, color: "var(--muted)" }}>default: health threshold plus 10%</span>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="lab">Direction</span>
              <select value={direction} onChange={(e) => { setDirection(Number(e.target.value) as 0 | 1); a.reset(); }} style={inputStyle}>
                <option value={1}>Stop-loss (at or below)</option>
                <option value={0}>Take-profit (at or above)</option>
              </select>
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="lab">Max slice per fire (bps)</span>
              <input className="mono" value={slice} onChange={(e) => { setSlice(e.target.value); a.reset(); }} style={inputStyle} />
            </label>
            <label style={{ display: "grid", gap: 6 }}>
              <span className="lab">Total allowed (bps)</span>
              <input className="mono" value={total} onChange={(e) => { setTotal(e.target.value); a.reset(); }} style={inputStyle} />
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 12, background: "var(--panel-2)", borderRadius: 12, padding: 14 }}>
            <Stat k="Trigger" v={fmtPriceLamports(triggerRaw ?? null)} />
            <Stat k="Floor now (TWAP minus 15%)" v={fmtPriceLamports(floor)} s="per token" />
            <Stat k="Min SOL out at trigger" v={fmtLamports(minOutAtTrigger)} s="for the first slice, program-enforced floor" />
          </div>
          <ActionButtons a={a} label="Sign arm" disabled={!armOk} onSimulate={() => triggerRaw && a.prepare((p) => armConversion(ctx(p), loan, { triggerPriceLamports: triggerRaw, direction, maxSliceBps: sliceN, totalBps: totalN }))} />
        </Panel>
      )}
      {mode === "none" && a.state.phase !== "idle" && <ActionButtons a={a} label={a.state.built?.label === "disarm limit-close" ? "Sign disarm" : "Sign repay"} onSimulate={() => a.state.built?.label === "disarm limit-close" ? a.prepare((p) => disarmConversion(ctx(p), loan)) : a.prepare((p) => repayLoan(ctx(p), loan))} />}
    </article>
  );
}

const inputStyle: React.CSSProperties = { fontSize: 16, padding: "10px 12px", borderRadius: 10, border: "1px solid var(--line)", fontFamily: "inherit", background: "var(--field)" };

function Input({ value, onChange, unit }: { value: string; onChange: (v: string) => void; unit: string }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      <input className="mono" value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" placeholder="0" style={{ ...inputStyle, flex: 1, fontSize: 18 }} />
      <span className="mono" style={{ color: "var(--muted)" }}>{unit}</span>
    </div>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gap: 14, borderTop: "1px solid var(--line)", paddingTop: 16 }}>
      <h3 style={{ margin: 0, fontSize: 18 }}>{title}</h3>
      {note && <p style={{ margin: 0, fontSize: 14, color: "var(--body)" }}>{note}</p>}
      {children}
    </div>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span className="lab" style={{ fontSize: 10 }}>{k}</span>
      <b className="mono" style={{ display: "block", fontSize: 16, overflowWrap: "anywhere" }}>{v}</b>
      {s && <span style={{ fontSize: 12, color: "var(--muted)" }}>{s}</span>}
    </div>
  );
}
