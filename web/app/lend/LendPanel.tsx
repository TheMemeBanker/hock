"use client";

import { useCallback, useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { getProgram, getPool, getDepositorPosition, type PoolState, type DepositorPositionState } from "@/lib/solana/program";
import { deposit, withdraw } from "@/lib/solana/ix";
import { useAction, ActionButtons } from "@/lib/solana/useAction";
import { fmtLamports, parseUnits, DASH } from "@/lib/fmt";
import { TX_FEE_RESERVE_LAMPORTS } from "@/lib/loan/repay-readiness";

export function LendPanel() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [pool, setPool] = useState<PoolState | null>(null);
  const [pos, setPos] = useState<DepositorPositionState | null>(null);
  const [sol, setSol] = useState<bigint | null>(null);
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [input, setInput] = useState("");
  const dep = useAction("deposit");
  const wd = useAction("withdraw");
  const a = tab === "deposit" ? dep : wd;

  const load = useCallback(async () => {
    try {
      const program = getProgram(connection);
      const p = await getPool(program);
      setPool(p);
      if (wallet.publicKey) {
        const [q, bal] = await Promise.all([getDepositorPosition(program, wallet.publicKey), connection.getBalance(wallet.publicKey, "confirmed")]);
        setPos(q);
        setSol(BigInt(bal));
      } else {
        setPos(null);
        setSol(null);
      }
    } catch {
      /* dashes */
    }
  }, [connection, wallet.publicKey]);

  useEffect(() => {
    load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (dep.state.phase === "done" || wd.state.phase === "done") load();
  }, [dep.state.phase, wd.state.phase, load]);

  const shareValue = pool && pos && pool.totalShares > 0n ? (pos.shares * pool.totalDeposits) / pool.totalShares : null;
  const available = pool ? pool.totalDeposits - pool.totalBorrowed : null;
  const lamports = parseUnits(input, 9);
  // Withdraw takes shares; convert the SOL the user typed into shares (floor) as the program's inverse.
  const sharesFor = lamports !== null && pool && pool.totalDeposits > 0n ? (lamports * pool.totalShares) / pool.totalDeposits : null;
  const maxDeposit = sol !== null ? (sol > TX_FEE_RESERVE_LAMPORTS ? sol - TX_FEE_RESERVE_LAMPORTS : 0n) : null;
  const depOk = lamports !== null && lamports > 0n && (maxDeposit === null || lamports <= maxDeposit) && !!pool && !pool.paused;
  const wdOk = sharesFor !== null && sharesFor > 0n && !!pos && sharesFor <= pos.shares && lamports !== null && available !== null && lamports <= available;

  return (
    <div className="card" style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 14 }}>
        <Stat k="Your position" v={fmtLamports(shareValue)} s={pos ? `${pos.shares.toLocaleString("en-US")} shares` : wallet.publicKey ? "no position" : "connect a wallet"} />
        <Stat k="Deposited (cost basis)" v={fmtLamports(pos?.depositedAmount ?? null)} />
        <Stat k="Wallet SOL" v={fmtLamports(sol)} />
        <Stat k="Withdrawable now" v={fmtLamports(shareValue !== null && available !== null ? (shareValue < available ? shareValue : available) : null)} s="limited by pool utilisation" />
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        {(["deposit", "withdraw"] as const).map((t) => (
          <button key={t} type="button" className={`btn ${tab === t ? "ink" : "line"}`} style={{ minHeight: 40, padding: "0 16px", fontSize: 14 }} onClick={() => { setTab(t); setInput(""); dep.reset(); wd.reset(); }}>
            {t === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>

      <label style={{ display: "grid", gap: 8 }}>
        <span className="lab">{tab === "deposit" ? "Amount to deposit (SOL)" : "Amount to withdraw (SOL)"}</span>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input className="mono" value={input} onChange={(e) => { setInput(e.target.value); a.reset(); }} inputMode="decimal" placeholder="0" style={{ flex: "1 1 200px", fontSize: 20, padding: "12px 14px", borderRadius: 12, border: "1px solid var(--line)", fontFamily: "inherit" }} />
          <button type="button" className="btn line" disabled={tab === "deposit" ? maxDeposit === null : shareValue === null} onClick={() => {
            const m = tab === "deposit" ? maxDeposit : shareValue !== null && available !== null ? (shareValue < available ? shareValue : available) : null;
            if (m !== null) { setInput((Number(m) / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, "")); a.reset(); }
          }}>Max</button>
        </div>
        <span style={{ fontSize: 13, color: "var(--muted)" }}>
          {tab === "deposit" ? "SOL is wrapped for the deposit and the wrapper account is closed in the same transaction." : sharesFor !== null ? `${sharesFor.toLocaleString("en-US")} shares redeemed; the wSOL is unwrapped back to SOL in the same transaction.` : "Withdrawals are limited to deposits not currently lent out."}
          {pool?.paused ? " Pool is paused." : ""}
        </span>
      </label>

      {tab === "deposit" ? (
        <ActionButtons a={dep} label="Sign deposit" disabled={!depOk} onSimulate={() => lamports && dep.prepare(({ program, pool: p, wallet: w }) => deposit({ program, connection, wallet: w, pool: p }, lamports))} />
      ) : (
        <ActionButtons a={wd} label="Sign withdraw" disabled={!wdOk} onSimulate={() => sharesFor && wd.prepare(({ program, pool: p, wallet: w }) => withdraw({ program, connection, wallet: w, pool: p }, sharesFor))} />
      )}
      <span style={{ fontSize: 12, color: "var(--muted)" }}>{DASH === "—" ? "Figures above are read from the pool account every 20 seconds." : ""}</span>
    </div>
  );
}

function Stat({ k, v, s }: { k: string; v: string; s?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span className="lab" style={{ fontSize: 10 }}>{k}</span>
      <b className="mono" style={{ display: "block", fontSize: 18, overflowWrap: "anywhere" }}>{v}</b>
      {s && <span style={{ fontSize: 12, color: "var(--muted)" }}>{s}</span>}
    </div>
  );
}
