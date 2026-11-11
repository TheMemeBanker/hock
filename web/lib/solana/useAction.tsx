"use client";

/**
 * Simulate-then-sign state machine shared by every action panel. A button is
 * enabled only when the wallet is connected and the most recent simulation of
 * the exact transaction passed; any input change invalidates the simulation.
 */
import { useCallback, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Transaction } from "@solana/web3.js";
import { getProgram, getPool, type HockProgram, type PoolState } from "./program";
import { simulate, signAndSend, signCosignAndSend, type BuiltTx, type ProgramError } from "./ix";
import { explorerUrl } from "./constants";

export type Phase = "idle" | "building" | "simulated" | "failed" | "signing" | "confirming" | "done" | "pending";

export type ActionState = {
  phase: Phase;
  built: BuiltTx | null;
  unitsConsumed: number | null;
  error: ProgramError | null;
  sig: string | null;
  logs: string[];
};

const initial: ActionState = { phase: "idle", built: null, unitsConsumed: null, error: null, sig: null, logs: [] };

export function useAction(flow: "deposit" | "withdraw" | "repay" = "repay") {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [state, setState] = useState<ActionState>(initial);

  const reset = useCallback(() => setState(initial), []);

  /** Build with the caller's builder, then simulate. Enables Sign only when the simulation passes. */
  const prepare = useCallback(
    async (build: (ctx: { program: HockProgram; pool: PoolState; wallet: NonNullable<typeof wallet.publicKey> }) => Promise<BuiltTx>) => {
      if (!wallet.publicKey || !wallet.signTransaction) {
        setState({ ...initial, phase: "failed", error: { title: "Wallet not connected", body: "Connect a wallet that can sign transactions." } });
        return;
      }
      setState({ ...initial, phase: "building" });
      try {
        const program = getProgram(connection, { publicKey: wallet.publicKey, signTransaction: wallet.signTransaction, signAllTransactions: wallet.signAllTransactions! });
        const pool = await getPool(program);
        if (!pool) throw new Error("Pool account not found at NEXT_PUBLIC_POOL_PDA.");
        const built = await build({ program, pool, wallet: wallet.publicKey });
        const sim = await simulate(connection, built, flow);
        if (sim.ok) setState({ phase: "simulated", built, unitsConsumed: sim.unitsConsumed, error: null, sig: null, logs: sim.logs });
        else setState({ phase: "failed", built, unitsConsumed: null, error: sim.error, sig: null, logs: sim.logs });
      } catch (e) {
        setState({ ...initial, phase: "failed", error: { title: "Could not build transaction", body: e instanceof Error ? e.message : String(e) } });
      }
    },
    [connection, wallet.publicKey, wallet.signTransaction, wallet.signAllTransactions, flow],
  );

  /** Sign the already-simulated transaction and confirm. */
  const sign = useCallback(async () => {
    if (state.phase !== "simulated" || !state.built || !wallet.publicKey) return;
    setState((s) => ({ ...s, phase: "signing" }));
    try {
      const signer = {
        sendTransaction: (tx: Transaction, conn: typeof connection) => wallet.sendTransaction(tx, conn),
        signTransaction: wallet.signTransaction,
      };
      const run = state.built.needsAuthorityCosign ? signCosignAndSend : signAndSend;
      setState((s) => ({ ...s, phase: "confirming" }));
      const r = await run(connection, state.built, signer);
      if (r.ok) setState((s) => ({ ...s, phase: "done", sig: r.sig }));
      else if (r.pending) setState((s) => ({ ...s, phase: "pending", sig: r.sig, error: { title: "Not yet confirmed", body: "The transaction was sent but has not confirmed. Check the explorer before retrying." } }));
      else setState((s) => ({ ...s, phase: "failed", sig: r.sig, error: { title: "Transaction failed on chain", body: typeof r.err === "string" ? r.err : JSON.stringify(r.err) } }));
    } catch (e) {
      setState((s) => ({ ...s, phase: "failed", error: { title: "Signing failed", body: e instanceof Error ? e.message : String(e) } }));
    }
  }, [connection, state.phase, state.built, wallet]);

  return { state, prepare, sign, reset, connected: !!wallet.publicKey, explorer: state.sig ? explorerUrl("tx", state.sig) : null };
}

/** Standard Simulate / Sign button pair + status line. */
export function ActionButtons({ a, label, disabled, onSimulate }: { a: ReturnType<typeof useAction>; label: string; disabled?: boolean; onSimulate: () => void }) {
  const { state } = a;
  const busy = state.phase === "building" || state.phase === "signing" || state.phase === "confirming";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button type="button" className="btn line" disabled={!a.connected || disabled || busy} onClick={onSimulate}>
          {state.phase === "building" ? "Simulating…" : "Simulate"}
        </button>
        <button type="button" className="btn green" disabled={!a.connected || state.phase !== "simulated"} onClick={a.sign}>
          {state.phase === "signing" ? "Sign in wallet…" : state.phase === "confirming" ? "Confirming…" : label}
        </button>
      </div>
      <ActionStatus a={a} />
    </div>
  );
}

export function ActionStatus({ a }: { a: ReturnType<typeof useAction> }) {
  const { state } = a;
  if (state.phase === "idle" || state.phase === "building") return <span style={{ fontSize: 13, color: "var(--muted)" }}>{a.connected ? "Simulate first. The signature prompt only appears after a passing simulation." : "Connect a wallet to continue."}</span>;
  if (state.phase === "simulated") return <span style={{ fontSize: 13, color: "var(--green-2)", fontWeight: 600 }}>Simulation passed{state.unitsConsumed ? ` (${state.unitsConsumed.toLocaleString("en-US")} compute units)` : ""}. Ready to sign.</span>;
  if (state.phase === "done") return <span style={{ fontSize: 13, color: "var(--green-2)", fontWeight: 600 }}>Confirmed. {a.explorer && <a href={a.explorer} target="_blank" rel="noopener noreferrer">View transaction</a>}</span>;
  if (state.error) return (
    <div style={{ fontSize: 13, background: "var(--pink-lite)", color: "#B3104F", borderRadius: 12, padding: "10px 14px" }}>
      <strong>{state.error.title}{state.error.code ? ` (${state.error.code})` : ""}.</strong> {state.error.body}{" "}
      {a.explorer && <a href={a.explorer} target="_blank" rel="noopener noreferrer" style={{ color: "#B3104F", fontWeight: 700 }}>View transaction</a>}
    </div>
  );
  return null;
}
