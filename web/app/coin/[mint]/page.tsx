import Link from "next/link";
import { notFound } from "next/navigation";
import { PublicKey } from "@solana/web3.js";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { CopyAddress } from "@/components/CopyAddress";
import { Stat } from "@/components/PageIntro";
import { getCoin, ago } from "@/lib/data/reads";
import { getMarket } from "@/lib/data/market";
import { getProgram, getPriceFeed, serverConnection, type PriceFeedState } from "@/lib/solana/program";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";
import { fmtAge, fmtPriceLamports, fmtUsd, DASH } from "@/lib/fmt";
import { POOL_PDA, PROGRAM_ID } from "@/lib/solana/constants";
import { BorrowPanel } from "./BorrowPanel";

export const revalidate = 10;

export async function generateMetadata({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  const coin = await getCoin(mint);
  return { title: coin ? `${coin.name} ($${coin.symbol})` : "Coin" };
}

async function readFeed(mint: string): Promise<PriceFeedState | null> {
  const conn = serverConnection();
  if (!conn || !PROGRAM_ID || !POOL_PDA) return null;
  try {
    return await getPriceFeed(getProgram(conn), new PublicKey(mint));
  } catch {
    return null;
  }
}

export default async function CoinPage({ params }: { params: Promise<{ mint: string }> }) {
  const { mint } = await params;
  try {
    new PublicKey(mint);
  } catch {
    notFound();
  }
  const [coin, feed, market] = await Promise.all([getCoin(mint), readFeed(mint), getMarket(mint)]);
  if (!coin) notFound();
  const passes = coin.checks.filter((c) => c.ok).length;

  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0", display: "grid", gap: 28 }}>
        <div style={{ display: "flex", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
          {coin.imageUrl ? <img src={coin.imageUrl} alt="" width={72} height={72} style={{ borderRadius: 20, objectFit: "cover", border: "1px solid var(--line)" }} /> : <span style={{ width: 72, height: 72, borderRadius: 20, background: "var(--line)", display: "inline-block" }} />}
          <div style={{ display: "grid", gap: 6, minWidth: 0, flex: "1 1 320px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}>
              <h1 className="wm" style={{ margin: 0, fontSize: "clamp(36px,4.5vw,60px)", lineHeight: 1 }}>{coin.name}</h1>
              <span className="mono" style={{ fontSize: 22, color: "var(--muted)" }}>${coin.symbol}</span>
              <span className={`pill ${coin.verdictClass}`}>{coin.verdictLabel}</span>
            </div>
            <CopyAddress value={coin.mint} label="Mint" />
            <span style={{ fontSize: 14, color: "var(--muted)" }}>Launched {ago(new Date(coin.createdAt))} ago{coin.launchedHere ? " on HOCK" : " (imported)"} · {coin.decimals} decimals · {coin.tokenProgram === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL Token"}</span>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 22, alignItems: "start" }}>
          <article className="card" style={{ display: "grid", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
              <h2 style={{ margin: 0, fontSize: 22 }}>The gate</h2>
              <span style={{ fontSize: 14, color: "var(--muted)" }}>{passes} of 5 passing · {coin.consecutivePasses} consecutive full passes (2 needed)</span>
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 10 }}>
              {coin.checks.map((c) => (
                <li key={c.key} style={{ display: "flex", gap: 12, alignItems: "baseline", justifyContent: "space-between", borderBottom: "1px solid var(--line)", paddingBottom: 8 }}>
                  <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <i aria-hidden style={{ width: 10, height: 10, borderRadius: "50%", background: c.ok ? "var(--green)" : "var(--pink)", flexShrink: 0 }} />
                    <span>{c.label}</span>
                  </span>
                  <span className="mono" style={{ fontSize: 13, color: "var(--muted)" }}>{c.detail ?? DASH}</span>
                </li>
              ))}
            </ul>
            <p style={{ margin: 0, fontSize: 14, color: "var(--body)" }}>
              {coin.reason ? <><strong>Reason:</strong> {coin.reason}</> : coin.verdict === "collateral_ready" ? "All five checks passed twice in a row. Borrowing is open until any check fails." : "Graded continuously by the engine. Two consecutive full passes make this coin collateral."}
              {coin.gradedAt && <span style={{ color: "var(--muted)" }}> Last graded {ago(new Date(coin.gradedAt))} ago.</span>}
            </p>
          </article>

          <article className="card" style={{ display: "grid", gap: 18 }}>
            <h2 style={{ margin: 0, fontSize: 22 }}>On-chain price</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 16 }}>
              <Stat label="Attested spot" value={fmtPriceLamports(feed?.latest?.priceLamports ?? null)} sub="per whole token" />
              <Stat label="TWAP 30 min" value={fmtPriceLamports(feed?.twap?.price ?? null)} sub={feed?.twap ? `${feed.twap.samples} samples` : "insufficient history"} />
              <Stat label="Feed age" value={fmtAge(feed?.ageSeconds)} sub={feed ? (feed.fresh ? "within 120 s" : "stale") : "no feed"} />
              <Stat label="Samples" value={feed ? String(feed.count) : DASH} sub="of 32 ring slots" />
            </div>
            <p style={{ margin: 0, fontSize: 14, color: feed?.borrowable ? "var(--green-2)" : "var(--body)" }}>
              {feed ? feed.reason : !PROGRAM_ID || !POOL_PDA ? "Program id or pool is not configured on this deployment." : "No price feed has been initialised for this mint."}
            </p>
            {feed && <CopyAddress value={feed.address.toBase58()} label="Feed" size={11} />}
          </article>
        </div>

        <article className="card" style={{ display: "grid", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: 22 }}>Market</h2>
            <span style={{ fontSize: 14, color: "var(--muted)" }}>{market ? `${market.pairs} pool${market.pairs === 1 ? "" : "s"} · best on ${market.dex ?? "unknown dex"} · refreshed every 10 s` : "no pool found on this cluster"}</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 16 }}>
            <Stat label="Market cap" value={fmtUsd(market?.marketCapUsd)} sub="DexScreener" />
            <Stat label="Price" value={fmtUsd(market?.priceUsd)} sub={market?.priceSol ? `${market.priceSol.toPrecision(3)} SOL` : "per whole token"} />
            <Stat label="Liquidity" value={fmtUsd(market?.liquidityUsd)} sub="all pools" />
            <Stat label="24h volume" value={fmtUsd(market?.volume24hUsd)} sub={market?.change24hPct == null ? "all pools" : `${market.change24hPct >= 0 ? "+" : ""}${market.change24hPct.toFixed(1)}% 24h`} />
          </div>
          <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>
            Market figures are read live from the dex and shown for context only. Loans are sized from the attested on-chain price above, never from this card.
            {market?.pairUrl && <> <a href={market.pairUrl} target="_blank" rel="noopener noreferrer">Open the pair</a>.</>}
          </p>
        </article>

        <article className="card" style={{ display: "grid", gap: 14 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Tiers for this coin</h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
              <thead>
                <tr>{["Tier", "LTV", "Term", "Fee on principal"].map((h) => <th key={h} className="lab" style={{ textAlign: "left", padding: "10px 12px", borderBottom: "1px solid var(--line)" }}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {MEMECOIN_TIERS.map((t) => (
                  <tr key={t.option}>
                    <td style={{ padding: "12px" }}>{t.name}</td>
                    <td className="mono" style={{ padding: "12px" }}>{pct(t.ltvBps)}</td>
                    <td className="mono" style={{ padding: "12px" }}>{t.durationDays} days</td>
                    <td className="mono" style={{ padding: "12px" }}>{pct(t.feeBps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <span style={{ fontSize: 13, color: "var(--muted)" }}>Values mirror the program's tier table; the loan is sized from the lower of spot and TWAP at signing time. <Link href="/docs/fees">Fee details</Link>.</span>
        </article>

        {coin.verdict === "collateral_ready" ? (
          <BorrowPanel mint={coin.mint} symbol={coin.symbol} decimals={coin.decimals} />
        ) : (
          <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <span className={`pill ${coin.verdictClass}`}>{coin.verdictLabel}</span>
            <span style={{ color: "var(--body)" }}>{coin.verdict === "delisted" ? "This coin failed a gate check. No new loans; existing loans run to term." : "This coin is not collateral yet. Borrowing opens when the gate has passed twice in a row."}</span>
            <Link href="/board" style={{ marginLeft: "auto", fontWeight: 700 }}>Back to the board</Link>
          </div>
        )}
      </section>
      <Footer />
    </div>
  );
}
