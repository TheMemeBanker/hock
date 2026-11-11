/**
 * Attestor loop: keeps every on-chain price feed fresh.
 *
 * For each mint in gate_state with verdict collateral_ready, plus any mint
 * with an open loan, it:
 *   1. computes a cross-sourced price in lamports per WHOLE token
 *      (Jupiter price API primary, Jupiter quote fallback, DexScreener via the
 *      breaker-wired cache, Pyth when a feed id exists),
 *   2. rejects the sample when the agreeing sources diverge beyond
 *      ATTESTOR_MAX_DIVERGENCE_PCT (default 5),
 *   3. checks the program's per-update bound client-side (new within
 *      [prev/100, prev*100]); a violation is logged and alerted, not sent,
 *   4. submits update_price when the feed is older than
 *      FEED_TARGET_INTERVAL_SECONDS (keeps feeds inside the 120 s window),
 *   5. writes an attestations row per attempt.
 *
 * Signer: the program binds update_price to the POOL authority
 * (UpdatePrice has `pool.has_one = authority` and `price_feed.authority ==
 * authority`). The engine therefore signs with POOL_AUTHORITY_KEYPAIR_PATH
 * when configured; otherwise it tries ENGINE_AUTHORITY_KEYPAIR_PATH and, when
 * that key is not pool.authority, records the attempt as rejected and raises
 * one admin alert instead of spamming the chain.
 *
 * initialize_price_feed is sent for promoted mints without a feed, only when
 * the pool authority key is configured; otherwise an admin outbox item says
 * the feed needs initialising.
 */
import { PublicKey, Transaction } from "@solana/web3.js";
import { query } from "../db/pool.js";
import { notifyAdmin } from "../notify/admin.js";
import { heartbeat, registerLoop, setGauge } from "../health/liveness.js";
import { requestUsdPrice, SOL_MINT } from "../price/jupiter-price-client.js";
import { jupiterQuote } from "../price/pricing.js";
import { cachedJson } from "../price/http-cache.js";
import { hasPythCoverage, pythPriceInSol } from "../price/pyth-price.js";
import { sendWithPriorityAndConfirm } from "../tx/tx-send.js";
import {
  connection,
  engineKeypair,
  fetchPool,
  loadKeypair,
  poolPda,
  priceFeedPda,
  programFor,
  readPriceFeed,
  withinUpdateFactor,
  MAX_SPOT_VS_TWAP_PUMP_BPS,
} from "../chain/program.js";
import { getMintDecimals } from "../watcher/slicing.js";
import { syntheticMarket, syntheticTickPrice } from "../synthetic/synthetic.js";

const TARGET_INTERVAL_S = Number(process.env.FEED_TARGET_INTERVAL_SECONDS) || 45;
const MAX_DIVERGENCE = (Number(process.env.ATTESTOR_MAX_DIVERGENCE_PCT) || 5) / 100;
const MIN_SOURCES = Number(process.env.ATTESTOR_MIN_SOURCES) || 2;
const DEXSCREENER_URL = process.env.DEXSCREENER_URL || "https://api.dexscreener.com";
const LOOP_MS = Math.max(5_000, Math.min(15_000, Math.floor((TARGET_INTERVAL_S * 1000) / 3)));

let _signer = null;
let _signerRole = null;
let _timer = null;
let _running = false;
const _lastAlert = new Map();

function attestorSigner() {
  if (_signer) return _signer;
  const pa = loadKeypair("POOL_AUTHORITY_KEYPAIR_PATH", { optional: true });
  if (pa) { _signer = pa; _signerRole = "pool_authority"; return _signer; }
  _signer = engineKeypair();
  _signerRole = "engine_authority";
  return _signer;
}

// ---- price sources (all return lamports per WHOLE token as a Number) --------
async function srcJupiterPrice(mint) {
  const [usd, solUsd] = await Promise.all([requestUsdPrice(mint), requestUsdPrice(SOL_MINT)]);
  if (!(usd > 0) || !(solUsd > 0)) throw new Error("jupiter_price_invalid");
  return (usd / solUsd) * 1e9;
}
async function srcJupiterQuote(mint, decimals) {
  const whole = 10n ** BigInt(decimals);
  const q = await jupiterQuote({ inputMint: mint, outputMint: SOL_MINT, amountRaw: whole.toString(), slippageBps: 100 });
  return Number(q.outAmountLamports);
}
async function srcDexScreener(mint) {
  const data = await cachedJson(`${DEXSCREENER_URL}/tokens/v1/solana/${mint}`, { ttlMs: 10_000 });
  const pairs = Array.isArray(data) ? data : [];
  let best = null;
  for (const p of pairs) {
    if (p?.baseToken?.address !== mint || p?.quoteToken?.address !== SOL_MINT) continue;
    const liq = Number(p?.liquidity?.usd ?? 0);
    const native = parseFloat(p?.priceNative ?? 0);
    if (native > 0 && (!best || liq > best.liq)) best = { native, liq };
  }
  if (!best) throw new Error("dexscreener_no_sol_pair");
  return best.native * 1e9;
}
async function srcPyth(mint) {
  if (!hasPythCoverage(mint)) throw new Error("no_pyth_feed");
  return (await pythPriceInSol(mint)) * 1e9;
}

export async function crossSourcedPriceLamports(mint, decimals) {
  // Devnet/localnet: one synthetic source replaces the cross-sourcing (refused on mainnet at boot and on use).
  const synth = await syntheticMarket(mint);
  if (synth) {
    const price = await syntheticTickPrice(synth);
    return { ok: true, price, agreed: ["synthetic"], sources: [{ name: "synthetic", price: Number(price), error: null }] };
  }
  const attempts = await Promise.allSettled([
    srcJupiterPrice(mint),
    srcJupiterQuote(mint, decimals),
    srcDexScreener(mint),
    srcPyth(mint),
  ]);
  const names = ["jupiter_price", "jupiter_quote", "dexscreener", "pyth"];
  const sources = attempts.map((r, i) => ({
    name: names[i],
    price: r.status === "fulfilled" && Number.isFinite(r.value) && r.value > 0 ? r.value : null,
    error: r.status === "rejected" ? String(r.reason?.message || r.reason).slice(0, 80) : null,
  }));
  const valid = sources.filter((s) => s.price != null);
  if (valid.length < MIN_SOURCES) {
    return { ok: false, reason: `only_${valid.length}_sources`, sources };
  }
  // Largest subset of sources that agree with the median within the band.
  const sorted = [...valid].sort((a, b) => a.price - b.price);
  const median = sorted[Math.floor(sorted.length / 2)].price;
  const agreeing = valid.filter((s) => Math.abs(s.price - median) / median <= MAX_DIVERGENCE);
  if (agreeing.length < MIN_SOURCES) {
    return { ok: false, reason: "sources_disagree", sources, median };
  }
  const price = agreeing.reduce((a, s) => a + s.price, 0) / agreeing.length;
  return { ok: true, price: BigInt(Math.round(price)), agreed: agreeing.map((s) => s.name), sources };
}

// ---- chain writes ---------------------------------------------------------------
async function sendUpdatePrice(mint, priceLamports) {
  const signer = attestorSigner();
  const program = programFor(signer);
  const ix = await program.methods
    .updatePrice(new (await import("@coral-xyz/anchor")).default.BN(priceLamports.toString()), 0)
    .accountsStrict({ pool: poolPda(), priceFeed: priceFeedPda(mint), authority: signer.publicKey })
    .instruction();
  const tx = new Transaction().add(ix);
  return sendWithPriorityAndConfirm(tx, [signer], { connection: connection(), cuLimit: 60_000, label: `update_price ${mint.slice(0, 6)}` });
}

async function sendInitializePriceFeed(mint) {
  const pa = loadKeypair("POOL_AUTHORITY_KEYPAIR_PATH", { optional: true });
  if (!pa) return null;
  const program = programFor(pa);
  const ix = await program.methods
    .initializePriceFeed()
    .accountsStrict({
      pool: poolPda(),
      mint: new PublicKey(mint),
      priceFeed: priceFeedPda(mint),
      authority: pa.publicKey,
      systemProgram: new PublicKey("11111111111111111111111111111111"),
    })
    .instruction();
  const tx = new Transaction().add(ix);
  return sendWithPriorityAndConfirm(tx, [pa], { connection: connection(), cuLimit: 80_000, label: `init_feed ${mint.slice(0, 6)}` });
}

async function recordAttestation({ mint, price, sourceMix, sig, accepted, error }) {
  await query(
    `INSERT INTO attestations (mint, price_lamports, source_mix, tx_sig, accepted, error) VALUES ($1,$2,$3::jsonb,$4,$5,$6)`,
    [mint, (price ?? 0n).toString(), JSON.stringify(sourceMix || {}), sig || null, accepted, error ? String(error).slice(0, 500) : null],
  ).catch((e) => console.warn(`[attestor] attestations insert failed: ${e.message}`));
}

async function alertOnce(key, kind, payload, windowMs = 10 * 60_000) {
  const now = Date.now();
  if (now - (_lastAlert.get(key) || 0) < windowMs) return;
  _lastAlert.set(key, now);
  await notifyAdmin({ kind, key, payload, throttleMs: 0 });
}

export async function targetMints() {
  const { rows } = await query(
    `SELECT mint FROM gate_state WHERE verdict = 'collateral_ready'
     UNION SELECT mint FROM loans WHERE status = 'open'
     UNION SELECT mint FROM mints WHERE mint = $1 AND $1 <> ''`,
    [process.env.CANARY_MINT || ""],
  );
  return rows.map((r) => r.mint);
}

export async function attestMint(mint, { force = false } = {}) {
  const conn = connection();
  const feed = await readPriceFeed(conn, mint); // chain clock, see program.js chainNow

  if (!feed) {
    const sig = await sendInitializePriceFeed(mint).catch((e) => { throw new Error(`initialize_price_feed failed: ${e.message}`); });
    if (!sig) {
      await alertOnce(`feed_init:${mint}`, "price_feed_needs_init", {
        mint,
        text: `No price feed for ${mint}. initialize_price_feed must be sent by the pool authority (configure POOL_AUTHORITY_KEYPAIR_PATH or run it by hand).`,
      }, 60 * 60_000);
      setGauge(`feed_age_seconds.${mint}`, null);
      return { mint, skipped: "feed_missing" };
    }
    console.log(`[attestor] initialised price feed for ${mint.slice(0, 8)}: ${sig}`);
  }

  if (!force && feed?.ageSeconds != null && feed.ageSeconds < TARGET_INTERVAL_S) {
    setGauge(`feed_age_seconds.${mint}`, feed.ageSeconds);
    return { mint, skipped: "fresh", ageSeconds: feed.ageSeconds };
  }

  const decimals = await getMintDecimals(conn, mint);
  const px = await crossSourcedPriceLamports(mint, decimals);
  const sourceMix = { sources: px.sources, agreed: px.agreed || null, signer_role: _signerRole || null };
  if (!px.ok) {
    await recordAttestation({ mint, price: 0n, sourceMix, accepted: false, error: px.reason });
    await alertOnce(`px:${mint}:${px.reason}`, "attestor_price_rejected", { mint, reason: px.reason, sources: px.sources });
    return { mint, rejected: px.reason };
  }

  const prev = feed?.latest?.price ?? 0n;
  if (!withinUpdateFactor(prev, px.price)) {
    const err = `price_change_exceeds_bound prev=${prev} new=${px.price}`;
    await recordAttestation({ mint, price: px.price, sourceMix, accepted: false, error: err });
    await alertOnce(`bound:${mint}`, "attestor_update_out_of_bound", { mint, prev: prev.toString(), next: px.price.toString(), text: "Chain would reject this update (MAX_PRICE_UPDATE_FACTOR). Not submitted; verify the sources before walking the feed." });
    return { mint, rejected: "out_of_bound" };
  }
  if (feed?.twap && px.price * 10_000n > feed.twap * (10_000n + MAX_SPOT_VS_TWAP_PUMP_BPS)) {
    await alertOnce(`pump:${mint}`, "attestor_pump_guard", { mint, twap: feed.twap.toString(), spot: px.price.toString(), text: "Spot exceeds TWAP by more than the borrow pump guard; borrows against this mint will be refused by the program until it settles. Feed still updated so floors stay honest." });
  }

  // Signer check: update_price must be signed by pool.authority.
  const pool = await fetchPool(conn);
  const signer = attestorSigner();
  if (!pool.authority.equals(signer.publicKey)) {
    const err = `signer_not_pool_authority (${_signerRole} ${signer.publicKey.toBase58().slice(0, 8)} != pool.authority ${pool.authority.toBase58().slice(0, 8)})`;
    await recordAttestation({ mint, price: px.price, sourceMix, accepted: false, error: err });
    await alertOnce("signer", "attestor_signer_mismatch", { text: `update_price requires the pool authority signature; ${err}. Set POOL_AUTHORITY_KEYPAIR_PATH or change the program.` }, 30 * 60_000);
    return { mint, rejected: "signer_mismatch" };
  }

  try {
    const sig = await sendUpdatePrice(mint, px.price);
    await recordAttestation({ mint, price: px.price, sourceMix, sig, accepted: true });
    setGauge(`feed_age_seconds.${mint}`, 0);
    console.log(`[attestor] ${mint.slice(0, 8)} ${px.price} lamports/whole via ${px.agreed.join("+")} sig=${String(sig).slice(0, 12)}`);
    return { mint, sig, price: px.price };
  } catch (err) {
    await recordAttestation({ mint, price: px.price, sourceMix, accepted: false, error: err.message });
    await alertOnce(`send:${mint}`, "attestor_send_failed", { mint, error: err.message?.slice(0, 200) });
    return { mint, error: err.message };
  }
}

export async function runOnce() {
  const mints = await targetMints();
  let sent = 0, skipped = 0, rejected = 0, failed = 0;
  for (const mint of mints) {
    try {
      const r = await attestMint(mint);
      if (r.sig) sent++; else if (r.skipped) skipped++; else if (r.rejected) rejected++; else failed++;
    } catch (err) {
      failed++;
      console.warn(`[attestor] ${mint.slice(0, 8)}: ${err.message?.slice(0, 160)}`);
    }
  }
  // Staleness gauge for every target mint, even those we skipped.
  const conn = connection();
  for (const mint of mints) {
    const f = await readPriceFeed(conn, mint).catch(() => null);
    setGauge(`feed_age_seconds.${mint}`, f?.ageSeconds ?? null);
  }
  heartbeat("attestor", failed && !sent ? "error" : "ok", { mints: mints.length, sent, skipped, rejected, failed });
}

export function startAttestor() {
  registerLoop("attestor", { intervalMs: LOOP_MS });
  const tick = async () => {
    if (_running) return;
    _running = true;
    try { await runOnce(); }
    catch (err) { heartbeat("attestor", "error", { error: err.message?.slice(0, 200) }); console.error(`[attestor] tick failed: ${err.message}`); }
    finally { _running = false; }
  };
  setTimeout(tick, 1_000 + Math.random() * 3_000);
  _timer = setInterval(tick, LOOP_MS);
  console.log(`[attestor] started; target feed interval ${TARGET_INTERVAL_S}s, loop ${LOOP_MS}ms, signer role resolved lazily`);
}

export function stopAttestor() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
