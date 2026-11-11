import { DocShell, H2, Table } from "@/components/DocShell";
import { MEMECOIN_TIERS, pct, previewLoan } from "@/lib/tiers";
import { getProgram, getPool, serverConnection } from "@/lib/solana/program";
import { POOL_PDA, PROGRAM_ID, PROTOCOL_FEE_BPS_AUTOSELL, MAX_PROTOCOL_SLIPPAGE_BPS } from "@/lib/solana/constants";
import { fmtPct, fmtLamports, DASH } from "@/lib/fmt";

export const revalidate = 60;
export const metadata = { title: "Fees" };

export default async function Fees() {
  let protocolFee: string = DASH;
  let keeper: string = DASH;
  if (serverConnection() && PROGRAM_ID && POOL_PDA) {
    try {
      const pool = await getPool(getProgram(serverConnection()!));
      if (pool) {
        protocolFee = fmtPct(pool.protocolFeeBps);
        keeper = fmtPct(pool.keeperRewardBps);
      }
    } catch {
      /* dashes */
    }
  }
  const example = 10n * 10n ** 9n; // 10 SOL of collateral value, illustrative arithmetic only
  return (
    <DocShell title="Fees" kicker="Read from the program and the pool" current="/docs/fees">
      <H2>Launch</H2>
      <p>Free. An optional initial buy pays only the router's own fee and Solana network fees.</p>
      <H2>Borrow</H2>
      <p>A tier fee on the principal, charged at origination into the pool. The loan is sized from the collateral value at the lower of spot and TWAP; the fee is rounded up to the lamport, and you receive principal minus fee. The repay amount equals the principal.</p>
      <Table
        head={["Tier", "LTV", "Term", "Fee on principal", "Per 10 SOL of collateral value: receive / fee / repay"]}
        rows={MEMECOIN_TIERS.map((t) => {
          const p = previewLoan(example, t);
          return [t.name, pct(t.ltvBps), `${t.durationDays} days`, pct(t.feeBps), `${fmtLamports(p.net)} / ${fmtLamports(p.fee)} / ${fmtLamports(p.repay)}`];
        })}
      />
      <p style={{ fontSize: 15, color: "var(--muted)" }}>The table mirrors the tier constants in the program source; the on-chain tier table is authoritative.</p>
      <H2>Fee split</H2>
      <Table head={["Item", "Value", "Source"]} rows={[
        ["Protocol share of borrow fees", protocolFee, "LendingPool.protocol_fee_bps"],
        ["Lender share of borrow fees", protocolFee === DASH ? DASH : `${(100 - parseFloat(protocolFee)).toFixed(2).replace(/\.?0+$/, "")}%`, "remainder stays in the pool"],
        ["Keeper reward on exits", keeper, "LendingPool.keeper_reward_bps"],
        ["Protocol skim on limit-close proceeds", fmtPct(PROTOCOL_FEE_BPS_AUTOSELL), "program constant"],
        ["Maximum protocol slippage on a conversion", fmtPct(MAX_PROTOCOL_SLIPPAGE_BPS), "program constant"],
      ]} />
      <H2>Extend</H2>
      <p>The tier fee applied to the outstanding repay amount, rounded up, paid into the pool with the same protocol split. Extension adds one full term from the current due date.</p>
      <H2>Add collateral, partial repay, arm, disarm</H2>
      <p>No protocol fee. Network fees and a dynamic priority fee only; the site shows the simulated compute before you sign.</p>
      <H2>Lenders</H2>
      <p>No deposit or withdrawal fee. Yield is the pool's share of borrow and extension fees, realised as share-price appreciation. The lend page computes the realised figure from pool snapshots; nothing is projected.</p>
    </DocShell>
  );
}
