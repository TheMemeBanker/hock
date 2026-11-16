import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DocShell, H2, Table } from "@/components/DocShell";
import { CopyAddress } from "@/components/CopyAddress";
import { CLUSTER, PROGRAM_ID, POOL_PDA } from "@/lib/solana/constants";

export const metadata = { title: "Security" };

function idlHash(): { sha256: string; address: string; version: string } {
  const file = path.join(process.cwd(), "lib", "idl", "hock_lending.json");
  const bytes = readFileSync(file);
  const idl = JSON.parse(bytes.toString("utf8")) as { address?: string; metadata?: { version?: string } };
  return { sha256: createHash("sha256").update(bytes).digest("hex"), address: idl.address ?? "", version: idl.metadata?.version ?? "" };
}

export default function Security() {
  const idl = idlHash();
  const build = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || process.env.NEXT_PUBLIC_BUILD_SHA || null;
  return (
    <DocShell title="Security" kicker="Identifiers first, then the model" current="/docs/security">
      <H2>Identifiers</H2>
      <div style={{ display: "grid", gap: 10 }}>
        <CopyAddress label={`Program id (${CLUSTER})`} value={PROGRAM_ID ? PROGRAM_ID.toBase58() : "not configured on this deployment"} />
        <CopyAddress label="Pool" value={POOL_PDA ? POOL_PDA.toBase58() : "not configured on this deployment"} />
        <CopyAddress label="IDL address" value={idl.address || "none in IDL"} />
        <CopyAddress label={`IDL sha256 (v${idl.version})`} value={idl.sha256} />
        <CopyAddress label="Build" value={build ?? "not stamped on this build"} />
      </div>
      <p style={{ fontSize: 15, color: "var(--muted)" }}>The IDL hash is computed from the IDL file shipped with this build when the page renders; it is never typed in. If the program id above differs from the IDL address, the deployment is pointing the site at a program the IDL was not built for.</p>
      <H2>Gates enforced on chain</H2>
      <Table head={["Gate", "Value"]} rows={[
        ["Price staleness", "120 s"],
        ["TWAP window / min samples / min history", "1800 s / 8 / 300 s"],
        ["Spot vs TWAP pump guard", "1500 bps"],
        ["Max per-update price factor", "100x"],
        ["Conversion min SOL out", "oracle floor: TWAP value minus 1500 bps, never lower"],
        ["Router allowlist", "Jupiter v6, Orca Whirlpool"],
        ["Token-2022", "allowed; PermanentDelegate and NonTransferable mints refused"],
        ["Borrower consent", "the engine cannot convert a healthy loan that the borrower has not armed"],
        ["Admin withdraw", "limited to accrued fees above share-backed deposits"],
      ]} />
      <H2>Threat model</H2>
      <Table head={["Actor", "Goal", "Controls"]} rows={[
        ["Borrower", "Over-borrow against an inflated or unsellable coin", "TWAP-capped price; pump guard; routability at loan size; 30% max LTV; short terms"],
        ["Launcher", "Launch, pump, borrow, dump", "Two consecutive gate passes above the $50k market-cap line with real volume and liquidity; holder concentration check; delisting; sliced in-vault conversion"],
        ["Outside trader", "Manipulate a thin pool at attestation time", "30-minute TWAP with minimum history; per-update factor cap; attestor refuses out-of-band prices; cross-sourced feeds with breaker"],
        ["Compromised engine key", "Drain vaults through conversions", "Oracle floor, router allowlist and slippage cap enforced by the program; engine cannot withdraw deposits or move collateral outside conversion and liquidation paths"],
        ["Compromised pool authority", "Change fee destination, pause, withdraw", "admin_withdraw limited to accrued fees; config changes emit events the site surfaces; authority on hardware"],
        ["RPC provider", "Serve stale state", "Failover across providers; slot-advance check before any fire; staleness window on chain"],
        ["Token-2022 extension abuse", "Transfer hooks, permanent delegate", "PermanentDelegate refused on chain; extension audit and transfer-hook refusal in the gate"],
        ["Impersonation", "Lookalike mints or addresses", "Mint registry from launches only; symbol impersonation check; addresses always shown in full with a copy control"],
        ["Phishing site", "Clone the UI", "Program id and IDL hash on this page; token address published on the site first; no custodial action to phish"],
        ["Operator error", "Wrong binary or config", "Reproducible build hash; config read from chain state; canaries fail loudly on mismatch"],
      ]} />
      <H2>Operational rules</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li>No mainnet deploy, pool seeding or live borrow without an audit of the shipped source and an explicit operator go.</li>
        <li>Every privileged key lives outside the repo, backed up, and is never one previously used by another product.</li>
        <li>Secrets are referenced by name only in docs and logs.</li>
        <li>A limit-close or liquidation never fires without the slot-advance check, the feed freshness check and a successful simulation of the exact transaction.</li>
        <li>Any public claim on the site about size, yield or safety is computed from chain state at render time.</li>
      </ul>
      <H2>Non-goals in version one</H2>
      <p>Protection against a complete collapse of Solana liquidity for a collateral coin inside the TWAP window. Mitigated by low LTV, short terms and slicing, not eliminated.</p>
    </DocShell>
  );
}
