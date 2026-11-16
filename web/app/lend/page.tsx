import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PageIntro, Stat } from "@/components/PageIntro";
import { CopyAddress } from "@/components/CopyAddress";
import { getPoolYield } from "@/lib/data/reads";
import { getProgram, getPool, serverConnection, type PoolState } from "@/lib/solana/program";
import { POOL_PDA, PROGRAM_ID } from "@/lib/solana/constants";
import { fmtLamports, fmtPct, DASH } from "@/lib/fmt";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";
import { LendPanel } from "./LendPanel";

export const revalidate = 15;
export const metadata = { title: "Lend" };

async function readPool(): Promise<PoolState | null> {
  const conn = serverConnection();
  if (!conn || !PROGRAM_ID || !POOL_PDA) return null;
  try {
    return await getPool(getProgram(conn));
  } catch {
    return null;
  }
}

export default async function LendPage() {
  const [pool, yld] = await Promise.all([readPool(), getPoolYield(POOL_PDA?.toBase58() ?? null)]);
  const util = pool && pool.totalDeposits > 0n ? Number((pool.totalBorrowed * 10000n) / pool.totalDeposits) : null;
  const sharePrice = pool && pool.totalShares > 0n ? Number(pool.totalDeposits) / Number(pool.totalShares) : null;
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0", display: "grid", gap: 28 }}>
        <PageIntro title="Lend" kicker="Be the pawnbroker">
          Supply SOL to the pool and earn the origination fees on every ticket written against it. Loans are short and over-collateralised; exits happen inside the vault and the pool is made whole first. Every figure here is read from the pool account when the page loads.
        </PageIntro>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 22, alignItems: "start" }}>
          <article className="card" style={{ display: "grid", gap: 18 }}>
            <h2 style={{ margin: 0, fontSize: 22 }}>Pool state</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 16 }}>
              <Stat label="Deposits" value={fmtLamports(pool?.totalDeposits ?? null, 2)} />
              <Stat label="Borrowed" value={fmtLamports(pool?.totalBorrowed ?? null, 2)} />
              <Stat label="Utilisation" value={util === null ? DASH : fmtPct(util)} sub="borrowed / deposits" />
              <Stat label="Shares" value={pool ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(Number(pool.totalShares)) : DASH} sub={sharePrice ? `${sharePrice.toFixed(6)} SOL per share` : undefined} />
              <Stat label="Fees earned" value={fmtLamports(pool?.totalFeesEarned ?? null)} sub="lifetime, into the pool" />
              <Stat label="Loans issued" value={pool ? pool.totalLoansIssued.toString() : DASH} sub={pool ? `${pool.totalLiquidations.toString()} liquidations` : undefined} />
              <Stat label="Protocol share of fees" value={pool ? fmtPct(pool.protocolFeeBps) : DASH} sub="to the fee destination" />
              <Stat label="Keeper reward" value={pool ? fmtPct(pool.keeperRewardBps) : DASH} sub="from exit proceeds" />
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <Stat label="Realised yield" value={yld.apy ?? DASH} sub={yld.apy ? `fees over the last ${yld.windowDays} days, annualised against current deposits` : "needs at least one day of pool snapshots"} />
            </div>
            {pool ? (
              <div style={{ display: "grid", gap: 8 }}>
                <CopyAddress value={pool.address.toBase58()} label="Pool" size={11} />
                <CopyAddress value={pool.authority.toBase58()} label="Authority" size={11} />
                <CopyAddress value={pool.engineAuthority.toBase58()} label="Engine" size={11} />
                <CopyAddress value={pool.feeWallet.toBase58()} label="Fee destination" size={11} />
                {pool.paused && <span className="pill delisted">Paused</span>}
              </div>
            ) : (
              <span style={{ fontSize: 14, color: "var(--muted)" }}>{!PROGRAM_ID || !POOL_PDA ? "Program id or pool is not configured on this deployment." : "Pool account could not be read."}</span>
            )}
          </article>

          <div style={{ display: "grid", gap: 22 }}>
            <LendPanel />
            <article className="card" style={{ display: "grid", gap: 12, padding: 24 }}>
              <span className="lab">Fee per ticket, by tier</span>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 12 }}>
                {MEMECOIN_TIERS.map((t) => (
                  <div key={t.option}>
                    <b className="mono" style={{ fontSize: 22, color: "var(--accent)" }}>{pct(t.feeBps)}</b>
                    <div style={{ fontSize: 13, color: "var(--body)" }}>{t.durationDays} d · {pct(t.ltvBps)} LTV</div>
                  </div>
                ))}
              </div>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>Paid up front into the pool at origination; the protocol share goes to the fee destination. <Link href="/docs/risk">Read the risk page</Link> before depositing.</span>
            </article>
          </div>
        </div>
      </section>
      <Footer />
    </div>
  );
}
