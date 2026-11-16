/**
 * V4 — on-chain convert_collateral_slice executor.
 *
 * Replaces the V1/V2/V3 close-and-sell sequence (repay_loan + Jupiter
 * swap + fee skim, three txs) with a single atomic V4 instruction. The
 * loan stays ACTIVE — its SPL collateral is partially swapped to SOL
 * and parked in the per-loan sol_proceeds_vault. The borrower never
 * touches the funds until they repay (then they get back remaining SPL
 * + accumulated SOL) or get liquidated (same payout).
 *
 * Pattern B Jupiter integration: V4 is aggregator-agnostic. The engine
 * fetches a Jupiter quote + swap INSTRUCTION (not a full tx), unpacks
 * the swap ix into (programId, accounts, data), and passes the data
 * blob as an arg + the accounts (with the program prepended) as
 * remaining_accounts to convert_collateral_slice. V4 then invokes the
 * inner swap via raw `invoke` (no signer seeds — the engine signature
 * on the outer tx provides authority for the engine_collateral_account
 * source transfer).
 *
 * Atomicity guarantees the V4 program enforces in-program:
 *   - slice_bps × original collateral → SPL slice (u128 intermediate)
 *   - SPL slice transferred FROM vault TO engine_collateral_account
 *   - SOL delta on sol_proceeds_vault is the authoritative "received"
 *     measurement (we don't trust Jupiter's claimed output)
 *   - min_sol_out enforces slippage cap
 *   - 1% protocol fee skimmed to fee_wallet (same wSOL ATA V1/V2/V3 use)
 *   - loan.current_collateral_amount -= slice_amount
 *   - loan.sol_proceeds_amount += (received - fee)
 *   - loan.auto_sells_fired += 1
 *
 * Engine signer: ENGINE_AUTHORITY_V4 (hardcoded into the V4 program at
 * deploy time as `ENGINE_AUTHORITY` constant). Least privilege — this
 * key can ONLY call convert_collateral_slice. Cannot mint, withdraw
 * pool reserves, or touch fee wallet outside the in-program fee skim.
 *
 * Returns { signature, sliceAmountSold, solReceivedGross,
 *           solReceivedNet, protocolFee, remainingCollateral,
 *           totalSolProceeds, autoSellsFired }.
 *
 * Failure modes (caller handles):
 *   - Jupiter route stale → quote_age_check throws (preflight)
 *   - slippage exceeded → V4 ix throws SlippageExceeded
 *   - engine_collateral_account doesn't exist → preIx creates it
 *   - sol_proceeds_vault doesn't exist → V4 init_if_needed handles it
 *   - V4 program not deployed / env not set → executor throws early
 */
import {
  Connection,
  PublicKey,
  Keypair,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
// @coral-xyz/anchor is CJS; on Node 22+ strict-ESM, named imports fail
// at boot with `SyntaxError: Named export 'BN' not found`. Use the
// default-import-then-destructure pattern so we stay compatible across
// Node 20 / 22 / 24. Engine crashlooped on the host 2026-06-16 after the
// runner bumped to Node 22.22.3 — this is the root-cause fix.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import bs58 from "bs58";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { getIdl, fetchPool, poolPda as hockPoolPda, programId as hockProgramId } from "../chain/program.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

// Single program: PROGRAM_ID (required, no fallback) and src/tx/idl/hock_lending.json.
function getV4Idl() { return getIdl(); }
function getV41Idl() { return getIdl(); }
const PROGRAM_ID_STR = process.env.PROGRAM_ID || null;
const JUPITER_API = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
const JUPITER_AGGREGATOR_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4",
);

let _cachedEngineKp = null;
/**
 * Load the V4 engine authority keypair from env. The pubkey MUST match
 * the `ENGINE_AUTHORITY` constant baked into the deployed V4 program —
 * mismatch causes EngineUnauthorized on every call.
 *
 * Two env shapes supported (mirrors how the bot loads LENDER):
 *   ENGINE_AUTHORITY_PRIVATE_KEY  bs58 secret key (preferred for hosted deploys)
 *   ENGINE_AUTHORITY_KEYPAIR_PATH file path to a JSON byte array (local dev)
 */
function loadEngineKeypair() {
  if (_cachedEngineKp) return _cachedEngineKp;
  const b58 = process.env.ENGINE_AUTHORITY_PRIVATE_KEY;
  if (b58) {
    const decode = bs58.decode || (bs58.default && bs58.default.decode);
    _cachedEngineKp = Keypair.fromSecretKey(decode(b58));
    return _cachedEngineKp;
  }
  const path = process.env.ENGINE_AUTHORITY_KEYPAIR_PATH;
  if (path) {
    const resolved = path.startsWith("~/")
      ? path.replace(/^~/, process.env.HOME ?? "")
      : path;
    _cachedEngineKp = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(resolved.trim().startsWith("[") ? resolved : readFileSync(resolved, "utf8"))),
    );
    return _cachedEngineKp;
  }
  throw new Error(
    "V4 engine keypair not configured. Set ENGINE_AUTHORITY_PRIVATE_KEY (bs58) " +
    "or ENGINE_AUTHORITY_KEYPAIR_PATH (file).",
  );
}

function collateralVaultPda(loanPubkey, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("collateral-vault"), loanPubkey.toBuffer()],
    programId,
  );
}

function solProceedsVaultPda(loanPubkey, programId) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("sol-proceeds"), loanPubkey.toBuffer()],
    programId,
  );
}

async function getMintTokenProgram(connection, mintStr) {
  const info = await connection.getAccountInfo(new PublicKey(mintStr));
  if (!info) throw new Error(`mint ${mintStr.slice(0, 8)}… not found on-chain`);
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

/**
 * Fetch a Jupiter swap INSTRUCTION (not a full transaction) so we can
 * embed it inside the V4 CPI.
 *
 *   quote                — quote response from /quote
 *   userPublicKey        — engine pubkey (base58 string)
 *   destinationTokenAccount — the V4 sol_proceeds_vault pubkey (base58)
 *
 * Pattern B requires:
 *   - wrapAndUnwrapSol=false (we want wSOL into the vault, not native SOL)
 *   - destinationTokenAccount overrides Jupiter's default ATA derivation,
 *     so the swap output lands directly in sol_proceeds_vault. This works
 *     even when the vault doesn't exist YET at build-time — Jupiter just
 *     references it by pubkey; V4 init_if_needed creates it before the
 *     inner CPI runs.
 */
async function fetchJupiterSwapInstructions({
  quote,
  userPublicKey,
  destinationTokenAccount,
}) {
  const body = {
    quoteResponse: quote,
    userPublicKey,
    destinationTokenAccount,
    wrapAndUnwrapSol: false,
    dynamicSlippage: false,
    computeUnitPriceMicroLamports: 100_000,
  };
  const res = await fetch(`${JUPITER_API}/swap-instructions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`jupiter_swap_instructions_http_${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.swapInstruction) {
    throw new Error("jupiter_swap_instructions_missing_swapInstruction");
  }
  return {
    setupInstructions: Array.isArray(json.setupInstructions) ? json.setupInstructions : [],
    swapInstruction: json.swapInstruction,
    addressLookupTableAddresses: Array.isArray(json.addressLookupTableAddresses)
      ? json.addressLookupTableAddresses
      : [],
  };
}

/**
 * Fetch a Jupiter quote with optional excludeDexes filter. Used by the
 * multi-route retry in executeOnChainConvertSlice — when a route's
 * simulation fails, we retry with the route's DEXes excluded.
 */
async function fetchJupiterQuoteExcluding({
  inputMint,
  outputMint,
  amount,
  slippageBps,
  excludeDexes,
}) {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
  });
  if (excludeDexes && excludeDexes.length > 0) {
    params.set("excludeDexes", excludeDexes.join(","));
  }
  const res = await fetch(`${JUPITER_API}/quote?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`jupiter_quote_retry_http_${res.status}`);
  }
  const json = await res.json();
  if (!json?.outAmount) {
    throw new Error("jupiter_quote_retry_no_outAmount");
  }
  return json;
}

/**
 * Resolve a Jupiter-provided list of ALT addresses into live
 * AddressLookupTableAccount objects so we can compile a v0 message.
 */
async function fetchAddressLookupTables(connection, altAddresses) {
  if (altAddresses.length === 0) return [];
  const tables = await Promise.all(
    altAddresses.map(async (addrStr) => {
      const res = await connection.getAddressLookupTable(new PublicKey(addrStr));
      if (!res.value) {
        throw new Error(`address_lookup_table_not_found: ${addrStr}`);
      }
      return res.value;
    }),
  );
  return tables;
}

/**
 * Decode a Jupiter swap-instructions entry back into a usable form.
 * Jupiter returns `accounts: [{ pubkey, isSigner, isWritable }]` with
 * pubkey as a base58 string and the booleans as JS booleans.
 */
function decodeJupiterIxAccounts(accounts) {
  return accounts.map((a) => ({
    pubkey: new PublicKey(a.pubkey),
    isSigner: !!a.isSigner,
    isWritable: !!a.isWritable,
  }));
}

/**
 * Build + send the V4 convert_collateral_slice tx.
 *
 *   connection      Solana Connection (bot's, not engine-internal — we
 *                   want the same RPC the rest of the engine uses so a
 *                   degraded RPC fails uniformly)
 *   loan            Row from the loans table — must have loan_pda,
 *                   collateral_mint, program_id (=== PROGRAM_ID)
 *   sliceBps        u16 in (0, 10_000] — basis points of ORIGINAL collateral
 *   jupiterQuote    Full quote response from /v6/quote (this caller has
 *                   already filtered by route quality / cross-source
 *                   agreement / staleness — same gates V1/V2/V3 use)
 *
 * Returns receipt object with on-chain effects parsed from the event.
 */
export async function executeOnChainConvertSlice({
  connection,
  loan,
  sliceBps,
  jupiterQuote,
  /**
   * Finding #1 double-sell defense (2026-07-05): pre-broadcast CLAIM
   * hook. Invoked with (deterministicSignature, lastValidBlockHeight)
   * AFTER the tx is signed but BEFORE sendRawTransaction, so the DB has
   * a durable breadcrumb/claim stamped against the exact signature the
   * tx will carry (blockhash is fixed at sign time → the signature is
   * deterministic). The replay-protection stack — claimOrder's
   * `tx_signature_repay IS NULL` guard and watcher.recoverStuckFiring's
   * V4 carve-out (which only reconciles rows WHERE
   * `tx_signature_repay IS NOT NULL`) — depends on this claim existing
   * BEFORE the tx can land on-chain. If onPreSend throws, we ABORT the
   * broadcast (fail-closed): a state-mutating convert is never sent
   * without a durable claim. This is load-bearing, NOT swallowable.
   */
  onPreSend,
  /**
   * Optional post-send aid ONLY. Invoked with (signature) AFTER
   * sendRawTransaction. Errors are swallowed — this is a best-effort
   * convenience for callers that also want the sig post-broadcast. The
   * load-bearing replay claim is `onPreSend` above; do not rely on
   * `onSignature` for double-sell protection.
   */
  onSignature,
  /**
   * V4 Hardening T11 (2026-06-15 PM): when true, the function runs the
   * full build + simulate but returns BEFORE submitting the tx. Used by
   * the engine canary's synthetic V4 fire dry-run so we have empirical
   * "would a real fire succeed right now?" evidence at canary cadence.
   * Returns { dryRun: true, simulation: { err, logs, unitsConsumed } }
   * instead of the on-chain receipt.
   */
  dryRun = false,
  minSolOutFloor = null,
}) {
  // T9 (2026-06-16): per-fire forensic telemetry collected through the
  // function so execution.js can persist it to v4_fire_receipts after
  // the post-fire bookkeeping UPDATE. Optional fields stay null until
  // the relevant code path populates them.
  const _telemetry = {
    fire_started_at_ms: Date.now(),
    broadcast_at_ms: null,
    preflight_sim_cu: null,
    jupiter_dexes_used: [],
    jupiter_quoted_out_lamports: null,
    jupiter_min_out_lamports: null,
  };

  if (!PROGRAM_ID_STR) {
    throw new Error("executeOnChainConvertSlice: PROGRAM_ID env not set");
  }
  // Version-aware: the loan's own program_id decides V4 vs V4.1. Any
  // other id is refused exactly as before.
  const isV41 = true; // the HOCK program always carries the pool + price_history accounts
  if (loan.program_id && loan.program_id !== PROGRAM_ID_STR) {
    throw new Error(`executeOnChainConvertSlice: loan.program_id ${String(loan.program_id).slice(0, 8)} is not PROGRAM_ID. Refusing.`);
  }
  if (!Number.isInteger(sliceBps) || sliceBps <= 0 || sliceBps > 10_000) {
    throw new Error(`executeOnChainConvertSlice: invalid sliceBps ${sliceBps} (expected 1..10000)`);
  }
  if (!jupiterQuote || !jupiterQuote.outAmount || !jupiterQuote.otherAmountThreshold) {
    throw new Error("executeOnChainConvertSlice: malformed jupiterQuote — missing outAmount/otherAmountThreshold");
  }

  const programId = hockProgramId();
  const poolState = await fetchPool(connection);
  const poolPk = hockPoolPda();
  const engineKp = loadEngineKeypair();

  const collateralMintPk = new PublicKey(loan.collateral_mint);
  const loanPdaPk = new PublicKey(loan.loan_pda);

  const [collateralVault] = collateralVaultPda(loanPdaPk, programId);
  const [solProceedsVault] = solProceedsVaultPda(loanPdaPk, programId);

  const collateralTokenProgram = await getMintTokenProgram(connection, loan.collateral_mint);
  const loanTokenProgram = TOKEN_PROGRAM_ID; // wSOL is always classic Token

  const engineCollateralAta = getAssociatedTokenAddressSync(
    collateralMintPk,
    engineKp.publicKey,
    false,
    collateralTokenProgram,
  );
  // Fee wallet is pinned on chain (pool.fee_wallet); anything else is rejected by the program.
  const feeWalletWsolAta = new PublicKey(poolState.feeWallet.toBase58());
  if (!poolState.engineAuthority.equals(engineKp.publicKey)) {
    throw new Error(`executeOnChainConvertSlice: pool.engine_authority ${poolState.engineAuthority.toBase58().slice(0, 8)} != engine key ${engineKp.publicKey.toBase58().slice(0, 8)}`);
  }

  // ── Jupiter swap-instructions (Pattern B) ─────────────────────────
  // userPublicKey = engine pubkey (the swap's source authority).
  // destinationTokenAccount = sol_proceeds_vault — Jupiter trusts this
  // pubkey and uses it as the swap output; V4 init_if_needed creates
  // it inside the outer ix before the inner CPI runs.
  const { swapInstruction, addressLookupTableAddresses } = await fetchJupiterSwapInstructions({
    quote: jupiterQuote,
    userPublicKey: engineKp.publicKey.toBase58(),
    destinationTokenAccount: solProceedsVault.toBase58(),
  });

  // The swap-instruction's `accounts` array is what V4 forwards via
  // remaining_accounts (after we prepend the Jupiter program itself).
  const swapAccountsMeta = decodeJupiterIxAccounts(swapInstruction.accounts);
  const swapIxData = Buffer.from(swapInstruction.data, "base64");

  // Sanity check: swap program should be Jupiter aggregator. If Jupiter
  // ever changes program IDs we want to know IMMEDIATELY, not after a
  // weird inner CPI revert.
  const swapProgramPk = new PublicKey(swapInstruction.programId);
  if (!swapProgramPk.equals(JUPITER_AGGREGATOR_PROGRAM_ID)) {
    throw new Error(
      `executeOnChainConvertSlice: Jupiter returned unexpected program ${swapProgramPk.toBase58()}; ` +
      `expected ${JUPITER_AGGREGATOR_PROGRAM_ID.toBase58()}. Refusing.`,
    );
  }

  // ── minSolOut from Jupiter quote ──────────────────────────────────
  // Jupiter's `otherAmountThreshold` is the post-slippage minimum the
  // user is willing to accept. V4 enforces this on-chain; we pass it
  // through unchanged so the on-chain check matches the off-chain
  // expectation byte-for-byte.
  // min_sol_out = max(quote threshold, oracle floor supplied by the caller). The program
  // enforces the floor on chain; we never submit below it.
  let minSolOutBig = BigInt(jupiterQuote.otherAmountThreshold);
  if (minSolOutFloor != null && BigInt(minSolOutFloor) > minSolOutBig) minSolOutBig = BigInt(minSolOutFloor);
  const minSolOut = new BN(minSolOutBig.toString());

  // T9 forensic telemetry — capture Jupiter route metadata once the
  // quote is locked in. Used downstream by execution.js when writing
  // v4_fire_receipts after the post-fire UPDATE lands.
  _telemetry.jupiter_dexes_used = Array.from(new Set(
    (jupiterQuote.routePlan || [])
      .map((rp) => rp.swapInfo?.label)
      .filter(Boolean)
  ));
  _telemetry.jupiter_quoted_out_lamports = jupiterQuote.outAmount?.toString?.() || null;
  _telemetry.jupiter_min_out_lamports = jupiterQuote.otherAmountThreshold?.toString?.() || null;

  // ── Build the V4 ix via Anchor ────────────────────────────────────
  const wallet = new Wallet(engineKp);
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    skipPreflight: false,
  });
  const program = new Program(isV41 ? getV41Idl() : getV4Idl(), provider);

  // Anchor's accounts struct uses camelCase mapped to the IDL's
  // snake_case fields. The V4 IDL exposes these names.
  const baseAccounts = {
    loan: loanPdaPk,
    collateralMint: collateralMintPk,
    collateralVault,
    solProceedsVault,
    engineCollateralAccount: engineCollateralAta,
    feeWallet: feeWalletWsolAta,
    wsolMint: NATIVE_MINT,
    engine: engineKp.publicKey,
    tokenProgram: collateralTokenProgram,
    loanTokenProgram,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  };
  baseAccounts.pool = poolPk;
  baseAccounts.priceHistory = PublicKey.findProgramAddressSync(
    [Buffer.from("price_v3"), collateralMintPk.toBuffer(), poolPk.toBuffer()],
    programId,
  )[0];
  const v4Ix = await program.methods
    .convertCollateralSlice(sliceBps, minSolOut, swapIxData)
    .accountsStrict(baseAccounts)
    .remainingAccounts([
      // [0] swap program — V4 reads it positionally to dispatch the inner CPI
      { pubkey: swapProgramPk, isSigner: false, isWritable: false },
      // [1..] swap route accounts in Jupiter's order
      ...swapAccountsMeta,
    ])
    .instruction();

  // ── Preflight setup ix: ensure engine_collateral_account exists ───
  // V4 has a constraint that engine_collateral_account.owner == engine.
  // If the engine has never auto-sold this mint before, the ATA doesn't
  // exist. Create it idempotently — engine is the payer.
  //
  // We do NOT prepend Jupiter's setupInstructions blindly — they
  // typically include unrelated ATA creates (e.g., a wSOL ATA on the
  // engine wallet) that V4 doesn't need because the swap output goes
  // directly to sol_proceeds_vault, not engine's wSOL ATA. Keeping
  // them out keeps the ix surface minimal.
  const preIxs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      engineKp.publicKey,
      engineCollateralAta,
      engineKp.publicKey,
      collateralMintPk,
      collateralTokenProgram,
    ),
  ];

  // ── Compile to a v0 versioned tx so we can use Jupiter's ALTs ────
  const lookupTables = await fetchAddressLookupTables(connection, addressLookupTableAddresses);
  const latestBlockhash = await connection.getLatestBlockhash("confirmed");
  const recentBlockhash = latestBlockhash.blockhash;
  const lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;

  const message = new TransactionMessage({
    payerKey: engineKp.publicKey,
    recentBlockhash,
    instructions: [...preIxs, v4Ix],
  }).compileToV0Message(lookupTables);

  const tx = new VersionedTransaction(message);
  tx.sign([engineKp]);

  // ── Pre-fire simulation (V4 Hardening T8 + T12) ───────────────────
  // T8 (2026-06-15): never submit a doomed convert_collateral_slice tx
  // that would just revert. simulateTransaction is a pure read — no
  // broadcast, no fees, no side effects. If sim returns err, throw.
  //
  // T11 (2026-06-15): when dryRun=true, return the sim result instead
  // of submitting. Lets the canary exercise this exact code path.
  //
  // T12 (2026-06-16): when sim fails with a "missing program"-class
  // error, the caller can pass `retryWithDifferentRoute=true` so the
  // outer executeOnChainConvertSlice loop can retry with excludeDexes.
  // We return a structured result with `route_failure: true` so the
  // outer loop knows to try a different route.
  if (dryRun || process.env.PRE_FIRE_SIM_DISABLED !== "true") {
    let simResult = null;
    try {
      const sim = await connection.simulateTransaction(tx, {
        sigVerify: false,
        commitment: "confirmed",
        replaceRecentBlockhash: true,
      });
      simResult = sim.value;
      if (sim.value.err) {
        const errStr = JSON.stringify(sim.value.err);
        const logs = sim.value.logs || [];
        // T13 (2026-06-16): a sim failure where the inner Jupiter program
        // logs `failed: custom program error` means the route itself is
        // broken — wrong token-account shape, dead pool, etc. The right
        // recovery is to re-quote with the failing DEXes excluded, not
        // to keep retrying the same route. The caller (execution.js)
        // uses err.failed_dexes to assemble the excludeDexes param.
        const jupFailed = logs.some((l) =>
          /Program JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 failed/.test(l)
        );
        const isRouteFailure =
          jupFailed || /ProgramAccountNotFound|InvalidProgramId/i.test(errStr);
        const failedDexes = jupFailed
          ? Array.from(new Set(
              (jupiterQuote.routePlan || [])
                .map((rp) => rp.swapInfo?.label)
                .filter(Boolean)
            ))
          : [];
        if (dryRun) {
          return {
            dryRun: true,
            simulation: {
              err: sim.value.err,
              logs: logs.slice(-20),
              unitsConsumed: sim.value.unitsConsumed,
              route_failure: isRouteFailure,
              failed_dexes: failedDexes,
            },
          };
        }
        const lastLogs = logs.slice(-12).join(" | ");
        const baseErr = new Error(
          `pre-fire simulation failed: ${errStr}. ` +
          `Last logs: ${lastLogs.slice(0, 600)}`,
        );
        baseErr.route_failure = isRouteFailure;
        baseErr.failed_dexes = failedDexes;
        throw baseErr;
      }
      _telemetry.preflight_sim_cu = sim.value.unitsConsumed ?? null;
      console.log(`[convert-slice] ${dryRun ? "DRY-RUN " : ""}pre-fire sim OK (cu ${sim.value.unitsConsumed || "?"})`);
    } catch (simErr) {
      if (simErr.message?.startsWith("pre-fire simulation failed")) throw simErr;
      if (dryRun) {
        return {
          dryRun: true,
          simulation: { err: simErr.message?.slice(0, 200) || "sim_api_error" },
        };
      }
      console.warn(
        `[convert-slice] pre-fire simulation API failed (proceeding): ` +
        `${simErr.message?.slice(0, 120)}`,
      );
    }

    if (dryRun) {
      return {
        dryRun: true,
        simulation: {
          err: null,
          unitsConsumed: simResult?.unitsConsumed,
        },
      };
    }
  }

  // ── Pre-broadcast CLAIM (finding #1 double-sell defense) ──────────
  // The tx is already signed above, and its blockhash is fixed, so the
  // signature is deterministic — it equals what sendRawTransaction will
  // return. Stamp that signature as a durable CLAIM in the DB BEFORE we
  // broadcast, so a convert that lands on-chain but whose confirm throws
  // (RPC timeout) or is interrupted by an engine crash/redeploy leaves a
  // row with a NON-NULL breadcrumb that the replay-protection stack can
  // reconcile. FAIL-CLOSED: if the claim write throws, we ABORT — never
  // broadcast a state-mutating convert without a durable claim.
  if (typeof onPreSend === "function") {
    const encode = bs58.encode || (bs58.default && bs58.default.encode);
    const deterministicSig = encode(tx.signatures[0]);
    await onPreSend(deterministicSig, lastValidBlockHeight);
  }

  // ── Send + confirm ────────────────────────────────────────────────
  _telemetry.broadcast_at_ms = Date.now();
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  // Optional post-send aid only (onSignature): invoked AFTER broadcast.
  // Errors are swallowed because the load-bearing replay claim is the
  // pre-broadcast onPreSend above — this is a best-effort convenience,
  // NOT the double-sell protection.
  if (typeof onSignature === "function") {
    try {
      await onSignature(signature);
    } catch (hookErr) {
      console.warn(`[convert-slice] onSignature hook threw (non-fatal): ${hookErr.message?.slice(0, 100)}`);
    }
  }
  const conf = await connection.confirmTransaction(
    { signature, blockhash: recentBlockhash, lastValidBlockHeight: (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) {
    throw new Error(`convert_collateral_slice landed with err: ${JSON.stringify(conf.value.err)}`);
  }

  // ── Parse event for receipt ───────────────────────────────────────
  // The V4 ix emits CollateralConverted with all the per-call deltas.
  // Reading it back is cheaper + more authoritative than re-fetching
  // the loan account.
  const eventReceipt = await parseCollateralConvertedEvent(
    connection,
    program,
    signature,
  );

  return {
    signature,
    sliceBps,
    ...eventReceipt,
    // T9 forensic — caller (execution.js) persists into v4_fire_receipts
    // alongside the post-fire UPDATE so we have surgical observability
    // of every confirmed V4 fire from the first one onwards.
    telemetry: _telemetry,
  };
}

/**
 * Pull the CollateralConverted event off the confirmed tx and return
 * the parsed fields. If the event isn't present (shouldn't happen on
 * a successful convert) we throw — the caller should investigate.
 */
async function parseCollateralConvertedEvent(connection, program, signature) {
  const tx = await connection.getTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx || !tx.meta) {
    throw new Error(`convert_collateral_slice tx ${signature} not found in confirmed history`);
  }
  const logs = tx.meta.logMessages || [];
  // Anchor v0.30+ event parser.
  const parser = new (await import("@coral-xyz/anchor")).EventParser(
    program.programId,
    program.coder,
  );
  for (const ev of parser.parseLogs(logs)) {
    if (ev.name === "CollateralConverted" || ev.name === "collateralConverted") {
      return {
        sliceAmountSold: ev.data.sliceAmountSold?.toString?.() ?? null,
        solReceivedGross: ev.data.solReceivedGross?.toString?.() ?? null,
        protocolFee: ev.data.protocolFee?.toString?.() ?? null,
        solReceivedNet: ev.data.netSolToVault?.toString?.() ?? null,
        remainingCollateral: ev.data.remainingCollateral?.toString?.() ?? null,
        totalSolProceeds: ev.data.totalSolProceeds?.toString?.() ?? null,
        autoSellsFired: Number(ev.data.autoSellsFired ?? 0),
      };
    }
  }
  throw new Error(
    `convert_collateral_slice tx ${signature} confirmed but no CollateralConverted event found`,
  );
}

/**
 * Reconstruct a V4 fire receipt from a LANDED convert_collateral_slice tx
 * signature — used by the chunked-selling recovery path (execution.js
 * _processV4ChunkInner) to recover the on-chain deltas of a chunk whose
 * breadcrumb landed but whose post-fire bookkeeping was interrupted.
 *
 * Best-effort: the caller wraps this in `.catch(() => null)` and guards on the
 * result (proceeds default to 0, mirror update skipped on null). Reuses the same
 * CollateralConverted event parse as the live fire path, so the returned shape
 * is identical (solReceivedNet, remainingCollateral, totalSolProceeds, …). It is
 * read-only — builds the coder directly from the IDL, so it needs no signing
 * wallet. Only invoked when V4_CHUNKED_SELLING_ENABLED === "true" (off by
 * default); exported so execution.js's import resolves regardless of that flag.
 */
export async function recoverV4FireReceipt({ connection, signature }) {
  if (!connection || !signature) return null;
  const { BorshCoder } = await import("@coral-xyz/anchor");
  const programLike = {
    programId: hockProgramId(),
    coder: new BorshCoder(getV4Idl()),
  };
  const eventReceipt = await parseCollateralConvertedEvent(connection, programLike, signature);
  return { signature, ...eventReceipt };
}
