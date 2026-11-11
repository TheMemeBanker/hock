/**
 * GET /api/loans?wallet=<pubkey>
 * The RPC proxy refuses getProgramAccounts, so the memcmp scan for a wallet's
 * loans runs here against the server-side RPC and returns decoded accounts.
 */
import { NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { getLoansForWallet, getProgram, serverConnection } from "@/lib/solana/program";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const w = url.searchParams.get("wallet") || "";
  let wallet: PublicKey;
  try {
    wallet = new PublicKey(w);
  } catch {
    return NextResponse.json({ error: "wallet must be a base58 public key" }, { status: 400 });
  }
  const conn = serverConnection();
  if (!conn) return NextResponse.json({ error: "SOLANA_RPC_URL is not configured" }, { status: 503 });
  try {
    const loans = await getLoansForWallet(getProgram(conn), wallet);
    return NextResponse.json(
      {
        loans: loans.map((l) => ({
          address: l.address.toBase58(),
          loanId: l.loanId.toString(),
          borrower: l.borrower.toBase58(),
          pool: l.pool.toBase58(),
          collateralMint: l.collateralMint.toBase58(),
          collateralVault: l.collateralVault.toBase58(),
          collateralAmount: l.collateralAmount.toString(),
          currentCollateralAmount: l.currentCollateralAmount.toString(),
          loanAmount: l.loanAmount.toString(),
          repayAmount: l.repayAmount.toString(),
          transactionFee: l.transactionFee.toString(),
          ltvBps: l.ltvBps,
          durationDays: l.durationDays,
          startTimestamp: l.startTimestamp,
          dueTimestamp: l.dueTimestamp,
          status: l.status,
          collateralValueAtStart: l.collateralValueAtStart.toString(),
          category: l.category,
          solProceedsAmount: l.solProceedsAmount.toString(),
          autoSellsFired: l.autoSellsFired,
          accruedPoolFees: l.accruedPoolFees.toString(),
          armedTriggerPrice: l.armedTriggerPrice.toString(),
          armedTriggerDirection: l.armedTriggerDirection,
          armedMaxSliceBps: l.armedMaxSliceBps,
          armedTotalBps: l.armedTotalBps,
          armedConvertedBps: l.armedConvertedBps,
        })),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "read failed" }, { status: 502 });
  }
}
