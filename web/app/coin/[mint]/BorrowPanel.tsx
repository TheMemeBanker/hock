"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { MEMECOIN_TIERS, previewLoan, pct, type Tier } from "@/lib/tiers";
import { getProgram, getPriceFeed, getPool, collateralValueLamports, type PriceFeedState, type PoolState } from "@/lib/solana/program";
import { requestAndFundLoan, mintTokenProgram, ata } from "@/lib/solana/ix";
import { useAction, ActionButtons } from "@/lib/solana/useAction";
import { fmtLamports, fmtPriceLamports, fmtTokenAmount, parseUnits, DASH } from "@/lib/fmt";
import { MAX_PROTOCOL_SLIPPAGE_BPS, BPS_DENOM } from "@/lib/solana/constants";

type Props = { mint: string; symbol: string; decimals: number };

export function BorrowPanel({ mint, symbol, decimals }: Props) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [tier, setTier] = useState<Tier>(MEMECOIN_TIERS[0]);
  const [amount, setAmount] = useState("");
  const [balance, setBalance] = useState<bigint | null>(null);
  const [feed, setFeed] = useState<PriceFeedState | null>(null);
  const [pool, setPool] = useState<PoolState | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const a = useAction("repay");
  const mintKey = useMemo(() => new PublicKey(mint), [mint]);

  const refresh = useCallback(async () => {
    try {
      const program = getProgram(connection);
      const [f, p] = await Promise.all([getPriceFeed(program, mintKey), getPool(program)]);
      setFeed(f);
      setPool(p);
      setReadErr(null);
      if (wallet.publicKey) {
        const tp = await mintTokenProgram(connection, mintKey);
        try {
          const b = await connection.getTokenAccountBalance(ata(mintKey, wallet.publicKey, tp), "confirmed");
          setBalance(BigInt(b.value.amount));
        } catch {
          setBalance(0n);
        }
      } else setBalance(null);
    } catch (e) {
      setReadErr(e instanceof Error ? e.message : "chain read failed");
    }
  }, [connection, mintKey, wallet.publicKey]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, [refresh]);

  const raw = parseUnits(amount, decimals);
  const value = raw !== null && feed?.valuationPrice ? collateralValueLamports(raw, feed.valuationPrice, decimals) : null;
  const preview = value !== null ? previewLoan(value, tier) : null;
  const available = pool ? pool.totalDeposits - pool.totalBorrowed : null;
  const dueAt = new Date(Date.now() + tier.durationDays * 86_400_000);
  // Price at which the loan's LTV no longer covers repay (the health threshold the program evaluates for extensions).
  const threshold = raw && raw > 0n && preview ? (preview.repay * BigInt(BPS_DENOM) * 10n ** BigInt(decimals)) / (raw * BigInt(tier.ltvBps)) : null;
  const floor = feed?.twap ? (feed.twap.price * BigInt(BPS_DENOM - MAX_PROTOCOL_SLIPPAGE_BPS)) / BigInt(BPS_DENOM) : null;

  const inputOk = raw !== null && raw > 0n && (balance === null || raw <= balance) && !!feed?.borrowable && preview !== null && preview.net > 0n && (available === null || preview.gross <= available);
  const whyNot = !feed ? "No on-chain price feed for this mint." : !feed.borrowable ? feed.reason : raw === null ? "Enter a collateral amount." : balance !== null && raw > balance ? "More than your wallet holds." : available !== null && preview && preview.gross > available ? `Pool has ${fmtLamports(available)} available; this loan needs ${fmtLamports(preview.gross)}.` : pool?.paused ? "Pool is paused." : null;

  function onInput(v: string) {
    setAmount(v);
    a.reset();
  }

  return (
    <div className="card" style={{ display: "grid", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap" }}>
        <h2 className="wm" style={{ margin: 0, fontSize: 28 }}>Hock it</h2>
        <span style={{ fontSize: 14, color: "var(--muted)" }}>Collateral goes into the vault; SOL comes out of the pool. Repay any time before the due date to unlock.</span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
        {MEMECOIN_TIERS.map((t) => (
          <button key={t.option} type="button" onClick={() => { setTier(t); a.reset(); }} style={{ textAlign: "left", cursor: "pointer", fontFamily: "inherit", borderRadius: 16, padding: "14px 16px", border: `2px solid ${tier.option === t.option ? "var(--green)" : "var(--line)"}`, background: tier.option === t.option ? "var(--green-lite)" : "#fff" }}>
            <span className="lab">{t.name}</span>
            <b className="mono" style={{ display: "block", fontSize: 20 }}>{pct(t.ltvBps)} LTV</b>
            <span style={{ fontSize: 13, color: "var(--body)" }}>{t.durationDays} days · {pct(t.feeBps)} fee</span>
          </button>
        ))}
      </div>

      <label style={{ display: "grid", gap: 8 }}>
        <span className="lab">Collateral amount ({symbol})</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input className="mono" value={amount} onChange={(e) => onInput(e.target.value)} inputMode="decimal" placeholder="0" style={{ flex: "1 1 220px", fontSize: 20, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", fontFamily: "inherit" }} />
          <button type="button" className="btn line" disabled={balance === null} onClick={() => balance !== null && onInput(fmtTokenAmount(balance, decimals).replace(/,/g, ""))}>Max</button>
        </div>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>Wallet balance: {balance === null ? DASH : fmtTokenAmount(balance, decimals, symbol)}</span>
      </label>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14, background: "var(--gold-lite)", borderRadius: 16, padding: 18 }}>
        <Cell k="Valuation price" v={fmtPriceLamports(feed?.valuationPrice ?? null)} s="lower of spot and TWAP" />
        <Cell k="Collateral value" v={fmtLamports(value)} />
        <Cell k="You receive" v={fmtLamports(preview?.net ?? null)} s="principal minus fee" />
        <Cell k="Fee" v={fmtLamports(preview?.fee ?? null)} s={`${pct(tier.feeBps)} of principal`} />
        <Cell k="Repay" v={fmtLamports(preview?.repay ?? null)} />
        <Cell k="Due" v={dueAt.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })} s={`${tier.durationDays} days from signing`} />
        <Cell k="Health threshold" v={fmtPriceLamports(threshold)} s="price where LTV no longer covers repay" />
        <Cell k="Conversion floor" v={fmtPriceLamports(floor)} s="TWAP minus 15% max slippage" />
      </div>

      {readErr && <span style={{ fontSize: 13, color: "#B3104F" }}>Chain read failed: {readErr}</span>}
      {whyNot && !readErr && <span style={{ fontSize: 13, color: "var(--muted)" }}>{whyNot}</span>}

      <ActionButtons
        a={a}
        label="Sign borrow"
        disabled={!inputOk}
        onSimulate={() => {
          if (!raw || value === null) return;
          a.prepare(({ program, pool: p, wallet: w }) => requestAndFundLoan({ program, connection, wallet: w, pool: p }, { mint: mintKey, collateralAmountRaw: raw, collateralValueLamports: value, tier: tier.option }));
        }}
      />
      <span style={{ fontSize: 12, color: "var(--muted)" }}>The program requires the pool authority to co-sign each borrow after you sign; your signature is collected first and the transaction is broadcast only once both are present.</span>
    </div>
  );
}

function Cell({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span className="lab" style={{ fontSize: 10, color: "#5a4400" }}>{k}</span>
      <b className="mono" style={{ display: "block", fontSize: 17, overflowWrap: "anywhere" }}>{v}</b>
      {s && <span style={{ fontSize: 12, color: "#4a3a00" }}>{s}</span>}
    </div>
  );
}
