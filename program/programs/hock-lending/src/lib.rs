use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};
// Token-2022 support for collateral side. wSOL (loan token) stays on legacy Token.
use anchor_spl::token_interface::{
    self,
    Mint as MintIfc,
    TokenAccount as TokenAccountIfc,
    TokenInterface,
    TransferChecked,
};

// HOCK lending program.
//
// Collateralised wSOL lending with in-vault auto-sell conversion. The Loan
// account tracks current_collateral_amount (SPL tokens still in the vault,
// decreasing as auto-sells fire) and sol_proceeds_amount (wSOL accumulated
// from those sells, held in the vault until the loan closes). The
// convert_collateral_slice instruction lets the pool-configured engine
// authority swap a slice via an allow-listed router CPI and deposit the
// proceeds back into the vault — the loan stays ACTIVE, principal owed is
// unchanged, due date unchanged. repay_loan + liquidate_loan return a mix.
//
// Authority model (HOCK): the engine authority and the protocol fee wallet
// are NOT compile-time constants. They live on the LendingPool account, are
// set by the pool authority in `initialize_pool`, and may be rotated by the
// pool authority through `set_pool_config` (emits PoolConfigUpdated). Every
// instruction that names the engine or the fee destination constrains the
// passed account against the pool field. Least privilege still holds: the
// engine key can ONLY trigger conversions on existing loans (inside the
// oracle floor + allowlist + slippage gates), never mint new loans, never
// move pool reserves, never redirect the fee.
//
// THIS ID IS LOAD-BEARING. It must equal the program this binary is deployed
// to, or Anchor rejects every instruction against it. It is the dedicated
// HOCK program keypair (kept outside the repository). Never point this at a
// deployed program you do not intend to overwrite.
declare_id!("Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb");

/// Basis-point helpers
const BPS_DENOM: u64 = 10_000;

// ---------------------------------------------------------------------------
// Tier ladders — THESE CONSTANTS ARE THE CONTRACT.
//
// 2026-06-13 LESSON (paid for in user trust): the prior `rwa_loan_tiers`
// DB display table advertised 50/60/70% RWA LTVs while the on-chain v2
// program computed 30/25/20%. Users signed expecting one amount and got
// another. The cure is to make THIS file the single, authoritative source
// of tier params, and have every off-chain surface (DB, dashboard, bot,
// bot, marketplace) DERIVE from on-chain rather than store its own copy.
//
// v3 ships dual tiers — memecoin and RWA — selected at borrow time via
// the `category` instruction param. The off-chain `rwa_loan_tiers` table
// in the bot's DB is now a downstream mirror that the migration runner
// updates from on-chain at startup, never the other way around.
// ---------------------------------------------------------------------------

const CATEGORY_MEMECOIN: u8 = 0;
const CATEGORY_RWA: u8 = 1;

// Engine authority and protocol fee wallet.
//
// Both are per-pool state (`LendingPool.engine_authority`,
// `LendingPool.fee_wallet`) rather than constants. The engine authority is
// the ONLY pubkey allowed to call convert_collateral_slice; it is online
// (signs every limit-close fire) and must have least privilege: it can ONLY
// trigger conversions on EXISTING loans, never mint, never withdraw from the
// pool, never touch the fee wallet. NEVER reuse the pool authority here.
//
// The fee wallet is the wSOL token account that receives the 1% protocol fee
// skimmed on every auto-sell + every extend_loan. Every account that names
// the fee destination carries `address = pool.fee_wallet`; without that
// constraint the engine signer (convert_collateral_slice) or any borrower
// (extend_loan / request_loan) could pass an arbitrary TokenAccount as the
// fee destination and pocket the protocol's 1%.

// [I-01 · Sec3] Canonical Wrapped SOL mint. v4 uses wSOL as the loan token and
// as the asset stored in the auto-sell proceeds vault. Every loan_token_mint /
// wsol_mint account is constrained to this address so a pool or proceeds vault
// can never be initialized or used with an unintended mint.
const WSOL_MINT: Pubkey =
    anchor_lang::pubkey!("So11111111111111111111111111111111111111112");

// Protocol fee in basis points (bps) on auto-sell proceeds. 1% — matches
// v1/v2/v3 limit-close fee accrued through limit-close-fee-accrual-watcher.
const PROTOCOL_FEE_BPS_AUTOSELL: u64 = 100;

// Hard cap on slice_bps per call. 10000 = 100%. Sum across multiple calls
// is checked against original_collateral_amount on each invocation.
const SLICE_BPS_MAX: u16 = 10_000;

// ── V4.1 ANTI-DRAIN CONSTANTS (2026-06-16 PM) ──────────────────────
// The V4 audit (2026-06-16) identified that a compromised engine
// keypair could submit convert_collateral_slice with min_sol_out=0 +
// an attacker-chosen swap program, draining loan collateral.
// V4.1 closes this with three on-chain gates:
//
//   1. Oracle floor: program reads the loan's price_history PDA and
//      computes a minimum acceptable SOL output. Caller-supplied
//      min_sol_out must be >= this floor. Even a malicious engine
//      cannot drain because the program rejects below-floor swaps.
//
//   2. Swap program allowlist: only programs in ALLOWED_SWAP_PROGRAMS
//      can be passed as remaining_accounts[0]. Closes the malicious-
//      router substitution vector.
//
//   3. Oracle staleness gate: oracle sample must be < MAX_ORACLE_AGE
//      seconds old. Prevents a stale oracle from lowering the floor.
//
// The ceiling 1500 bps (15%) is the most permissive protocol-side cap.
// The user's own `slippage_bps` on the order can be tighter; the
// program enforces the LESS PERMISSIVE of the two (so a user can
// pin tighter than 15%, but never looser).

// Maximum protocol slippage from oracle, in basis points. 15% = 1500.
const MAX_PROTOCOL_SLIPPAGE_BPS: u64 = 1_500;

// Maximum age of an oracle sample at fire time. 120s = 2min.
// Engine pre-pushes a fresh sample before each fire, so a clean
// feed updater keeps samples ≤ 30s old. This 2min ceiling is the slack.
const MAX_ORACLE_AGE_SECONDS: i64 = 120;

// [M-04 · Sec3] Per-update price-change sanity factor. Each update_price may
// move the price by at most this multiple in EITHER direction relative to the
// previous sample (i.e. new ∈ [prev / FACTOR, prev * FACTOR]). This is a
// GENEROUS fat-finger / unit-error guard (e.g. a 6- vs 9-decimal mistake, or a
// stray zero), NOT a tight leash: a legitimate fast memecoin move is never
// blocked, and a genuinely huge move can still be walked over a couple of the
// frequent samples. The pool authority remains a TRUSTED price input by design
// (operator-run, cross-sourced off-chain); this bound only limits the blast
// radius of a single grossly-wrong update, it does not replace that trust.
const MAX_PRICE_UPDATE_FACTOR: u64 = 100;

// Allowed swap program IDs for convert_collateral_slice. Only these
// programs can be passed as remaining_accounts[0]. Any other program
// substitution is rejected pre-CPI by the on-chain gate.
//   - Jupiter Aggregator v6 (primary)
//   - Orca Whirlpool v2 (direct, for fallback when Jupiter is degraded)
const JUPITER_V6_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");
const ORCA_WHIRLPOOL_PROGRAM_ID: Pubkey =
    anchor_lang::pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");

#[inline(always)]
fn is_allowed_swap_program(p: &Pubkey) -> bool {
    *p == JUPITER_V6_PROGRAM_ID || *p == ORCA_WHIRLPOOL_PROGRAM_ID
}

/// [H-02 · Sec3] Has a borrower-armed auto-sell trigger been reached at the
/// given spot price? Take-profit (direction 0) fires when the price RISES to
/// >= the armed price (so it captures an upside spike); stop-loss (direction
/// 1) fires when the price FALLS to <= the armed price. A disarmed loan
/// (armed_price == 0) or an unknown direction never fires. Pure fn so the
/// gate logic is unit-tested directly (see conversion_gate_tests).
#[inline(always)]
fn armed_price_reached(armed_price: u64, direction: u8, spot: u128) -> bool {
    if armed_price == 0 {
        return false;
    }
    let armed = armed_price as u128;
    match direction {
        0 => spot >= armed, // take-profit
        1 => spot <= armed, // stop-loss
        _ => false,
    }
}

/// [Q-04 · Sec3] May the engine convert this slice right now?
///
/// The single source of truth for conversion authorization, used by
/// `convert_collateral_slice` AND by the unit tests — a test that re-implements
/// this arithmetic can pass while the program does something else, which is
/// exactly the bug class we're trying to avoid on a funds-moving path.
///
/// TWO caps, deliberately distinct (see `Loan::armed_total_bps`):
///   `max_slice_bps` bounds a SINGLE fire · `total_bps` bounds ALL fires.
/// Collapsing them would cap a laddered exit at its largest leg.
#[inline(always)]
#[allow(clippy::too_many_arguments)]
fn conversion_authorized(
    overdue: bool,
    armed_price: u64,
    direction: u8,
    spot: u128,
    slice_bps: u16,
    max_slice_bps: u16,
    total_bps: u16,
    converted_bps: u16,
) -> bool {
    if overdue {
        return true;
    }
    let cumulative = (converted_bps as u32) + (slice_bps as u32);
    armed_price_reached(armed_price, direction, spot)
        && slice_bps <= max_slice_bps
        && cumulative <= total_bps as u32
}

/// [H-02 · Sec3, 2nd review] May the borrower arm or disarm a trigger?
///
/// Only while the loan is not yet overdue. Past `due_timestamp`,
/// `convert_collateral_slice` authorizes on `overdue` alone, so configuring the
/// trigger would succeed while restricting nothing — a silent no-op that emits
/// an event implying protection the borrower does not have.
#[inline(always)]
fn trigger_config_allowed(now_ts: i64, due_timestamp: i64) -> bool {
    now_ts <= due_timestamp
}

/// [M-01 · Sec3] Is the loan healthy enough to self-extend WITHOUT the pool
/// authority's co-signature? True only when the price feed is fresh, the TWAP
/// has minimum coverage, and the current collateral value (valued at the LOWER
/// of spot and TWAP, plus already-converted wSOL proceeds) still supports the
/// outstanding debt at the loan's own LTV. Fails CLOSED (returns false → the
/// authority must co-sign) on any missing/stale price or arithmetic edge, so an
/// unhealthy or unpriceable loan can never self-extend. Pure fn → unit-tested.
#[allow(clippy::too_many_arguments)]
fn extend_loan_is_healthy(
    feed: &PriceHistory,
    decimals: u8,
    now: i64,
    current_collateral: u64,
    sol_proceeds: u64,
    repay_amount: u64,
    ltv_bps: u16,
) -> bool {
    // Fresh latest sample required.
    let latest = match feed.latest() {
        Some(s) => s,
        None => return false,
    };
    if now.saturating_sub(latest.timestamp) > MAX_ORACLE_AGE_SECONDS {
        return false;
    }
    // Valid TWAP with minimum coverage required (same gate as borrow/convert).
    let (twap, _k, oldest_age) = match feed.twap(now) {
        Some(t) => t,
        None => return false,
    };
    if oldest_age < MIN_HISTORY_SECONDS {
        return false;
    }
    let spot = latest.price_lamports as u128;
    // Conservative: value at the LOWER of spot and TWAP.
    let valuation_price = if spot < twap { spot } else { twap };
    let coll_value = match (current_collateral as u128)
        .checked_mul(valuation_price)
        .and_then(|v| v.checked_div(10u128.pow(decimals as u32)))
    {
        Some(v) => v,
        None => return false,
    };
    let current_value = coll_value.saturating_add(sol_proceeds as u128);
    // Healthy iff current collateral, at the loan's LTV, still covers the debt:
    //   current_value * ltv_bps / 10000 >= repay_amount
    match (current_value)
        .checked_mul(ltv_bps as u128)
        .and_then(|v| v.checked_div(BPS_DENOM as u128))
    {
        Some(max_supported_debt) => max_supported_debt >= repay_amount as u128,
        None => false,
    }
}

/// [M-04 · Sec3] Is a proposed price update within the per-update sanity bound
/// relative to the previous sample? Accepts new ∈ [prev / FACTOR, prev *
/// FACTOR]. Always true when there is no previous price (prev == 0, first
/// sample). Uses u128 + saturating math so it can never overflow. Pure fn →
/// unit-tested.
#[inline(always)]
fn price_change_within_bound(prev: u64, new: u64) -> bool {
    if prev == 0 {
        return true; // first sample — nothing to bound against
    }
    let prev = prev as u128;
    let new = new as u128;
    let factor = MAX_PRICE_UPDATE_FACTOR as u128;
    // new <= prev * FACTOR  AND  new * FACTOR >= prev
    new <= prev.saturating_mul(factor) && new.saturating_mul(factor) >= prev
}

/// [H-01 · Sec3] Reject collateral mints carrying Token-2022 extensions that
/// break vault custody, unless explicitly supported:
///   - PermanentDelegate lets an external delegate move collateral OUT of the
///     vault without updating loan accounting (a direct drain vector).
///   - NonTransferable would make seized/repaid collateral impossible to return
///     or liquidate.
/// Legacy SPL Token mints cannot carry extensions and always pass. The
/// transfer-fee extension is handled separately in request_and_fund_loan by
/// valuing/recording the ACTUAL received amount (see [H-01] there), so fee-
/// bearing collateral is supported without over-lending. Other transfer-
/// altering extensions (transfer-hook, memo, pausable, default-account-state)
/// are gated at the collateral allowlist / off-chain screening layer; if a
/// future supported collateral needs one, add explicit handling here.
fn assert_collateral_custody_safe(mint_ai: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::extension::{
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    };
    use anchor_spl::token_2022::spl_token_2022::state::Mint as Mint2022;

    // Legacy SPL Token program mints have no extension TLV.
    if mint_ai.owner == &anchor_spl::token::ID {
        return Ok(());
    }
    let data = mint_ai.try_borrow_data()?;
    let state = StateWithExtensions::<Mint2022>::unpack(&data)
        .map_err(|_| error!(ErrorCode::UnsupportedCollateralExtension))?;
    let exts = state
        .get_extension_types()
        .map_err(|_| error!(ErrorCode::UnsupportedCollateralExtension))?;
    for ext in exts {
        if matches!(
            ext,
            ExtensionType::PermanentDelegate | ExtensionType::NonTransferable
        ) {
            return err!(ErrorCode::UnsupportedCollateralExtension);
        }
    }
    Ok(())
}

/// Memecoin tier ladder. Conservative LTVs because volatility on these
/// names can be 30%+ in an hour; short terms keep duration risk in check.
/// Option 0 Express : 30% LTV ·  2 days · 3.0% fee
/// Option 1 Quick   : 25% LTV ·  3 days · 2.0% fee
/// Option 2 Standard: 20% LTV ·  7 days · 1.5% fee
const TIER_MEMECOIN_LTV_BPS: [u64; 3] = [3_000, 2_500, 2_000];
const TIER_MEMECOIN_DURATION_DAYS: [i64; 3] = [2, 3, 7];
const TIER_MEMECOIN_FEE_BPS: [u64; 3] = [300, 200, 150];

/// RWA tier ladder for tokenized stocks / ETFs / metals (Backed
/// xStocks etc.). Intraday vol is typically 1–3% and the holder
/// profile is closer to traditional investors than memecoin traders.
/// The protocol can safely offer higher LTV / longer terms / higher
/// fee. Aspirational design from migration 040 — v3 is where the
/// numbers actually land in the on-chain program.
/// Option 0 RWA Express : 50% LTV ·  7 days · 2.5% fee
/// Option 1 RWA Quick   : 60% LTV · 15 days · 3.5% fee
/// Option 2 RWA Standard: 70% LTV · 30 days · 5.0% fee
const TIER_RWA_LTV_BPS: [u64; 3] = [5_000, 6_000, 7_000];
const TIER_RWA_DURATION_DAYS: [i64; 3] = [7, 15, 30];
const TIER_RWA_FEE_BPS: [u64; 3] = [250, 350, 500];

/// Resolve tier params from (category, option). Returns
/// (ltv_bps, fee_bps, duration_days) so the caller can use them
/// directly. Returns None when category or option is out of range —
/// caller must surface ErrorCode::InvalidCategory or InvalidLoanOption.
fn resolve_tier(category: u8, option: u8) -> Option<(u64, u64, i64)> {
    let i = option as usize;
    if i >= 3 { return None; }
    match category {
        CATEGORY_MEMECOIN => Some((
            TIER_MEMECOIN_LTV_BPS[i],
            TIER_MEMECOIN_FEE_BPS[i],
            TIER_MEMECOIN_DURATION_DAYS[i],
        )),
        CATEGORY_RWA => Some((
            TIER_RWA_LTV_BPS[i],
            TIER_RWA_FEE_BPS[i],
            TIER_RWA_DURATION_DAYS[i],
        )),
        _ => None,
    }
}

/// Reverse-lookup used by extend_loan / partial_repay / off-chain
/// indexers to recover (ltv_bps, fee_bps, duration_days) from a loan's
/// stored (category, ltv_bps). The ltv_bps within a category is
/// uniquely associated with one option index, so this is well-defined.
fn resolve_tier_for_loan(category: u8, ltv_bps: u16) -> Option<(u64, u64, i64)> {
    let table: &[u64; 3] = match category {
        CATEGORY_MEMECOIN => &TIER_MEMECOIN_LTV_BPS,
        CATEGORY_RWA      => &TIER_RWA_LTV_BPS,
        _ => return None,
    };
    let option = table.iter().position(|&v| v == ltv_bps as u64)? as u8;
    resolve_tier(category, option)
}

const SECONDS_PER_DAY: i64 = 86_400;

/// Maximum age (seconds) of the LATEST price sample before borrow is refused.
/// The TWAP itself can include older samples — this is about freshness.
const MAX_PRICE_STALENESS: i64 = 120; // 2 minutes

/// Maximum tolerance (bps) that submitted collateral_value can exceed
/// TWAP-derived value. 300 = 3%.
const MAX_VALUE_TOLERANCE_BPS: u64 = 300;

// --------------------------------------------------------------------------
// TWAP parameters
// --------------------------------------------------------------------------

/// Number of samples in the rolling ring buffer per mint.
/// 32 samples × 30s cadence = ~16 min of history.
/// 32 samples × 60s cadence = ~32 min of history.
const PRICE_HISTORY_CAPACITY: usize = 32;

/// Minimum samples in the buffer before TWAP-validated borrows are allowed.
/// Cold-start: a newly-initialized feed accepts attestations but refuses to
/// validate borrows until enough history accumulates. Critical defense —
/// without this, the first attestation post-init can be a pump.
const MIN_SAMPLES_FOR_TWAP: u8 = 8;

/// Minimum seconds of history covered before TWAP-validated borrows
/// are allowed. Pump-and-borrow attacks unfold in minutes; requiring
/// >= 5 min of history means an attacker can't pump the pool and borrow
/// in the same block.
const MIN_HISTORY_SECONDS: i64 = 300;

/// Spot price (latest sample) cannot exceed TWAP by this much. If it does,
/// the feed reflects an in-progress pump and we refuse to lend until the
/// spike fades. 1_500 bps = 15%.
const MAX_SPOT_VS_TWAP_PUMP_BPS: u64 = 1_500;

/// TWAP window in seconds. Only samples within this window are included
/// in the average. Older samples are ignored (but kept in the ring until
/// overwritten so we don't lose buffer slots).
const TWAP_WINDOW_SECONDS: i64 = 30 * 60; // 30 min

// ---------------------------------------------------------------------------
// Pool config helpers (pure — unit-tested directly)
// ---------------------------------------------------------------------------

/// Engine authority must be a real key and must not be the pool authority
/// (the engine key is online; the pool authority must stay cold).
fn pool_config_valid(pool_authority: &Pubkey, engine_authority: &Pubkey) -> bool {
    *engine_authority != Pubkey::default() && engine_authority != pool_authority
}

/// Apply a pool-config rotation. `signer` MUST equal `pool.authority` —
/// enforced here in addition to the `has_one = authority` account constraint
/// so the decision is testable off-chain and cannot be bypassed by a
/// mis-wired context. Returns the event to emit.
fn apply_pool_config(
    pool: &mut LendingPool,
    pool_key: Pubkey,
    signer: &Pubkey,
    new_engine_authority: Pubkey,
    new_fee_wallet: Pubkey,
) -> Result<PoolConfigUpdated> {
    require_keys_eq!(*signer, pool.authority, ErrorCode::Unauthorized);
    require!(
        pool_config_valid(&pool.authority, &new_engine_authority),
        ErrorCode::InvalidPoolConfig
    );
    require!(new_fee_wallet != Pubkey::default(), ErrorCode::InvalidPoolConfig);
    let ev = PoolConfigUpdated {
        pool: pool_key,
        authority: pool.authority,
        old_engine_authority: pool.engine_authority,
        new_engine_authority,
        old_fee_wallet: pool.fee_wallet,
        new_fee_wallet,
    };
    pool.engine_authority = new_engine_authority;
    pool.fee_wallet = new_fee_wallet;
    Ok(ev)
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[program]
pub mod hock_lending {
    use super::*;

    // -----------------------------------------------------------------------
    // Pool management
    // -----------------------------------------------------------------------

    /// Create a permissionless lending pool.  Anyone can call this once per
    /// authority key, but the `protocol_fee_bps` determines how much of each
    /// loan fee goes to the protocol vs the pool depositors.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        protocol_fee_bps: u16,
        keeper_reward_bps: u16,
        engine_authority: Pubkey,
    ) -> Result<()> {
        require!(protocol_fee_bps <= 5_000, ErrorCode::FeeTooHigh); // max 50%
        require!(keeper_reward_bps <= 2_000, ErrorCode::KeeperRewardTooHigh); // max 20%
        // Engine must be a real, distinct key: never the zero key and never
        // the pool authority (least privilege — the engine key is online).
        require!(
            pool_config_valid(&ctx.accounts.authority.key(), &engine_authority),
            ErrorCode::InvalidPoolConfig
        );

        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.authority.key();
        pool.engine_authority = engine_authority;
        // fee_wallet mint == loan_token_mint is enforced by the account
        // constraint on InitializePool.fee_wallet.
        pool.fee_wallet = ctx.accounts.fee_wallet.key();
        pool.loan_token_vault = ctx.accounts.loan_token_vault.key();
        pool.loan_token_mint = ctx.accounts.loan_token_mint.key();
        pool.protocol_fee_bps = protocol_fee_bps;
        pool.keeper_reward_bps = keeper_reward_bps;
        pool.total_deposits = 0;
        pool.total_shares = 0;
        pool.total_borrowed = 0;
        pool.total_fees_earned = 0;
        pool.total_loans_issued = 0;
        pool.total_liquidations = 0;
        pool.paused = false;
        pool.bump = ctx.bumps.pool;
        pool.vault_bump = ctx.bumps.loan_token_vault;

        emit!(PoolInitialized {
            pool: pool.key(),
            authority: pool.authority,
            protocol_fee_bps,
            engine_authority: pool.engine_authority,
            fee_wallet: pool.fee_wallet,
        });
        Ok(())
    }

    /// Rotate the engine authority and/or the protocol fee wallet
    /// (pool authority only — `has_one = authority` on SetPoolConfig plus a
    /// second explicit signer check inside `apply_pool_config`). Emits
    /// `PoolConfigUpdated` with the old and new values so off-chain
    /// consumers can audit every rotation.
    pub fn set_pool_config(ctx: Context<SetPoolConfig>, engine_authority: Pubkey) -> Result<()> {
        let new_fee_wallet = ctx.accounts.fee_wallet.key();
        let signer = ctx.accounts.authority.key();
        let pool = &mut ctx.accounts.pool;
        let pool_key = pool.key();
        let ev = apply_pool_config(pool, pool_key, &signer, engine_authority, new_fee_wallet)?;
        emit!(ev);
        Ok(())
    }

    /// Pause / unpause new borrows (authority only).
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.pool.paused = paused;
        Ok(())
    }

    /// Update keeper reward percentage (authority only).
    pub fn set_keeper_reward(ctx: Context<AdminOnly>, keeper_reward_bps: u16) -> Result<()> {
        require!(keeper_reward_bps <= 2_000, ErrorCode::KeeperRewardTooHigh);
        ctx.accounts.pool.keeper_reward_bps = keeper_reward_bps;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Price attestation
    // -----------------------------------------------------------------------

    /// Initialize a price feed for a specific token mint.
    /// Only the pool authority can create feeds for their pool.
    /// v3: the PriceHistory ring buffer starts empty. Borrows are
    /// refused until MIN_SAMPLES_FOR_TWAP samples accumulate AND
    /// MIN_HISTORY_SECONDS of time has elapsed since the first sample.
    pub fn initialize_price_feed(ctx: Context<InitializePriceFeed>) -> Result<()> {
        let feed = &mut ctx.accounts.price_feed;
        feed.mint = ctx.accounts.mint.key();
        feed.pool = ctx.accounts.pool.key();
        feed.authority = ctx.accounts.authority.key();
        feed.head_index = 0;
        feed.count = 0;
        feed._padding = [0u8; 6];
        // Zero-init the ring; samples are read only when count > 0 so
        // the zero values are never consulted, but explicit init keeps
        // the account state deterministic.
        feed.samples = [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        feed.bump = ctx.bumps.price_feed;

        emit!(PriceFeedInitialized {
            mint: feed.mint,
            pool: feed.pool,
            authority: feed.authority,
        });
        Ok(())
    }

    /// Append a new price sample to the rolling history. Only the pool
    /// authority can call this. The bot calls this on its attestor tick
    /// (every 30-60s). Each call advances the ring buffer one slot.
    ///
    /// `confidence_bps` is accepted for IDL compatibility with v1/v2
    /// but not stored — TWAP makes per-sample confidence less useful.
    /// [Q-01 · Sec3] Oracle confidence is INTENTIONALLY not used in v4 risk
    /// checks. The `confidence_bps` argument is retained only for IDL
    /// compatibility with earlier versions; it is neither stored nor emitted
    /// (the PriceUpdated event hardcodes 0). v4 relies on the time-weighted
    /// average price plus the spot-vs-TWAP pump gate for manipulation
    /// resistance, which supersedes per-sample confidence: a single wide- or
    /// bad-confidence print cannot move the TWAP, and the borrow path already
    /// values collateral at the lower of spot and TWAP. Operators/integrators
    /// should treat confidence as unused on v4 by design.
    pub fn update_price(
        ctx: Context<UpdatePrice>,
        price_lamports: u64,
        _confidence_bps: u16,
    ) -> Result<()> {
        require!(price_lamports > 0, ErrorCode::InvalidCollateralValue);

        let feed = &mut ctx.accounts.price_feed;
        let now = Clock::get()?.unix_timestamp;

        // Defensive guard: refuse a sample that's BEHIND the most recent
        // (clock skew or replay). Time must move forward.
        if let Some(latest) = feed.latest() {
            require!(now >= latest.timestamp, ErrorCode::PriceTimestampWentBackwards);
            // [M-04 · Sec3] Generous per-update price-change sanity bound (see
            // MAX_PRICE_UPDATE_FACTOR). Blocks a grossly-wrong single update
            // (fat-finger / decimal-unit error / stray zero) without leashing
            // legitimate volatility. The pool authority stays a trusted input
            // by design; this only limits a single update's blast radius.
            require!(
                price_change_within_bound(latest.price_lamports, price_lamports),
                ErrorCode::PriceChangeExceedsBound
            );
        }

        feed.append(PriceSample {
            price_lamports,
            timestamp: now,
        });

        emit!(PriceUpdated {
            mint: feed.mint,
            price_lamports,
            confidence_bps: 0,
            timestamp: now,
        });
        Ok(())
    }

    /// Emergency admin withdrawal — transfer wSOL directly from vault to authority.
    /// Only callable by the pool authority. Use this to recover funds that were
    /// deposited outside the share-based deposit flow.
    /// Emergency admin withdrawal — transfer wSOL directly from vault to
    /// authority, BYPASSING share accounting. Intended use: recover funds
    /// that were sent directly to the vault outside the share-based deposit
    /// flow (misroutes, fee dust, etc.). The on-chain enforcement below
    /// guarantees the admin can NEVER drain share-backed deposits, so LP
    /// accounting can never silently break — a class of bug that bit V1/V2
    /// (admin_withdraw had no on-chain excess-only guard, so a careless
    /// --all drain would leave pool.total_deposits over-stated and lock
    /// LPs out of subsequent withdraws).
    pub fn admin_withdraw(ctx: Context<AdminWithdraw>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.pool;
        let vault_balance = ctx.accounts.loan_token_vault.amount;
        // [I-02 · Sec3] Only tokens beyond what the vault must hold for LPs are
        // admin-withdrawable. When loans are outstanding, total_borrowed worth
        // of tokens are OUT of the vault, so the LP reserve the vault must keep
        // is (total_deposits - total_borrowed), NOT total_deposits. Using
        // total_deposits made this under-report excess (or fail outright)
        // whenever loans were active — misrouted dust could not be recovered.
        //
        // [L-03 interaction] pending_fees are retained pool_cut tokens that
        // physically sit in the vault but are NOT counted in total_deposits yet
        // (they realize on loan resolution). They must be reserved too, or
        // admin_withdraw could drain the very LP-retained fees L-03 protects.
        let lp_reserve = pool
            .total_deposits
            .checked_sub(pool.total_borrowed)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(pool.pending_fees)
            .ok_or(ErrorCode::MathOverflow)?;
        let excess = vault_balance
            .checked_sub(lp_reserve)
            .ok_or(ErrorCode::AdminWithdrawWouldDrainLpFunds)?;
        require!(amount <= excess, ErrorCode::AdminWithdrawWouldDrainLpFunds);

        let authority_key = pool.authority.key();
        let seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[pool.bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.authority_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Depositor operations
    // -----------------------------------------------------------------------

    /// Deposit SOL-equivalent loan tokens into the pool and receive shares.
    /// Shares = deposit_amount * total_shares / pool_value   (or 1:1 if first)
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);

        let pool = &ctx.accounts.pool;
        let pool_value = pool.total_deposits;

        // [L-07 · Sec3] Bankruptcy guard. If the pool was wiped out
        // (total_deposits == 0) but shares are still outstanding
        // (total_shares > 0), the fresh-pool 1:1 branch below would mint against
        // pool_value == 0 while old insolvent shares still exist — those shares
        // could then redeem part of the new depositor's funds. Refuse new
        // deposits in that state; recovery must clear outstanding shares first.
        require!(
            !(pool.total_deposits == 0 && pool.total_shares > 0),
            ErrorCode::PoolInsolvent
        );

        // Calculate shares to mint (use u128 to avoid overflow)
        let shares = if pool.total_shares == 0 || pool_value == 0 {
            amount // 1:1 on first deposit
        } else {
            let shares_u128 = (amount as u128)
                .checked_mul(pool.total_shares as u128)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(pool_value as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            u64::try_from(shares_u128).map_err(|_| ErrorCode::MathOverflow)?
        };
        require!(shares > 0, ErrorCode::InvalidAmount);

        // Transfer tokens from depositor to vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        // Update depositor position
        let position = &mut ctx.accounts.position;
        if position.shares == 0 {
            // New position
            position.owner = ctx.accounts.depositor.key();
            position.pool = ctx.accounts.pool.key();
            position.bump = ctx.bumps.position;
        }
        position.shares = position
            .shares
            .checked_add(shares)
            .ok_or(ErrorCode::MathOverflow)?;
        position.deposited_amount = position
            .deposited_amount
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        position.last_deposit_ts = Clock::get()?.unix_timestamp;

        // Update pool
        let pool = &mut ctx.accounts.pool;
        pool.total_deposits = pool
            .total_deposits
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_add(shares)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(Deposited {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            shares,
        });
        Ok(())
    }

    /// Withdraw by burning shares. Receives proportional pool value.
    pub fn withdraw(ctx: Context<Withdraw>, shares: u64) -> Result<()> {
        require!(shares > 0, ErrorCode::InvalidAmount);

        let position = &ctx.accounts.position;
        require!(position.shares >= shares, ErrorCode::InsufficientShares);

        let pool = &ctx.accounts.pool;
        let pool_value = pool.total_deposits;

        // Calculate withdrawal amount (u128 to avoid overflow)
        let amount_u128 = (shares as u128)
            .checked_mul(pool_value as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(pool.total_shares as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        let amount = u64::try_from(amount_u128).map_err(|_| ErrorCode::MathOverflow)?;
        require!(amount > 0, ErrorCode::InvalidAmount);

        // Check available liquidity (deposits - borrowed)
        let available = pool
            .total_deposits
            .checked_sub(pool.total_borrowed)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(amount <= available, ErrorCode::InsufficientLiquidity);

        // Transfer from vault to depositor (PDA signer)
        let authority_key = pool.authority.key();
        let seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[pool.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.depositor_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        // Update position
        let position = &mut ctx.accounts.position;
        // Capture pre-mutation values for the proportional reduction math
        // below; computing them BEFORE the share subtraction avoids the
        // post-hoc "add shares back" trick V1/V2 used (which involved an
        // .unwrap() that read confusingly even if mathematically safe).
        let position_shares_before = position.shares;
        let position_deposited_before = position.deposited_amount;
        position.shares = position
            .shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;
        // Reduce deposited_amount proportionally — use u128 intermediate so
        // (shares × position.deposited_amount) doesn't overflow u64 for
        // larger LP balances. The V1/V2 form `shares.checked_mul(deposited)`
        // overflowed once shares × deposited crossed ~1.8e19, which is the
        // root cause of the ~0.14 SOL withdraw cap operator hit during the
        // 2026-06-13 remediation. This form has headroom up to u128.
        let deposit_reduction = if position_shares_before == 0 {
            0u64
        } else {
            let num = (shares as u128)
                .checked_mul(position_deposited_before as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            let div = num
                .checked_div(position_shares_before as u128)
                .ok_or(ErrorCode::MathOverflow)?;
            // Saturating cast: a div result larger than position.deposited
            // _amount means the proportional reduction would consume the
            // entire deposited balance — cap there rather than overflow.
            u64::try_from(div).unwrap_or(position_deposited_before)
        };
        position.deposited_amount = position
            .deposited_amount
            .saturating_sub(deposit_reduction);

        // Update pool
        let pool = &mut ctx.accounts.pool;
        pool.total_deposits = pool
            .total_deposits
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_shares = pool
            .total_shares
            .checked_sub(shares)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(Withdrawn {
            pool: pool.key(),
            depositor: ctx.accounts.depositor.key(),
            amount,
            shares,
        });
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Loan operations
    // -----------------------------------------------------------------------

    /// Request and instantly fund a loan from the pool.
    ///
    /// `collateral_amount` – raw token units of collateral to lock.
    /// `loan_option`       – tier 0/1/2 within the chosen category.
    /// `collateral_value`  – oracle-supplied value in loan-token units.
    /// `loan_id`           – unique nonce (e.g. unix-ms).
    /// `category`          – 0 = memecoin (30/25/20% LTV @ 2/3/7d),
    ///                       1 = RWA stock/etf/metal (50/60/70% @ 7/15/30d).
    ///                       The cosign authority is responsible for matching
    ///                       this to the on-chain mint category — if a memecoin
    ///                       borrow arrives with category=RWA the higher LTV
    ///                       on a volatile mint becomes a default risk. The
    ///                       authority signature gates that.
    pub fn request_and_fund_loan(
        ctx: Context<RequestLoan>,
        collateral_amount: u64,
        loan_option: u8,
        collateral_value: u64,
        loan_id: u64,
        category: u8,
    ) -> Result<()> {
        // Constraints lifted from RequestLoan struct to keep try_accounts under
        // the BPF 4 KB stack limit. Functionally equivalent.
        require!(
            ctx.accounts.authority.key() == ctx.accounts.pool.authority,
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_collateral_account.owner == ctx.accounts.borrower.key(),
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_collateral_account.mint == ctx.accounts.collateral_mint.key(),
            ErrorCode::PriceMintMismatch
        );
        require!(
            ctx.accounts.borrower_loan_token_account.owner == ctx.accounts.borrower.key(),
            ErrorCode::Unauthorized
        );
        require!(
            ctx.accounts.borrower_loan_token_account.mint == ctx.accounts.pool.loan_token_mint,
            ErrorCode::PriceMintMismatch
        );
        require!(
            ctx.accounts.fee_wallet_token_account.mint == ctx.accounts.pool.loan_token_mint,
            ErrorCode::PriceMintMismatch
        );

        require!(!ctx.accounts.pool.paused, ErrorCode::PoolPaused);
        require!(loan_option <= 2, ErrorCode::InvalidLoanOption);
        require!(collateral_amount > 0, ErrorCode::InvalidCollateralAmount);
        require!(collateral_value > 0, ErrorCode::InvalidCollateralValue);
        // Validate category early — before any expensive TWAP / token work —
        // so a bad caller fails cheaply.
        require!(category <= 1, ErrorCode::InvalidCategory);

        // [H-01 · Sec3] Reject collateral whose Token-2022 extensions break
        // vault custody (permanent-delegate / non-transferable).
        assert_collateral_custody_safe(&ctx.accounts.collateral_mint.to_account_info())?;

        // --- v3 TWAP-based price validation ---
        // Replaces v2's single-spot attestation with a time-weighted
        // average over the last TWAP_WINDOW_SECONDS. Refuses to lend
        // when (a) too few samples, (b) too little history elapsed,
        // (c) latest sample stale, or (d) spot price has pumped
        // significantly above the TWAP (in-progress manipulation).
        let feed = &ctx.accounts.price_feed;
        let now = Clock::get()?.unix_timestamp;

        // Freshness — the LATEST sample must be recent.
        let latest = feed.latest().ok_or(ErrorCode::TwapInsufficientHistory)?;
        require!(
            now.checked_sub(latest.timestamp).unwrap_or(i64::MAX) <= MAX_PRICE_STALENESS,
            ErrorCode::StalePriceAttestation
        );

        // Compute TWAP. Refuses if not enough samples in window.
        let (twap, _samples_used, oldest_age) =
            feed.twap(now).ok_or(ErrorCode::TwapInsufficientHistory)?;

        // History-length requirement: oldest sample must be at least
        // MIN_HISTORY_SECONDS old. Otherwise an attacker could spam
        // samples right before borrowing.
        require!(
            oldest_age >= MIN_HISTORY_SECONDS,
            ErrorCode::TwapInsufficientHistory
        );

        // Pump check: if spot (latest sample) is too far above TWAP,
        // we're in an active price-impact event. Refuse the borrow.
        // (We DO allow downward divergence — if spot < TWAP, borrowing
        // against the lower spot value is fine for the protocol.)
        let spot = latest.price_lamports as u128;
        let max_spot = twap
            .checked_mul((BPS_DENOM as u128) + (MAX_SPOT_VS_TWAP_PUMP_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(spot <= max_spot, ErrorCode::PriceImpactPumpDetected);

        // Compute expected collateral value from TWAP — use the LOWER of
        // (TWAP, spot) so we never lend against an inflated spot even
        // within the pump-tolerance window.
        let valuation_price = if spot < twap { spot } else { twap };
        let decimals = ctx.accounts.collateral_mint.decimals;

        // [H-01 · Sec3] Transfer the collateral FIRST and value the loan against
        // the amount the vault ACTUALLY received, not the requested amount. A
        // Token-2022 transfer-fee mint credits only (amount - fee) to the vault;
        // valuing/recording the requested amount would over-lend against
        // collateral the vault never received and later break repay/liquidate/
        // convert paths that read current_collateral_amount as the vault balance.
        // collateral_vault is freshly `init`ed for this loan (pre-balance 0); we
        // snapshot + reload to be robust regardless.
        let vault_before = ctx.accounts.collateral_vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            collateral_amount,
            decimals,
        )?;
        ctx.accounts.collateral_vault.reload()?;
        let received_collateral = ctx
            .accounts
            .collateral_vault
            .amount
            .checked_sub(vault_before)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(received_collateral > 0, ErrorCode::ZeroCollateralReceived);

        let expected_value = (received_collateral as u128)
            .checked_mul(valuation_price)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10u128.pow(decimals as u32))
            .ok_or(ErrorCode::MathOverflow)?;

        // Submitted value cannot exceed expected + 3% tolerance (matches
        // v1/v2 tolerance window, but baseline is now TWAP-derived).
        let max_allowed = expected_value
            .checked_mul((BPS_DENOM as u128) + (MAX_VALUE_TOLERANCE_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?;

        require!(
            (collateral_value as u128) <= max_allowed,
            ErrorCode::CollateralValueExceedsAttestation
        );

        let (ltv_bps, fee_bps, duration_days) =
            resolve_tier(category, loan_option).ok_or(ErrorCode::InvalidCategory)?;

        // Compute loan amount from LTV.
        // [Q-03 · Sec3] Size the loan from the LOWER of the caller-supplied
        // collateral_value and the on-chain oracle-derived expected_value. The
        // MAX_VALUE_TOLERANCE_BPS band still governs REJECTION above, but must
        // never inflate the loan base — otherwise a borrower could always borrow
        // at the top of the tolerance band.
        let value_base = core::cmp::min(collateral_value as u128, expected_value);
        let gross_loan: u64 = value_base
            .checked_mul(ltv_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .try_into()
            .map_err(|_| ErrorCode::MathOverflow)?;

        // Compute fee.
        // [I-04 · Sec3] Round the origination fee UP so a tiny loan cannot avoid
        // the fee entirely via floor division.
        let fee = (gross_loan as u128)
            .checked_mul(fee_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add((BPS_DENOM as u128) - 1)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)? as u64;

        let net_loan = gross_loan
            .checked_sub(fee)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(net_loan > 0, ErrorCode::InvalidAmount);

        // Check pool has enough liquidity
        let available = ctx
            .accounts
            .pool
            .total_deposits
            .checked_sub(ctx.accounts.pool.total_borrowed)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(available >= gross_loan, ErrorCode::InsufficientLiquidity);

        // Collateral was already transferred into the vault above (see [H-01]).
        let now = Clock::get()?.unix_timestamp;

        // --- Disburse loan tokens from pool vault to borrower ---
        let authority_key = ctx.accounts.pool.authority.key();
        let pool_seeds = &[
            b"pool".as_ref(),
            authority_key.as_ref(),
            &[ctx.accounts.pool.bump],
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.loan_token_vault.to_account_info(),
                    to: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[pool_seeds],
            ),
            net_loan,
        )?;

        // --- Send fee to protocol fee wallet ---
        if fee > 0 {
            // Split fee: protocol_fee_bps goes to protocol, rest stays in pool
            let protocol_cut = fee
                .checked_mul(ctx.accounts.pool.protocol_fee_bps as u64)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(BPS_DENOM)
                .ok_or(ErrorCode::MathOverflow)?;
            // pool_cut stays in the vault → depositors earn it via share appreciation
            if protocol_cut > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.loan_token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.loan_token_vault.to_account_info(),
                            to: ctx.accounts.fee_wallet_token_account.to_account_info(),
                            authority: ctx.accounts.pool.to_account_info(),
                        },
                        &[pool_seeds],
                    ),
                    protocol_cut,
                )?;
            }

            // pool_cut stays in the vault AND must be credited to LPs by
            // bumping pool.total_deposits — otherwise the withdraw math
            // (`shares × total_deposits / total_shares`) silently leaves
            // the yield behind in the vault, unclaimable by LPs. This was
            // the bug that landed V1/V2 with ~20 SOL of stranded LP yield
            // accumulating in vault excess; V3 honors the "share
            // appreciation" promise that the V1/V2 comments made but the
            // code did not deliver.
            let pool_cut = fee
                .checked_sub(protocol_cut)
                .ok_or(ErrorCode::MathOverflow)?;

            let pool = &mut ctx.accounts.pool;
            pool.total_fees_earned = pool
                .total_fees_earned
                .checked_add(fee)
                .ok_or(ErrorCode::MathOverflow)?;
            // [L-03 · Sec3] Credit pool_cut to PENDING fees, not total_deposits.
            // It becomes withdrawable LP equity only when this loan repays or
            // liquidates — otherwise an LP could exit early with the up-front
            // fee while a later default falls entirely on the LPs who stayed.
            // The tokens physically remain in the vault either way.
            pool.pending_fees = pool
                .pending_fees
                .checked_add(pool_cut)
                .ok_or(ErrorCode::MathOverflow)?;
        }

        // --- Populate loan account ---
        let loan = &mut ctx.accounts.loan;
        loan.loan_id = loan_id;
        loan.borrower = ctx.accounts.borrower.key();
        loan.pool = ctx.accounts.pool.key();
        loan.collateral_mint = ctx.accounts.collateral_mint.key();
        loan.collateral_vault = ctx.accounts.collateral_vault.key();
        // [H-01] Record the ACTUAL received amount, not the requested amount.
        loan.collateral_amount = received_collateral;
        loan.loan_amount = net_loan;
        loan.repay_amount = gross_loan; // borrower must repay the full gross amount
        loan.transaction_fee = fee;
        // [L-03 · Sec3] The LP-retained portion of the fee is held pending on the
        // pool until this loan resolves (mirrors the pool.pending_fees credit).
        {
            let protocol_cut = fee
                .checked_mul(ctx.accounts.pool.protocol_fee_bps as u64)
                .ok_or(ErrorCode::MathOverflow)?
                .checked_div(BPS_DENOM)
                .ok_or(ErrorCode::MathOverflow)?;
            loan.accrued_pool_fees = fee
                .checked_sub(protocol_cut)
                .ok_or(ErrorCode::MathOverflow)?;
        }
        loan.ltv_bps = ltv_bps as u16;
        loan.duration_days = duration_days as u8;
        // Persist category so extend_loan / partial-repay can resolve the
        // correct tier ladder later WITHOUT having to look up the mint
        // category from off-chain again. Avoids "what tier is this" round-
        // trips that bit V1/V2 in the limit-close engine after migration 040.
        loan.category = category;
        loan.start_timestamp = now;
        loan.due_timestamp = now
            .checked_add(duration_days.checked_mul(SECONDS_PER_DAY).unwrap())
            .ok_or(ErrorCode::MathOverflow)?;
        loan.status = LoanStatus::Active;
        loan.collateral_value_at_start = collateral_value;
        loan.bump = ctx.bumps.loan;
        loan.vault_bump = ctx.bumps.collateral_vault;
        // v4 in-vault auto-sell state. At borrow time the full collateral
        // is SPL tokens and there is no SOL in the loan vault yet.
        // [H-01] Track the ACTUAL received amount as the in-vault balance.
        loan.current_collateral_amount = received_collateral;
        loan.sol_proceeds_amount = 0;
        loan.auto_sells_fired = 0;
        // [H-02 · Sec3] Loans start DISARMED — the engine cannot convert any
        // collateral until the borrower arms a trigger (or the loan is overdue).
        loan.armed_trigger_price = 0;
        loan.armed_trigger_direction = 0;
        loan.armed_max_slice_bps = 0;
        loan.armed_total_bps = 0;
        loan.armed_converted_bps = 0;

        // Update pool stats
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_add(gross_loan)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_loans_issued = pool
            .total_loans_issued
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanFunded {
            pool: pool.key(),
            loan: ctx.accounts.loan.key(),
            borrower: ctx.accounts.borrower.key(),
            collateral_mint: ctx.accounts.collateral_mint.key(),
            collateral_amount: received_collateral,
            loan_amount: net_loan,
            fee,
            ltv_bps: ltv_bps as u16,
            duration_days: duration_days as u8,
            category,
        });
        Ok(())
    }

    /// Repay loan in full; collateral returned to borrower.
    pub fn repay_loan(ctx: Context<RepayLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let repay_amount = loan.repay_amount;

        // Borrower sends repayment to pool vault
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            repay_amount,
        )?;

        // v4: return whatever is currently in the loan vault. After
        // zero or more convert_collateral_slice calls, the vault may
        // hold a mix of remaining SPL collateral + accumulated SOL.
        // current_collateral_amount = SPL still in vault (0 after full
        // auto-sell). sol_proceeds_amount = SOL accumulated from
        // auto-sells. Either or both can be zero.
        let loan_key = ctx.accounts.loan.key();
        let vault_seeds = &[
            b"collateral-vault".as_ref(),
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;

        // 1. Return any remaining SPL collateral.
        if loan.current_collateral_amount > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.borrower_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                loan.current_collateral_amount,
                collateral_decimals,
            )?;
        }

        // 2. Return any accumulated SOL proceeds (wSOL held in a vault-
        //    authority wSOL ATA — same authority/seeds as the SPL vault).
        //    We transfer wSOL directly to the borrower's loan-token ATA.
        //    The borrower can unwrap to native SOL via the standard SPL
        //    close-account instruction off-chain if they want native.
        if loan.sol_proceeds_amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sol_proceeds_vault.to_account_info(),
                        to: ctx.accounts.borrower_loan_token_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                loan.sol_proceeds_amount,
            )?;
        }

        // Update loan
        let loan = &mut ctx.accounts.loan;
        loan.current_collateral_amount = 0;
        loan.sol_proceeds_amount = 0;
        loan.status = LoanStatus::Repaid;

        // Update pool — principal returns, increasing available liquidity
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(loan.repay_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        // [L-03 · Sec3] Realize this loan's retained (pending) fee into
        // withdrawable LP equity now that the loan has fully repaid.
        pool.total_deposits = pool
            .total_deposits
            .checked_add(loan.accrued_pool_fees)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.pending_fees = pool
            .pending_fees
            .checked_sub(loan.accrued_pool_fees)
            .ok_or(ErrorCode::MathOverflow)?;
        // The interest portion (repay_amount was already accounted for in total_deposits
        // through the fee split at origination). The repayment going back to the vault
        // restores the borrowed principal.
        // Net yield for depositors = pool_cut of fees (already realized at borrow time).

        emit!(LoanRepaid {
            pool: pool.key(),
            loan: ctx.accounts.loan.key(),
            borrower: ctx.accounts.borrower.key(),
            repay_amount,
        });
        Ok(())
    }

    /// Partial repayment — reduce outstanding balance, collateral stays locked.
    pub fn partial_repay(ctx: Context<PartialRepay>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);
        // [M-02 · Sec3] A partial repayment must leave a remainder. Allowing
        // amount == repay_amount here would drive repay_amount to 0 while the
        // loan stays Active with collateral locked — that loan could then be
        // liquidated (collateral seized) despite having no debt. The final
        // payment must go through repay_loan, which returns the collateral and
        // marks the loan Repaid.
        require!(amount < loan.repay_amount, ErrorCode::UseRepayLoanForFinalPayment);

        // Transfer repayment
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
        )?;

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        loan.repay_amount = loan
            .repay_amount
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;
        let remaining = loan.repay_amount;

        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(PartialRepayment {
            loan: loan_key,
            amount,
            remaining,
        });
        Ok(())
    }

    /// Add more collateral to an active loan (no fee).
    pub fn add_collateral(ctx: Context<AddCollateral>, amount: u64) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let collateral_decimals = ctx.accounts.collateral_mint.decimals;
        // [H-01 · Sec3] Record the ACTUAL amount the vault receives, not the
        // requested amount. A Token-2022 transfer-fee mint credits only
        // (amount - fee); recording the requested amount would overshoot the
        // real vault balance and later brick repay/liquidate (which move
        // current_collateral_amount out of the vault). Mirrors the borrow path.
        let vault_before = ctx.accounts.collateral_vault.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.borrower_collateral_account.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.collateral_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            amount,
            collateral_decimals,
        )?;
        ctx.accounts.collateral_vault.reload()?;
        let received = ctx
            .accounts
            .collateral_vault
            .amount
            .checked_sub(vault_before)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(received > 0, ErrorCode::ZeroCollateralReceived);

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        loan.collateral_amount = loan
            .collateral_amount
            .checked_add(received)
            .ok_or(ErrorCode::MathOverflow)?;
        // v4: current_collateral_amount also grows. Without this, a
        // user who topped up AFTER an auto-sell would have their topup
        // amount mis-tracked against the original baseline.
        loan.current_collateral_amount = loan
            .current_collateral_amount
            .checked_add(received)
            .ok_or(ErrorCode::MathOverflow)?;
        let new_total = loan.collateral_amount;

        emit!(CollateralAdded {
            loan: loan_key,
            amount: received,
            new_total,
        });
        Ok(())
    }

    /// Extend loan by its original duration, paying the tier fee again.
    pub fn extend_loan(ctx: Context<ExtendLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        // [Q-02 · Sec3] Overdue loans are liquidatable and must NOT be
        // extendable — otherwise a borrower can front-run a keeper and push the
        // due date forward after the loan is already past due.
        let now = Clock::get()?.unix_timestamp;
        require!(now <= loan.due_timestamp, ErrorCode::LoanOverdueForExtension);

        // [M-01 · Sec3] ON-CHAIN collateral health check. Previously every
        // extension required the pool authority to co-sign — which let a
        // MALICIOUS authority withhold its signature from a HEALTHY borrower,
        // block the extension, and force the loan into time-based liquidation
        // to seize the collateral. Now a loan that is provably HEALTHY on-chain
        // (fresh price + current LTV within the loan's own LTV, using the same
        // conservative TWAP valuation the borrow path uses) may self-extend
        // with NO authority signature. Only when the price is unavailable/stale
        // OR the loan is under-collateralized must the pool authority co-sign
        // (Sec3's fallback). An unhealthy loan can therefore NEVER be extended
        // without authority approval, so LPs are never silently exposed to a
        // prolonged undercollateralized position.
        let healthy = extend_loan_is_healthy(
            &ctx.accounts.price_history,
            ctx.accounts.collateral_mint.decimals,
            now,
            loan.current_collateral_amount,
            loan.sol_proceeds_amount,
            loan.repay_amount,
            loan.ltv_bps,
        );
        if !healthy {
            let authority = ctx
                .accounts
                .authority
                .as_ref()
                .ok_or(ErrorCode::ExtendRequiresAuthority)?;
            require!(
                authority.key() == ctx.accounts.pool.authority,
                ErrorCode::Unauthorized
            );
        }

        // Resolve tier from the loan's stored (category, option) — the option
        // is derived from ltv_bps within the category's ladder. RWA Standard
        // (70%) and memecoin Express (30%) have distinct ltv_bps so the
        // option-from-ltv inference inside resolve_tier_for_loan is unique
        // per category.
        let (_, fee_bps, duration_days) =
            resolve_tier_for_loan(loan.category, loan.ltv_bps)
                .ok_or(ErrorCode::InvalidLoanOption)?;

        // [L-06 · Sec3] Round the extension fee UP so a borrower cannot reduce
        // repay_amount to dust (via partial_repay) and then extend for free
        // because the floor-divided fee rounded to 0.
        let extension_fee = loan
            .repay_amount
            .checked_mul(fee_bps)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(BPS_DENOM - 1)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(extension_fee > 0, ErrorCode::InvalidAmount);

        // Borrower pays extension fee
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.borrower_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.borrower.to_account_info(),
                },
            ),
            extension_fee,
        )?;

        // Split fee same as origination
        let protocol_cut = extension_fee
            .checked_mul(ctx.accounts.pool.protocol_fee_bps as u64)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM)
            .ok_or(ErrorCode::MathOverflow)?;

        if protocol_cut > 0 {
            let authority_key = ctx.accounts.pool.authority.key();
            let pool_seeds = &[
                b"pool".as_ref(),
                authority_key.as_ref(),
                &[ctx.accounts.pool.bump],
            ];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.loan_token_vault.to_account_info(),
                        to: ctx.accounts.fee_wallet_token_account.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[pool_seeds],
                ),
                protocol_cut,
            )?;
        }

        let loan_key = ctx.accounts.loan.key();
        let loan = &mut ctx.accounts.loan;
        let extension = duration_days
            .checked_mul(SECONDS_PER_DAY)
            .ok_or(ErrorCode::MathOverflow)?;
        loan.due_timestamp = loan
            .due_timestamp
            .checked_add(extension)
            .ok_or(ErrorCode::MathOverflow)?;
        let new_due = loan.due_timestamp;

        // [L-03 · Sec3] The retained portion of the extension fee is held as
        // pending pool income (not immediately withdrawable), same as the
        // origination fee — realized to LP equity when the loan resolves.
        let pool_cut = extension_fee
            .checked_sub(protocol_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        let pool = &mut ctx.accounts.pool;
        pool.total_fees_earned = pool
            .total_fees_earned
            .checked_add(extension_fee)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.pending_fees = pool
            .pending_fees
            .checked_add(pool_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        ctx.accounts.loan.accrued_pool_fees = ctx
            .accounts
            .loan
            .accrued_pool_fees
            .checked_add(pool_cut)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanExtended {
            loan: loan_key,
            new_due_timestamp: new_due,
            extension_fee,
        });
        Ok(())
    }

    /// Liquidate an overdue loan. **Permissionless** — any wallet (keeper) can
    /// call this. The keeper receives `keeper_reward_bps` of the seized
    /// collateral as a bounty; the remainder goes to the pool authority for
    /// off-chain swap and pool recovery.
    pub fn liquidate_loan(ctx: Context<LiquidateLoan>) -> Result<()> {
        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        let now = Clock::get()?.unix_timestamp;
        require!(now > loan.due_timestamp, ErrorCode::LoanNotDue);
        // [M-02 · Sec3] Never liquidate a loan that carries no debt. A loan
        // partial-repaid to exactly 0 (pre-M-02-fix) could otherwise be
        // liquidated and its collateral seized despite nothing being owed.
        require!(loan.repay_amount > 0, ErrorCode::LoanFullyRepaid);

        // v4 — mixed-collateral liquidation. The vault may now hold a
        // mix of remaining SPL (loan.current_collateral_amount) and
        // accumulated wSOL (loan.sol_proceeds_amount, sitting in the
        // sol_proceeds_vault). Either or both can be non-zero.
        //
        // Distribution preserves V3 semantics but applies to BOTH pots:
        //   - keeper bounty: keeper_reward_bps of EACH pot
        //   - authority residual: the rest of EACH pot (operator sells
        //     SPL off-chain to recover principal; SOL is already liquid)
        //
        // The "total_collateral_seized" event field sums both for
        // backwards-compat with off-chain consumers that watched V3.
        let remaining_spl = loan.current_collateral_amount;
        let remaining_sol = loan.sol_proceeds_amount;
        let keeper_reward_bps = ctx.accounts.pool.keeper_reward_bps as u64;

        // SPL split
        let keeper_reward_spl = (remaining_spl as u128)
            .checked_mul(keeper_reward_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let authority_amount_spl = remaining_spl
            .checked_sub(keeper_reward_spl)
            .ok_or(ErrorCode::MathOverflow)?;

        // SOL split
        let keeper_reward_sol = (remaining_sol as u128)
            .checked_mul(keeper_reward_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        let authority_amount_sol = remaining_sol
            .checked_sub(keeper_reward_sol)
            .ok_or(ErrorCode::MathOverflow)?;

        let loan_key = ctx.accounts.loan.key();
        let vault_seeds = &[
            b"collateral-vault".as_ref(),
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;

        // SPL pot transfers (skipped entirely if 100% auto-sold).
        if keeper_reward_spl > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.keeper_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                keeper_reward_spl,
                collateral_decimals,
            )?;
        }
        if authority_amount_spl > 0 {
            token_interface::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    TransferChecked {
                        from: ctx.accounts.collateral_vault.to_account_info(),
                        mint: ctx.accounts.collateral_mint.to_account_info(),
                        to: ctx.accounts.authority_collateral_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                authority_amount_spl,
                collateral_decimals,
            )?;
        }

        // SOL pot transfers (skipped if no auto-sells ever fired).
        if keeper_reward_sol > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sol_proceeds_vault.to_account_info(),
                        to: ctx.accounts.keeper_loan_token_account.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                keeper_reward_sol,
            )?;
        }
        // [L-02 · Sec3] The wSOL proceeds residual (== loan token) is routed back
        // into the pool's loan_token_vault and credited to LP equity below,
        // rather than paid to the authority — LPs recover the on-chain-
        // reconcilable value instead of taking a full write-off. (The SPL
        // collateral residual still goes to the authority for off-chain sale.)
        if authority_amount_sol > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sol_proceeds_vault.to_account_info(),
                        to: ctx.accounts.loan_token_vault.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                authority_amount_sol,
            )?;
        }

        let pool_key = ctx.accounts.pool.key();
        let repay_amount = ctx.accounts.loan.repay_amount;
        let borrower = ctx.accounts.loan.borrower;
        let keeper = ctx.accounts.keeper.key();
        // [I-03 · Sec3] Report each asset separately; never sum SPL + wSOL.
        let collateral_mint_key = ctx.accounts.collateral_mint.key();
        let loan_token_mint = ctx.accounts.pool.loan_token_mint;
        // [L-03 · Sec3] Retained fee to realize on resolution (captured before
        // the loan account is mutated below).
        let accrued_fees = ctx.accounts.loan.accrued_pool_fees;

        let loan = &mut ctx.accounts.loan;
        loan.status = LoanStatus::Liquidated;
        // v4 — zero the two pots so re-reading the loan account after
        // liquidation reports an empty vault (matches reality).
        loan.current_collateral_amount = 0;
        loan.sol_proceeds_amount = 0;

        // Write off the borrowed amount (pool takes the loss; depositors share it)
        let pool = &mut ctx.accounts.pool;
        pool.total_borrowed = pool
            .total_borrowed
            .checked_sub(repay_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        // [L-02 · Sec3] Only the UNRECOVERED portion of the debt is a loss to
        // LPs: subtract the debt, then credit back the recovered wSOL proceeds
        // that were just routed into loan_token_vault.
        // [L-03 · Sec3] Also realize this loan's retained (pending) fee — it was
        // held in the vault since origination and is earned regardless of the
        // default.
        pool.total_deposits = pool
            .total_deposits
            .checked_sub(repay_amount)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(authority_amount_sol)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add(accrued_fees)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.pending_fees = pool
            .pending_fees
            .checked_sub(accrued_fees)
            .ok_or(ErrorCode::MathOverflow)?;
        pool.total_liquidations = pool
            .total_liquidations
            .checked_add(1)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LoanLiquidated {
            pool: pool_key,
            loan: loan_key,
            borrower,
            keeper,
            collateral_seized_spl: remaining_spl,
            proceeds_seized_wsol: remaining_sol,
            keeper_reward_spl,
            keeper_reward_wsol: keeper_reward_sol,
            authority_amount_spl,
            lp_recovered_wsol: authority_amount_sol,
            collateral_mint: collateral_mint_key,
            loan_token_mint,
        });
        Ok(())
    }

    /// v4 ── auto-sell a slice of SPL collateral and store the SOL in the
    /// loan vault. The loan stays ACTIVE; principal, fee, and due_timestamp
    /// are unchanged. Only the engine authority can call this. Pattern B
    /// CPI: the caller provides the swap program + accounts in
    /// `remaining_accounts` and the swap-instruction data via `swap_ix_data`;
    /// this function invokes the swap and validates the SOL came back ≥
    /// min_sol_out. Aggregator-agnostic.
    ///
    /// State changes (atomic — all or none):
    ///   loan.current_collateral_amount -= slice_amount
    ///   loan.sol_proceeds_amount       += sol_received - protocol_fee
    ///   loan.auto_sells_fired          += 1
    ///
    /// The 1% protocol fee is skimmed in-program and sent to the fee
    /// wallet (same wSOL ATA the borrow-side fee flows to). The slice
    /// is expressed in basis points of the ORIGINAL collateral amount,
    /// not the remaining — so "70% / 20% / 10%" ladders compose
    /// arithmetically without per-leg drift.
    ///
    /// Safety guarantees:
    ///   - Only the pool's engine_authority may sign (constraint on ConvertCollateralSlice)
    ///   - slice_bps clamped to (0, 10_000]
    ///   - slice_amount clamped to remaining collateral
    ///   - SOL deposit verified against vault delta (not trusting the swap)
    ///   - min_sol_out enforced after the swap (slippage cap)
    ///   - Fee skim arithmetic uses u128 intermediate (no overflow)
    pub fn convert_collateral_slice(
        ctx: Context<ConvertCollateralSlice>,
        slice_bps: u16,
        min_sol_out: u64,
        swap_ix_data: Vec<u8>,
    ) -> Result<()> {
        // ── Input validation ────────────────────────────────────────
        require!(slice_bps > 0 && slice_bps <= SLICE_BPS_MAX, ErrorCode::InvalidSlice);

        let loan = &ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);

        // Compute slice of ORIGINAL collateral. u128 intermediate so a
        // worst-case (u64::MAX * 10_000) can't overflow.
        let slice_amount: u64 = (loan.collateral_amount as u128)
            .checked_mul(slice_bps as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10_000)
            .ok_or(ErrorCode::MathOverflow)? as u64;
        require!(slice_amount > 0, ErrorCode::SliceTooSmall);
        require!(slice_amount <= loan.current_collateral_amount, ErrorCode::SliceExceedsRemaining);

        // Collateral decimals — needed for the decimal-normalized oracle floor
        // [M-03] and for transfer_checked below.
        let collateral_decimals = ctx.accounts.collateral_mint.decimals;

        // ── GATE A (hardened per Sec3): TWAP + decimal-normalized oracle floor ──
        // Without a floor, a compromised engine_authority could submit
        // min_sol_out=0 and let the inner swap drain collateral for ~0 SOL.
        // The program reads the loan's price_history PDA and enforces a minimum
        // acceptable output; even a higher caller-supplied min_sol_out never
        // lowers this baseline.
        //
        // [L-04 · Sec3] Use the SAME TWAP-based valuation the borrow path uses
        // (lower of spot and TWAP with a minimum coverage window), NOT a single
        // latest sample: one fresh bad sample must not be able to move the floor
        // for a collateral-moving operation.
        // [M-03 · Sec3] Normalize by 10^collateral_decimals — price_lamports is
        // denominated per WHOLE token (as the borrow path treats it), so without
        // the divide the floor was too large by 10^decimals and legitimate
        // conversions failed / overflowed.
        let now_ts = Clock::get()?.unix_timestamp;
        let oracle_latest = ctx.accounts.price_history.latest()
            .ok_or(ErrorCode::OracleEmpty)?;
        require!(
            now_ts.checked_sub(oracle_latest.timestamp).unwrap_or(i64::MAX)
                <= MAX_ORACLE_AGE_SECONDS,
            ErrorCode::OracleStale
        );
        let (twap, _samples_used, oldest_age) = ctx
            .accounts
            .price_history
            .twap(now_ts)
            .ok_or(ErrorCode::TwapInsufficientHistory)?;
        require!(oldest_age >= MIN_HISTORY_SECONDS, ErrorCode::TwapInsufficientHistory);
        let spot = oracle_latest.price_lamports as u128;
        // Conservative: value the slice at the LOWER of spot and TWAP.
        // [L-04 · Sec3] The FLOOR (minimum acceptable output) uses min(spot,twap)
        // so a single LOW sample can never lower it — the manipulation-resistant
        // direction. We deliberately do NOT block the opposite case (a high spot
        // "inflating" the floor) the way the borrow path refuses upward
        // spot-vs-TWAP divergence: an auto-sell MUST be allowed to FIRE on a
        // genuine upside spike (the core take-profit behavior). Firing high only
        // benefits the borrower and the pool, and the floor still guarantees a
        // conservative minimum output. WHETHER a fire is authorized at all is
        // decided by the H-02 armed-trigger gate just below — not by this
        // valuation. Trigger = "may we sell?"; this floor = "for at least how
        // much?".
        let oracle_price = if spot < twap { spot } else { twap };

        // ── [H-02 · Sec3] AUTHORIZATION GATE ────────────────────────────────
        // A (possibly compromised) engine may move collateral ONLY when there
        // is a legitimate, borrower-consented reason:
        //   (a) the loan is OVERDUE (a keeper could liquidate it anyway), OR
        //   (b) the BORROWER armed a trigger on-chain and price has reached it,
        //       for a slice no larger than the armed cap.
        // A healthy, un-armed loan can NEVER be force-sold — this closes the
        // compromised-engine force-sell vector Sec3 flagged.
        //
        // The trigger is evaluated against the LATEST SPOT sample, not the
        // conservative TWAP: a take-profit must fire on a genuine upside SPIKE
        // (the whole point of the feature — capture random spikes). The MINIMUM
        // OUTPUT is still floored at min(spot, twap) below, so even when a fire
        // is authorized the engine can never sell for materially less than the
        // conservative value. Trigger = "may we sell?"; floor = "for at least
        // how much?" — the two are deliberately decoupled.
        //
        // [Q-04 · Sec3] TWO caps, deliberately distinct:
        //   armed_max_slice_bps — the most a SINGLE fire may take
        //   armed_total_bps     — the most ALL fires may take under this arming
        // Capping only per call let the engine sell most or all of the
        // collateral in successive slices while the trigger stayed satisfied,
        // which made the borrower's authorization meaningless. Capping only in
        // aggregate would have broken laddered exits, which fire several legs
        // under one arming. Enforcing both preserves the ladder and still binds
        // the total the engine can ever take. Only a new arm/disarm resets it.
        let overdue = now_ts > loan.due_timestamp;
        require!(
            conversion_authorized(
                overdue,
                loan.armed_trigger_price,
                loan.armed_trigger_direction,
                spot,
                slice_bps,
                loan.armed_max_slice_bps,
                loan.armed_total_bps,
                loan.armed_converted_bps,
            ),
            ErrorCode::ConversionNotAuthorized
        );

        // oracle_floor = slice_amount × oracle_price × (10000 - MAX_SLIPPAGE)
        //                / 10000 / 10^collateral_decimals
        let oracle_floor: u64 = (slice_amount as u128)
            .checked_mul(oracle_price)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_mul((BPS_DENOM as u128) - (MAX_PROTOCOL_SLIPPAGE_BPS as u128))
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(10u128.pow(collateral_decimals as u32))
            .ok_or(ErrorCode::MathOverflow)?
            .try_into()
            .map_err(|_| ErrorCode::MathOverflow)?;
        require!(min_sol_out >= oracle_floor, ErrorCode::MinOutBelowOracleFloor);

        let loan_key = ctx.accounts.loan.key();
        let vault_seeds: &[&[u8]] = &[
            b"collateral-vault",
            loan_key.as_ref(),
            &[loan.vault_bump],
        ];

        // [H-02 · Sec3] Snapshot the engine ATA BEFORE we move the slice in, so
        // that after the swap we can PROVE the slice was actually consumed as
        // swap input — a malicious engine must not be able to retain the
        // collateral while satisfying the SOL delta some other way.
        ctx.accounts.engine_collateral_account.reload()?;
        let engine_before = ctx.accounts.engine_collateral_account.amount;

        // ── 1. Move slice of SPL collateral out of vault to engine ATA ──
        // The engine ATA is the source the swap will draw from. We use
        // transfer_checked to also validate the mint matches.
        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.collateral_vault.to_account_info(),
                    mint: ctx.accounts.collateral_mint.to_account_info(),
                    to: ctx.accounts.engine_collateral_account.to_account_info(),
                    authority: ctx.accounts.collateral_vault.to_account_info(),
                },
                &[vault_seeds],
            ),
            slice_amount,
            collateral_decimals,
        )?;

        // [I-05 · Sec3] Sync the native wSOL proceeds vault BEFORE snapshotting
        // its balance, so any stray/un-synced lamports already sitting on the
        // account are reflected in sol_before and cannot masquerade as swap
        // proceeds in the post-swap delta.
        {
            use anchor_spl::token::{sync_native, SyncNative};
            sync_native(CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                SyncNative {
                    account: ctx.accounts.sol_proceeds_vault.to_account_info(),
                },
            ))?;
        }

        // ── 2. Snapshot sol_proceeds_vault balance BEFORE the swap ──
        // The delta after the swap is the authoritative "SOL received"
        // measurement. We don't trust whatever the swap claims to have
        // produced; we measure the vault's change.
        ctx.accounts.sol_proceeds_vault.reload()?;
        let sol_before = ctx.accounts.sol_proceeds_vault.amount;

        // ── 3. Caller-assembled swap CPI (Pattern B) ────────────────
        // remaining_accounts[0] = swap program (Jupiter / Orca / Meteora / ...)
        // remaining_accounts[1..] = swap-route accounts in the order the
        //                           swap program expects
        // swap_ix_data = serialized swap instruction the caller built off-chain
        //
        // V4 is aggregator-agnostic: it doesn't know what Jupiter looks
        // like. It just invokes whatever the caller specified and then
        // measures the result. The engine signing the V4 ix is also the
        // swap source (collateral ATA) and destination (sol_proceeds_vault),
        // so the engine's signature transitively authorizes the inner swap.
        require!(!ctx.remaining_accounts.is_empty(), ErrorCode::SwapMissing);
        {
            use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
            let swap_program = &ctx.remaining_accounts[0];
            // ── V4.1 GATE B: Swap program allowlist ──────────────────
            // Reject any swap program not in ALLOWED_SWAP_PROGRAMS.
            // Closes the malicious-router substitution class: even
            // with min_sol_out forced ≥ oracle floor, an attacker could
            // pick a swap program with a different vulnerability. The
            // allowlist is the second-layer defense.
            require!(
                is_allowed_swap_program(swap_program.key),
                ErrorCode::SwapProgramNotAllowed
            );
            let swap_accounts: Vec<AccountMeta> = ctx.remaining_accounts[1..]
                .iter()
                .map(|a| AccountMeta {
                    pubkey: *a.key,
                    is_signer: a.is_signer,
                    is_writable: a.is_writable,
                })
                .collect();
            let swap_ix = Instruction {
                program_id: *swap_program.key,
                accounts: swap_accounts,
                data: swap_ix_data,
            };
            // Pass ALL remaining_accounts (including the program itself) as
            // account infos so the runtime can find the metadata.
            anchor_lang::solana_program::program::invoke(
                &swap_ix,
                ctx.remaining_accounts,
            )?;
        }

        // [H-02/L-08 · Sec3] PROVE the slice was consumed as swap input: the
        // engine ATA must not retain the collateral we moved in. If a malicious
        // engine kept the slice and satisfied the SOL delta some other way,
        // engine_after would still hold (part of) it → reject. This closes the
        // "keep the collateral + fake the proceeds" theft even if every other
        // gate is satisfied.
        ctx.accounts.engine_collateral_account.reload()?;
        let engine_after = ctx.accounts.engine_collateral_account.amount;
        require!(engine_after <= engine_before, ErrorCode::CollateralNotConsumed);

        // ── 4. Measure SOL received + enforce slippage cap ──────────
        ctx.accounts.sol_proceeds_vault.reload()?;
        let sol_after = ctx.accounts.sol_proceeds_vault.amount;
        let sol_received: u64 = sol_after
            .checked_sub(sol_before)
            .ok_or(ErrorCode::MathOverflow)?;
        require!(sol_received >= min_sol_out, ErrorCode::SlippageExceeded);

        // ── 5. Skim 1% protocol fee ─────────────────────────────────
        // [I-06 · Sec3] Round the fee UP so tiny conversions cannot avoid it
        // (floor division yielded 0 for sol_received < 100 lamports).
        let protocol_fee: u64 = (sol_received as u128)
            .checked_mul(PROTOCOL_FEE_BPS_AUTOSELL as u128)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_add((BPS_DENOM as u128) - 1)
            .ok_or(ErrorCode::MathOverflow)?
            .checked_div(BPS_DENOM as u128)
            .ok_or(ErrorCode::MathOverflow)? as u64;

        if protocol_fee > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.loan_token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.sol_proceeds_vault.to_account_info(),
                        to: ctx.accounts.fee_wallet.to_account_info(),
                        authority: ctx.accounts.collateral_vault.to_account_info(),
                    },
                    &[vault_seeds],
                ),
                protocol_fee,
            )?;
        }

        let net_sol_to_vault: u64 = sol_received
            .checked_sub(protocol_fee)
            .ok_or(ErrorCode::MathOverflow)?;

        // ── 6. Update loan state ────────────────────────────────────
        let loan = &mut ctx.accounts.loan;
        loan.current_collateral_amount = loan
            .current_collateral_amount
            .checked_sub(slice_amount)
            .ok_or(ErrorCode::MathOverflow)?;
        loan.sol_proceeds_amount = loan
            .sol_proceeds_amount
            .checked_add(net_sol_to_vault)
            .ok_or(ErrorCode::MathOverflow)?;
        loan.auto_sells_fired = loan.auto_sells_fired.saturating_add(1);
        // [Q-04 · Sec3] Consume the borrower's cumulative allowance. Saturating
        // so this can never wrap and silently hand back fresh headroom; the
        // authorization check above is what actually gates the next fire, and
        // only a new arm/disarm resets it.
        loan.armed_converted_bps = loan.armed_converted_bps.saturating_add(slice_bps);

        // ── 7. Emit ─────────────────────────────────────────────────
        emit!(CollateralConverted {
            loan: loan_key,
            slice_bps,
            slice_amount_sold: slice_amount,
            sol_received_gross: sol_received,
            protocol_fee,
            net_sol_to_vault,
            remaining_collateral: loan.current_collateral_amount,
            total_sol_proceeds: loan.sol_proceeds_amount,
            auto_sells_fired: loan.auto_sells_fired,
        });

        Ok(())
    }

    /// [H-02 · Sec3] BORROWER-signed: arm an auto-sell trigger on this loan.
    /// This is the on-chain borrower CONSENT that gates
    /// `convert_collateral_slice` — without an armed trigger (or an overdue
    /// loan) the engine cannot move a single token of collateral. The borrower
    /// chooses the price, direction (take-profit / stop-loss), and per-fire
    /// slice cap; the off-chain engine merely executes what the borrower armed.
    pub fn arm_conversion(
        ctx: Context<ArmConversion>,
        trigger_price: u64,
        direction: u8,
        max_slice_bps: u16,
        total_bps: u16,
    ) -> Result<()> {
        let loan = &mut ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);
        // [H-02 · Sec3, 2nd review] An overdue loan stays Active until it is
        // repaid or liquidated, but `convert_collateral_slice` authorizes every
        // overdue loan through `overdue || trigger_ok` — so past expiry the
        // trigger configuration no longer restricts the engine at all. Allowing
        // it to be set anyway would succeed while doing nothing, and emit a
        // configuration event implying protection the borrower does not have.
        // Reject it instead, so the failure is visible rather than silent.
        require!(
            trigger_config_allowed(Clock::get()?.unix_timestamp, loan.due_timestamp),
            ErrorCode::LoanOverdue
        );
        require!(trigger_price > 0, ErrorCode::InvalidTrigger);
        require!(direction <= 1, ErrorCode::InvalidTrigger);
        require!(
            max_slice_bps > 0 && max_slice_bps <= SLICE_BPS_MAX,
            ErrorCode::InvalidTrigger
        );
        // A total below the per-fire cap would be incoherent, and a total above
        // 100% of the original collateral is meaningless.
        require!(
            total_bps >= max_slice_bps && total_bps <= SLICE_BPS_MAX,
            ErrorCode::InvalidTrigger
        );
        loan.armed_trigger_price = trigger_price;
        loan.armed_trigger_direction = direction;
        loan.armed_max_slice_bps = max_slice_bps;
        loan.armed_total_bps = total_bps;
        // [Q-04] A new arming is a new authorization: the cumulative allowance
        // starts fresh.
        loan.armed_converted_bps = 0;
        emit!(ConversionArmed {
            loan: loan.key(),
            borrower: loan.borrower,
            trigger_price,
            direction,
            max_slice_bps,
            total_bps,
        });
        Ok(())
    }

    /// [H-02 · Sec3] BORROWER-signed: disarm the auto-sell trigger, returning
    /// the loan to the "engine cannot convert" default.
    pub fn disarm_conversion(ctx: Context<DisarmConversion>) -> Result<()> {
        let loan = &mut ctx.accounts.loan;
        require!(loan.status == LoanStatus::Active, ErrorCode::LoanNotActive);
        // [H-02 · Sec3, 2nd review] Same reasoning as arm_conversion: once the
        // loan is overdue the trigger no longer gates the engine, so disarming
        // would give the borrower a false sense of having withdrawn consent.
        require!(
            trigger_config_allowed(Clock::get()?.unix_timestamp, loan.due_timestamp),
            ErrorCode::LoanOverdue
        );
        loan.armed_trigger_price = 0;
        loan.armed_trigger_direction = 0;
        loan.armed_max_slice_bps = 0;
        loan.armed_total_bps = 0;
        loan.armed_converted_bps = 0;
        emit!(ConversionDisarmed {
            loan: loan.key(),
            borrower: loan.borrower,
        });
        Ok(())
    }

    /// [L-02 · Sec3] On-chain recovery of residual SPL collateral value.
    /// `liquidate_loan` sends any unsold SPL collateral to the pool authority
    /// for off-chain sale; before this instruction there was no on-chain path
    /// to return the resulting value to LPs, so an off-chain SPL sale stayed
    /// OUTSIDE the accounting used to price LP shares (LPs bore a full on-chain
    /// write-off until a voluntary, unreconciled transfer). This instruction
    /// deposits the recovered wSOL proceeds into the pool's loan_token_vault
    /// and credits `total_deposits` WITHOUT minting shares — so the recovered
    /// value accrues to EXISTING LP shares, linked on-chain to the liquidated
    /// loan. Authority-only, and it only ever ADDS the authority's own tokens
    /// to the pool.
    pub fn recover_liquidated_collateral(
        ctx: Context<RecoverLiquidatedCollateral>,
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(
            ctx.accounts.loan.status == LoanStatus::Liquidated,
            ErrorCode::LoanNotLiquidated
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.pool.authority,
            ErrorCode::Unauthorized
        );

        // Move the recovered wSOL from the authority into the pool vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.loan_token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.authority_loan_token_account.to_account_info(),
                    to: ctx.accounts.loan_token_vault.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount,
        )?;

        // Credit LP equity WITHOUT minting new shares → the recovered value
        // raises the per-share price for existing LPs.
        let loan_key = ctx.accounts.loan.key();
        let pool = &mut ctx.accounts.pool;
        pool.total_deposits = pool
            .total_deposits
            .checked_add(amount)
            .ok_or(ErrorCode::MathOverflow)?;

        emit!(LiquidationRecovered {
            pool: pool.key(),
            loan: loan_key,
            amount,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Accounts (context structs)
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + LendingPool::INIT_SPACE,
        seeds = [b"pool", authority.key().as_ref()],
        bump,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        init,
        payer = authority,
        token::mint = loan_token_mint,
        token::authority = pool,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    /// [I-01 · Sec3] The loan token must be the canonical Wrapped SOL mint.
    #[account(address = WSOL_MINT @ ErrorCode::WrongWsolMint)]
    pub loan_token_mint: Account<'info, Mint>,

    /// Protocol fee destination: a wSOL token account. Recorded on the pool
    /// as `fee_wallet`; every later fee transfer is constrained to it.
    #[account(constraint = fee_wallet.mint == loan_token_mint.key() @ ErrorCode::InvalidFeeWallet)]
    pub fee_wallet: Account<'info, TokenAccount>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,
    pub authority: Signer<'info>,
}

/// Authority-only rotation of engine_authority / fee_wallet.
#[derive(Accounts)]
pub struct SetPoolConfig<'info> {
    #[account(
        mut,
        has_one = authority @ ErrorCode::Unauthorized,
    )]
    pub pool: Account<'info, LendingPool>,
    pub authority: Signer<'info>,
    /// New protocol fee destination. Must be a token account of the pool's
    /// loan token mint (wSOL). Pass the current one to leave it unchanged.
    #[account(constraint = fee_wallet.mint == pool.loan_token_mint @ ErrorCode::InvalidFeeWallet)]
    pub fee_wallet: Account<'info, TokenAccount>,
}

#[derive(Accounts)]
pub struct AdminWithdraw<'info> {
    #[account(
        mut,
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    /// Authority's wSOL token account to receive the funds.
    #[account(
        mut,
        constraint = authority_token_account.owner == authority.key(),
        constraint = authority_token_account.mint == pool.loan_token_mint,
    )]
    pub authority_token_account: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct InitializePriceFeed<'info> {
    #[account(
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    /// Accept both legacy Token and Token-2022 mints.
    pub mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        init,
        payer = authority,
        space = 8 + PriceHistory::INIT_SPACE,
        seeds = [b"price_v3", mint.key().as_ref(), pool.key().as_ref()],
        bump,
    )]
    pub price_feed: Account<'info, PriceHistory>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdatePrice<'info> {
    #[account(
        has_one = authority,
    )]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"price_v3", price_feed.mint.as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
        constraint = price_feed.authority == authority.key() @ ErrorCode::Unauthorized,
    )]
    pub price_feed: Account<'info, PriceHistory>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = depositor,
        space = 8 + DepositorPosition::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), depositor.key().as_ref()],
        bump,
    )]
    pub position: Account<'info, DepositorPosition>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == pool.loan_token_mint,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [b"position", pool.key().as_ref(), depositor.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == depositor.key() @ ErrorCode::Unauthorized,
    )]
    pub position: Account<'info, DepositorPosition>,

    #[account(
        mut,
        constraint = depositor_token_account.owner == depositor.key(),
        constraint = depositor_token_account.mint == pool.loan_token_mint,
    )]
    pub depositor_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub depositor: Signer<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(collateral_amount: u64, loan_option: u8, collateral_value: u64, loan_id: u64, category: u8)]
pub struct RequestLoan<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, LendingPool>>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Box<Account<'info, TokenAccount>>,

    #[account(
        init,
        payer = borrower,
        space = 8 + Loan::INIT_SPACE,
        seeds = [b"loan", borrower.key().as_ref(), &loan_id.to_le_bytes()],
        bump,
    )]
    pub loan: Box<Account<'info, Loan>>,

    #[account(
        init,
        payer = borrower,
        token::mint = collateral_mint,
        token::authority = collateral_vault,
        token::token_program = token_program,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    // Constraints moved to handler body to reduce try_accounts() stack frame.
    // Anchor's auto-generated try_accounts otherwise overflows 4 KB on BPF.
    #[account(mut)]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(mut)]
    pub borrower_loan_token_account: Box<Account<'info, TokenAccount>>,

    /// Wave 3 (2026-06-15): hardcoded `address` constraint closes the
    /// V4 audit finding that a borrower could pass their own wSOL ATA
    /// here as fee_wallet and keep the 1% extension fee. Now restricted
    /// to the pool-configured fee wallet only.
    #[account(
        mut,
        address = pool.fee_wallet @ ErrorCode::InvalidFeeWallet,
    )]
    pub fee_wallet_token_account: Box<Account<'info, TokenAccount>>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    /// Pool authority must co-sign every borrow to attest the collateral value.
    pub authority: Signer<'info>,

    /// On-chain price attestation for the collateral mint. PDA seeds already
    /// enforce mint+pool linkage so duplicate constraints removed.
    #[account(
        seeds = [b"price_v3", collateral_mint.key().as_ref(), pool.key().as_ref()],
        bump = price_feed.bump,
    )]
    pub price_feed: Box<Account<'info, PriceHistory>>,

    pub system_program: Program<'info, System>,
    /// Used for collateral vault init + collateral transfers. Accepts both
    /// legacy SPL Token and Token-2022 mints.
    pub token_program: Interface<'info, TokenInterface>,
    /// Used for loan token (wSOL) transfers from pool vault. Always legacy.
    pub loan_token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RepayLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_collateral_account.owner == borrower.key(),
        constraint = borrower_collateral_account.mint == loan.collateral_mint,
    )]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    /// v4 — wSOL vault where auto-sell proceeds accumulate. Initialized
    /// lazily on first convert_collateral_slice; here in repay it gets
    /// drained back to the borrower along with any remaining SPL.
    /// Authority = collateral_vault PDA (same seeds as the SPL vault),
    /// so the program can sign for withdrawals using vault_seeds.
    ///
    /// Wave 5 C1 (2026-06-15): `init_if_needed` so V4 loans whose
    /// auto-sell never fired (price never hit trigger) can still be
    /// repaid. Without this, every never-fired V4 loan is unrepayable
    /// — sol_proceeds_vault is only init'd lazily inside
    /// convert_collateral_slice, so a loan that didn't auto-sell has
    /// no vault account and Anchor fails with AccountNotInitialized
    /// (3012) at repay time. wsol_mint param added below for the init.
    /// Borrower pays the small ATA rent (~0.002 SOL); on close path
    /// the rent is recovered.
    #[account(
        init_if_needed,
        payer = borrower,
        seeds = [b"sol-proceeds", loan.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = collateral_vault,
        // Wave 5 C1.1 (2026-06-15 PM): explicitly bind the init token
        // program to `loan_token_program` (classic SPL Token). Without
        // this, Anchor's default field-name resolution picks the field
        // NAMED `token_program` — the Interface field — which carries
        // the COLLATERAL token program. For Token-2022 collateral
        // (Token-2022 collateral mints) that's Token-2022, but the wSOL mint
        // used in this constraint is owned by classic SPL Token, so
        // Token-2022's `InitializeAccount3` rejects with IncorrectProgramId
        // (the live failure mode operator hit on loan 763). For classic
        // SPL memecoins this constraint is a no-op (loan_token_program
        // and token_program resolve to the same pubkey) — provable
        // additive change. Permanently unblocks Token-2022 + in-vault
        // exits per the V4 in-vault thesis.
        token::token_program = loan_token_program,
    )]
    pub sol_proceeds_vault: Account<'info, TokenAccount>,

    /// wSOL mint (canonical pubkey So11111…). Used to gate the
    /// init_if_needed on sol_proceeds_vault. Read-only.
    /// [I-01 · Sec3] Pinned to the canonical Wrapped SOL mint.
    #[account(address = WSOL_MINT @ ErrorCode::WrongWsolMint)]
    pub wsol_mint: Account<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub loan_token_program: Program<'info, Token>,
    /// Wave 5 C1 — needed because init_if_needed allocates a new
    /// account, which requires the system_program to be passed.
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// v4 — convert a slice of SPL collateral to SOL and store in vault.
/// Engine-authority signer only. Caller-assembled swap CPI via
/// remaining_accounts (Pattern B — aggregator-agnostic).
#[derive(Accounts)]
pub struct ConvertCollateralSlice<'info> {
    #[account(
        mut,
        has_one = collateral_mint,
        constraint = loan.status == LoanStatus::Active @ ErrorCode::LoanNotActive,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint (for transfer_checked decimals + Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    /// SPL collateral vault — source of the slice being sold.
    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// wSOL vault — destination for swap proceeds. Initialized lazily so
    /// loans that never auto-sell don't pay the rent overhead. Authority
    /// is the collateral_vault PDA (program-signed via vault_seeds).
    /// The mint MUST be native wSOL — checked by the constraint.
    #[account(
        init_if_needed,
        payer = engine,
        seeds = [b"sol-proceeds", loan.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = collateral_vault,
        // Wave 5 C1.1 (2026-06-15 PM): see RepayLoan above for the
        // full explanation. Same bug existed here; engine's first
        // convert_collateral_slice would fail for Token-2022 collateral
        // for the same Anchor field-resolution reason. Without this
        // constraint, every never-fired V4 Token-2022 loan would stay
        // in init limbo on the convert path too.
        token::token_program = loan_token_program,
    )]
    pub sol_proceeds_vault: Account<'info, TokenAccount>,

    /// Engine's SPL ATA — receives the slice that the swap will then
    /// consume. Owner must be the engine signer. Mint must match the
    /// loan's collateral mint.
    #[account(
        mut,
        constraint = engine_collateral_account.owner == engine.key(),
        constraint = engine_collateral_account.mint == loan.collateral_mint,
    )]
    pub engine_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Fee wallet (same wSOL ATA the borrow-side fee flows to).
    /// Wave 3 (2026-06-15): hardcoded `address` constraint closes the
    /// V4 audit finding that a compromised engine key could route the
    /// 1% protocol skim to any TokenAccount. Now restricted to the
    /// pool-configured fee wallet only.
    #[account(
        mut,
        address = pool.fee_wallet @ ErrorCode::InvalidFeeWallet,
    )]
    pub fee_wallet: Account<'info, TokenAccount>,

    /// wSOL mint (canonical pubkey So11111...). Used to gate the
    /// sol_proceeds_vault init.
    /// [I-01 · Sec3] Pinned to the canonical Wrapped SOL mint.
    #[account(address = WSOL_MINT @ ErrorCode::WrongWsolMint)]
    pub wsol_mint: Account<'info, Mint>,

    /// Engine authority — the ONLY pubkey allowed to call this.
    /// Constraint compares against the pool-configured
    /// `LendingPool.engine_authority`; this is the least-privilege seam.
    #[account(
        mut,
        address = pool.engine_authority @ ErrorCode::EngineUnauthorized,
    )]
    pub engine: Signer<'info>,

    /// V4.1 ANTI-DRAIN: price history PDA for the loan's collateral
    /// mint. The program reads the latest sample to compute the oracle
    /// floor on `min_sol_out`. The seeds must match the engine-managed
    /// price feed for the collateral mint + pool.
    #[account(
        seeds = [b"price_v3", loan.collateral_mint.as_ref(), pool.key().as_ref()],
        bump = price_history.bump,
        constraint = price_history.mint == loan.collateral_mint @ ErrorCode::OracleMintMismatch,
        constraint = price_history.pool == pool.key() @ ErrorCode::OraclePoolMismatch,
    )]
    pub price_history: Account<'info, PriceHistory>,

    /// Pool reference for the price_history PDA derivation. Read-only.
    /// [L-05 · Sec3] Bind the pool to the loan's own pool. Without this, the
    /// oracle floor could be computed from a DIFFERENT pool's price feed for the
    /// same collateral mint (an attacker-initialized pool priced near zero),
    /// letting the slice be sold near zero while still passing the floor check.
    #[account(constraint = pool.key() == loan.pool @ ErrorCode::PoolMismatch)]
    pub pool: Account<'info, LendingPool>,

    pub token_program: Interface<'info, TokenInterface>,
    pub loan_token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct PartialRepay<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
    )]
    pub loan: Account<'info, Loan>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AddCollateral<'info> {
    #[account(
        mut,
        has_one = borrower,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(
        mut,
        constraint = borrower_collateral_account.owner == borrower.key(),
        constraint = borrower_collateral_account.mint == loan.collateral_mint,
    )]
    pub borrower_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
}

/// [H-02 · Sec3] Borrower arms/disarms the on-chain auto-sell trigger. Only
/// the loan's borrower can sign (has_one = borrower); no engine/authority key
/// can arm on the borrower's behalf.
#[derive(Accounts)]
pub struct ArmConversion<'info> {
    #[account(mut, has_one = borrower)]
    pub loan: Account<'info, Loan>,
    pub borrower: Signer<'info>,
}

#[derive(Accounts)]
pub struct DisarmConversion<'info> {
    #[account(mut, has_one = borrower)]
    pub loan: Account<'info, Loan>,
    pub borrower: Signer<'info>,
}

/// [L-02 · Sec3] Pool authority returns off-chain SPL-sale proceeds to the LPs.
#[derive(Accounts)]
pub struct RecoverLiquidatedCollateral<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    /// The liquidated loan this recovery is reconciled against. Bound to the
    /// pool; must be in the Liquidated terminal state.
    #[account(
        has_one = pool,
        constraint = loan.status == LoanStatus::Liquidated @ ErrorCode::LoanNotLiquidated,
    )]
    pub loan: Account<'info, Loan>,

    /// Pool's loan-token (wSOL) vault — destination for the recovered value.
    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    /// Pool authority — the only signer allowed (checked == pool.authority).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// Authority's wSOL source account holding the off-chain sale proceeds.
    #[account(
        mut,
        constraint = authority_loan_token_account.owner == authority.key(),
        constraint = authority_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub authority_loan_token_account: Account<'info, TokenAccount>,

    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ExtendLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = borrower,
        has_one = pool,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// [M-01 · Sec3] Collateral mint — supplies decimals for the on-chain
    /// health check. Bound to the loan via `has_one = collateral_mint` above.
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    /// [M-01 · Sec3] Price feed for the on-chain collateral health check.
    /// Pool-bound (same pattern as ConvertCollateralSlice, per L-05) so a
    /// foreign pool's price feed can't be substituted. Read-only.
    #[account(
        seeds = [b"price_v3", loan.collateral_mint.as_ref(), pool.key().as_ref()],
        bump = price_history.bump,
        constraint = price_history.mint == loan.collateral_mint @ ErrorCode::OracleMintMismatch,
        constraint = price_history.pool == pool.key() @ ErrorCode::OraclePoolMismatch,
    )]
    pub price_history: Account<'info, PriceHistory>,

    #[account(
        mut,
        constraint = borrower_loan_token_account.owner == borrower.key(),
        constraint = borrower_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub borrower_loan_token_account: Account<'info, TokenAccount>,

    /// Wave 5 C4 (2026-06-15): hardcoded `address` constraint closes
    /// the audit finding — without it a borrower extending their V4
    /// loan could pass own wSOL ATA and keep the 1% extension fee.
    /// Now restricted to the pool-configured fee wallet only.
    /// (Wave 3 added this to RequestLoan + ConvertCollateralSlice but
    /// MISSED ExtendLoan — caught in the post-Wave-4 final audit.)
    #[account(
        mut,
        address = pool.fee_wallet @ ErrorCode::InvalidFeeWallet,
    )]
    pub fee_wallet_token_account: Account<'info, TokenAccount>,

    #[account(mut)]
    pub borrower: Signer<'info>,

    /// [M-01 · Sec3] Pool authority co-signer — OPTIONAL. Required (and must
    /// equal pool.authority) ONLY when the loan is not provably healthy
    /// on-chain (stale price, or current LTV above the loan's LTV). A healthy
    /// loan self-extends without it, so a malicious authority cannot grief a
    /// healthy borrower toward liquidation by withholding a signature.
    pub authority: Option<Signer<'info>>,

    pub loan_token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LiquidateLoan<'info> {
    #[account(mut)]
    pub pool: Account<'info, LendingPool>,

    /// [L-02 · Sec3] Pool loan-token vault. Recovered wSOL proceeds are routed
    /// back HERE and credited to LP equity, instead of being paid out to the
    /// authority — so LPs recover the reconcilable portion of the debt on-chain
    /// rather than taking a full write-off.
    #[account(
        mut,
        seeds = [b"loan-token-vault", pool.key().as_ref()],
        bump = pool.vault_bump,
    )]
    pub loan_token_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        has_one = pool,
        has_one = collateral_mint,
    )]
    pub loan: Account<'info, Loan>,

    /// Collateral mint — needed for transfer_checked (Token-2022 compat).
    pub collateral_mint: Box<InterfaceAccount<'info, MintIfc>>,

    #[account(
        mut,
        seeds = [b"collateral-vault", loan.key().as_ref()],
        bump = loan.vault_bump,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Keeper's token account — receives the keeper bounty portion
    #[account(
        mut,
        constraint = keeper_collateral_account.owner == keeper.key(),
        constraint = keeper_collateral_account.mint == loan.collateral_mint,
    )]
    pub keeper_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// Authority's token account — receives the remaining collateral
    #[account(
        mut,
        constraint = authority_collateral_account.owner == pool.authority,
        constraint = authority_collateral_account.mint == loan.collateral_mint,
    )]
    pub authority_collateral_account: Box<InterfaceAccount<'info, TokenAccountIfc>>,

    /// v4 — sol_proceeds_vault holding accumulated SOL from auto-sells.
    /// Same seeds + authority pattern as the SPL collateral vault.
    /// Wave 5 C1 (2026-06-15): `init_if_needed` so V4 loans whose
    /// auto-sell never fired can still be liquidated. Keeper pays the
    /// small ATA rent (~0.002 SOL); recovered on the close path.
    #[account(
        init_if_needed,
        payer = keeper,
        seeds = [b"sol-proceeds", loan.key().as_ref()],
        bump,
        token::mint = wsol_mint,
        token::authority = collateral_vault,
        // Wave 5 C1.1 (2026-06-15 PM): same Anchor field-resolution
        // fix as RepayLoan + ConvertCollateralSlice. Without it,
        // liquidation of a never-fired Token-2022 V4 loan would fail
        // for the same reason repay failed — Token-2022 invoked to
        // init a wSOL account it doesn't own.
        token::token_program = loan_token_program,
    )]
    pub sol_proceeds_vault: Account<'info, TokenAccount>,

    /// v4 — keeper's wSOL ATA for the SOL-pot bounty.
    #[account(
        mut,
        constraint = keeper_loan_token_account.owner == keeper.key(),
        constraint = keeper_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub keeper_loan_token_account: Account<'info, TokenAccount>,

    /// v4 — authority's wSOL ATA for the SOL-pot residual.
    #[account(
        mut,
        constraint = authority_loan_token_account.owner == pool.authority,
        constraint = authority_loan_token_account.mint == pool.loan_token_mint,
    )]
    pub authority_loan_token_account: Account<'info, TokenAccount>,

    /// The keeper (liquidator) — permissionless, any wallet can sign
    #[account(mut)]
    pub keeper: Signer<'info>,

    /// wSOL mint — needed by the `init_if_needed` on sol_proceeds_vault.
    /// [I-01 · Sec3] Pinned to the canonical Wrapped SOL mint.
    #[account(address = WSOL_MINT @ ErrorCode::WrongWsolMint)]
    pub wsol_mint: Account<'info, Mint>,

    pub token_program: Interface<'info, TokenInterface>,
    pub loan_token_program: Program<'info, Token>,
    /// Wave 5 C1 — required by init_if_needed on sol_proceeds_vault.
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct LendingPool {
    /// Pool creator / admin
    pub authority: Pubkey,
    /// PDA token account holding wSOL for loans
    pub loan_token_vault: Pubkey,
    /// Mint of the loan token (wSOL)
    pub loan_token_mint: Pubkey,
    /// Protocol's cut of fees in basis points (e.g. 2000 = 20%)
    pub protocol_fee_bps: u16,
    /// Keeper reward for liquidations in basis points (e.g. 500 = 5% of collateral)
    pub keeper_reward_bps: u16,
    /// Total wSOL deposited by liquidity providers
    pub total_deposits: u64,
    /// Total outstanding shares
    pub total_shares: u64,
    /// Total wSOL currently lent out
    pub total_borrowed: u64,
    /// Cumulative fees earned
    pub total_fees_earned: u64,
    /// [L-03 · Sec3] LP-retained fees (pool_cut) that are NOT yet withdrawable
    /// because their originating loan is still outstanding. Held out of
    /// total_deposits (LP share value) until the loan repays or liquidates, so
    /// an LP cannot exit early with a fee whose loan later defaults.
    pub pending_fees: u64,
    /// Cumulative loans issued
    pub total_loans_issued: u64,
    /// Cumulative liquidations
    pub total_liquidations: u64,
    /// Whether new borrows are paused
    pub paused: bool,
    /// PDA bump
    pub bump: u8,
    /// Vault PDA bump
    pub vault_bump: u8,
    /// The ONLY signer allowed to call convert_collateral_slice. Set at
    /// initialize_pool, rotatable by the pool authority via set_pool_config.
    pub engine_authority: Pubkey,
    /// wSOL token account that receives the 1% protocol fee (auto-sell skim
    /// + extend_loan fee). Set at initialize_pool, rotatable via
    /// set_pool_config. Every fee-destination account is constrained to it.
    pub fee_wallet: Pubkey,
}

/// One sample in the rolling price history. Compact 16-byte layout.
#[derive(AnchorSerialize, AnchorDeserialize, Copy, Clone, InitSpace)]
pub struct PriceSample {
    pub price_lamports: u64,
    pub timestamp: i64,
}

/// Rolling ring buffer of price samples per mint. Replaces the v2
/// `PriceHistory` single-spot design. TWAP is computed over the
/// samples within `TWAP_WINDOW_SECONDS`; samples outside the window
/// remain in the buffer (so we don't lose capacity) but are excluded
/// from the average.
///
/// Updates are append-only at `head_index`, which wraps around. After
/// the buffer fills once, `count = PRICE_HISTORY_CAPACITY` and
/// `head_index` keeps advancing modulo capacity (oldest slot is
/// overwritten next). Order in the array is not chronological after
/// wrap — readers must use `head_index` + `count` to walk it.
#[account]
#[derive(InitSpace)]
pub struct PriceHistory {
    /// Token mint this history covers
    pub mint: Pubkey,
    /// Pool this history belongs to
    pub pool: Pubkey,
    /// Authority allowed to append samples
    pub authority: Pubkey,
    /// Index of the slot that will receive the NEXT sample (wraps).
    pub head_index: u8,
    /// How many slots in `samples` are populated (caps at capacity).
    pub count: u8,
    /// Reserved for future use / forces alignment.
    pub _padding: [u8; 6],
    /// Ring buffer of samples. Newest sample lives at
    /// `samples[(head_index - 1 + capacity) % capacity]` when count > 0.
    pub samples: [PriceSample; PRICE_HISTORY_CAPACITY],
    /// PDA bump
    pub bump: u8,
}

impl PriceHistory {
    /// Return the most recent sample, or None if the buffer is empty.
    pub fn latest(&self) -> Option<PriceSample> {
        if self.count == 0 {
            return None;
        }
        let cap = PRICE_HISTORY_CAPACITY as u8;
        let idx = ((self.head_index + cap - 1) % cap) as usize;
        Some(self.samples[idx])
    }

    /// Compute the time-weighted average price over `TWAP_WINDOW_SECONDS`,
    /// ending at `now`. Returns:
    ///   Some((twap, samples_used, oldest_sample_age_seconds))
    ///   None if fewer than MIN_SAMPLES_FOR_TWAP fall inside the window.
    ///
    /// Weighting: each sample's price is weighted by the time-gap to the
    /// NEXT sample (or `now` for the most recent). This is a standard
    /// time-weighted average — a price that held for 10 min counts more
    /// than one that held for 30 sec.
    pub fn twap(&self, now: i64) -> Option<(u128, u8, i64)> {
        if self.count == 0 {
            return None;
        }
        let cap = PRICE_HISTORY_CAPACITY as u8;

        // Collect samples in chronological order from oldest to newest.
        let mut ordered: [PriceSample; PRICE_HISTORY_CAPACITY] =
            [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        let mut n = 0usize;
        // Start at the slot just AFTER head (oldest slot when buffer full).
        let start = if self.count >= cap {
            self.head_index as usize
        } else {
            0
        };
        let cnt = self.count as usize;
        for i in 0..cnt {
            let idx = (start + i) % (PRICE_HISTORY_CAPACITY);
            ordered[n] = self.samples[idx];
            n += 1;
        }

        // Filter to window: keep samples with timestamp >= now - WINDOW.
        // [L-01 · Sec3] Also remember the last sample BEFORE the cutoff so its
        // price can be carried forward into the window (see below).
        let cutoff = now.saturating_sub(TWAP_WINDOW_SECONDS);
        let mut carry: Option<PriceSample> = None;
        let mut in_window: [PriceSample; PRICE_HISTORY_CAPACITY] =
            [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY];
        let mut k = 0usize;
        for i in 0..n {
            if ordered[i].timestamp >= cutoff {
                in_window[k] = ordered[i];
                k += 1;
            } else {
                // `ordered` is chronological, so the last sample below the
                // cutoff is the price that was active going INTO the window.
                carry = Some(ordered[i]);
            }
        }

        // [L-01 · Sec3] The minimum-history gate must count DISTINCT,
        // time-separated observations — clustered same-timestamp samples
        // contribute no weight and must not satisfy MIN_SAMPLES_FOR_TWAP.
        let mut distinct = 0usize;
        for i in 0..k {
            if i == 0 || in_window[i].timestamp != in_window[i - 1].timestamp {
                distinct += 1;
            }
        }
        if distinct < MIN_SAMPLES_FOR_TWAP as usize {
            return None;
        }

        // Time-weighted sum. [L-01 · Sec3] If a pre-window price exists, it held
        // from the cutoff until the first in-window sample — include that
        // interval so the average reflects the whole window, not just from the
        // first in-window update onward (which would overstate a late spike).
        let mut weighted: u128 = 0;
        let mut total_weight: i64 = 0;
        let coverage_start = if carry.is_some() { cutoff } else { in_window[0].timestamp };
        if let Some(c) = carry {
            let weight = in_window[0].timestamp.saturating_sub(cutoff).max(0);
            if weight > 0 {
                weighted = weighted.saturating_add(
                    (c.price_lamports as u128).saturating_mul(weight as u128),
                );
                total_weight = total_weight.saturating_add(weight);
            }
        }
        for i in 0..k {
            let end = if i + 1 < k {
                in_window[i + 1].timestamp
            } else {
                now
            };
            let weight = end.saturating_sub(in_window[i].timestamp).max(0);
            if weight == 0 {
                continue;
            }
            weighted = weighted.saturating_add(
                (in_window[i].price_lamports as u128).saturating_mul(weight as u128),
            );
            total_weight = total_weight.saturating_add(weight);
        }
        if total_weight <= 0 {
            return None;
        }
        let twap = weighted / total_weight as u128;
        let oldest_age = now.saturating_sub(coverage_start);
        Some((twap, distinct as u8, oldest_age))
    }

    /// Append a new sample at head_index (wrap-around).
    pub fn append(&mut self, sample: PriceSample) {
        let cap = PRICE_HISTORY_CAPACITY as u8;
        self.samples[self.head_index as usize] = sample;
        self.head_index = (self.head_index + 1) % cap;
        if self.count < cap {
            self.count += 1;
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct DepositorPosition {
    /// Depositor wallet
    pub owner: Pubkey,
    /// Which pool this position belongs to
    pub pool: Pubkey,
    /// Pool shares held
    pub shares: u64,
    /// Cumulative amount deposited (for UI/analytics)
    pub deposited_amount: u64,
    /// Last deposit timestamp
    pub last_deposit_ts: i64,
    /// PDA bump
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Loan {
    /// Unique identifier
    pub loan_id: u64,
    /// Borrower's wallet
    pub borrower: Pubkey,
    /// Pool this loan was issued from
    pub pool: Pubkey,
    /// Collateral token mint
    pub collateral_mint: Pubkey,
    /// PDA vault holding collateral
    pub collateral_vault: Pubkey,
    /// Collateral amount locked (raw units)
    pub collateral_amount: u64,
    /// Net loan amount borrower received
    pub loan_amount: u64,
    /// Amount borrower must repay (decreases with partial repayments)
    pub repay_amount: u64,
    /// Fee charged at origination
    pub transaction_fee: u64,
    /// LTV in basis points. Memecoin: 2000/2500/3000.
    /// RWA: 5000/6000/7000. Tier resolved within the loan's category.
    pub ltv_bps: u16,
    /// Loan duration in days
    pub duration_days: u8,
    /// When loan was funded
    pub start_timestamp: i64,
    /// When repayment is due
    pub due_timestamp: i64,
    /// Loan status
    pub status: LoanStatus,
    /// Collateral value at loan creation (in loan token units)
    pub collateral_value_at_start: u64,
    /// PDA bump for loan account
    pub bump: u8,
    /// PDA bump for collateral vault
    pub vault_bump: u8,
    /// Loan category (0 = memecoin, 1 = RWA). Used by extend_loan to
    /// pick the right tier ladder without a round-trip to off-chain
    /// metadata.
    pub category: u8,
    // ── v4 additions: in-vault auto-sell state ──────────────────────
    /// SPL collateral remaining in the vault. Equals collateral_amount
    /// at borrow time, decreases as convert_collateral_slice fires.
    /// Reaches 0 when the position is fully auto-sold. At repay /
    /// liquidation time, whatever is here gets returned to the borrower
    /// (alongside sol_proceeds_amount).
    pub current_collateral_amount: u64,
    /// SOL accumulated from auto-sells (in lamports, net of the 1%
    /// protocol fee). Sits in a vault-owned wSOL token account whose
    /// authority is the loan's collateral_vault PDA, so the engine
    /// can credit it on conversions but only the borrower can claim it
    /// (via repay) or the keeper can claim it (via liquidate).
    pub sol_proceeds_amount: u64,
    /// Number of times convert_collateral_slice has fired against this
    /// loan. Diagnostics only — no contract invariant depends on it.
    pub auto_sells_fired: u8,
    /// [L-03 · Sec3] LP-retained fee (pool_cut) this loan has accrued at
    /// origination + each extension. Held in pool.pending_fees while the loan is
    /// active; realized into pool.total_deposits when the loan repays or
    /// liquidates. Prevents LPs from withdrawing unearned fee before the loan
    /// resolves.
    pub accrued_pool_fees: u64,
    // ── [H-02 · Sec3] borrower-armed auto-sell trigger ──────────────
    /// Borrower-armed trigger price (lamports per WHOLE collateral token,
    /// same unit as the price feed). `convert_collateral_slice` may fire
    /// ONLY when the loan is overdue OR this trigger is armed (> 0) AND the
    /// current price has reached it. A compromised engine cannot force-sell
    /// a healthy, un-armed loan. 0 = disarmed.
    pub armed_trigger_price: u64,
    /// Direction of the armed trigger: 0 = take-profit (fire when spot price
    /// RISES to >= armed_trigger_price — captures upside spikes), 1 =
    /// stop-loss (fire when spot price FALLS to <= armed_trigger_price).
    /// Ignored while disarmed.
    pub armed_trigger_direction: u8,
    /// Max slice (bps of ORIGINAL collateral) the engine may convert per fire
    /// under the armed order. A single conversion cannot exceed this. The
    /// engine still cannot exceed the remaining collateral. 0 while disarmed.
    pub armed_max_slice_bps: u16,
    /// [Q-04 · Sec3] TOTAL bps of original collateral the engine may convert
    /// across ALL fires under the current arming. This is deliberately separate
    /// from `armed_max_slice_bps`: that one bounds a SINGLE fire, this one
    /// bounds the aggregate. Collapsing the two would have capped a ladder at
    /// its largest leg — a 70/20/10 take-profit ladder needs a 70% per-fire cap
    /// but 100% of total authorization — so the product needs both numbers.
    pub armed_total_bps: u16,
    /// [Q-04 · Sec3] Running total of slice_bps already converted under the
    /// CURRENT armed trigger.
    ///
    /// NOTE — the authorization is PROPORTIONAL, not absolute. Both caps are
    /// bps of `collateral_amount`, and `add_collateral` grows that base. So a
    /// borrower who arms 50% and later tops up has, in absolute terms, allowed
    /// the engine a larger amount than when they armed. This is NOT an engine
    /// escalation path — `add_collateral` requires the borrower's own
    /// signature (has_one = borrower + Signer), so nothing can grow the base
    /// without them. It is deliberate: a laddered exit should scale with the
    /// position rather than silently stop covering it. Front-ends should say
    /// so when a borrower tops up a loan with a live trigger. Without it, the cap applied per call rather than
    /// in aggregate, so the engine could drain a position in successive slices
    /// while the trigger stayed satisfied — making the borrower's authorization
    /// meaningless. Reset to 0 whenever the trigger is armed or disarmed.
    pub armed_converted_bps: u16,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum LoanStatus {
    Active,
    Repaid,
    Liquidated,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub protocol_fee_bps: u16,
    pub engine_authority: Pubkey,
    pub fee_wallet: Pubkey,
}

/// Pool authority rotated the engine authority and/or fee wallet.
#[event]
#[derive(Debug, PartialEq, Eq)]
pub struct PoolConfigUpdated {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub old_engine_authority: Pubkey,
    pub new_engine_authority: Pubkey,
    pub old_fee_wallet: Pubkey,
    pub new_fee_wallet: Pubkey,
}

/// [H-02 · Sec3] Borrower armed an on-chain auto-sell trigger.
#[event]
pub struct ConversionArmed {
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub trigger_price: u64,
    pub direction: u8,
    pub max_slice_bps: u16,
    /// [Q-04] Total authorization across all fires under this arming.
    pub total_bps: u16,
}

/// [H-02 · Sec3] Borrower disarmed the on-chain auto-sell trigger.
#[event]
pub struct ConversionDisarmed {
    pub loan: Pubkey,
    pub borrower: Pubkey,
}

/// [L-02 · Sec3] Off-chain SPL-sale proceeds returned to LPs and credited to
/// pool.total_deposits (no new shares minted), reconciled to a liquidated loan.
#[event]
pub struct LiquidationRecovered {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct LoanFunded {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_amount: u64,
    pub loan_amount: u64,
    pub fee: u64,
    pub ltv_bps: u16,
    pub duration_days: u8,
    /// 0 = memecoin, 1 = RWA. Off-chain indexers can filter loans
    /// by category without joining against the off-chain mint table.
    pub category: u8,
}

#[event]
pub struct LoanRepaid {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub repay_amount: u64,
}

#[event]
pub struct PartialRepayment {
    pub loan: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct CollateralAdded {
    pub loan: Pubkey,
    pub amount: u64,
    pub new_total: u64,
}

#[event]
pub struct LoanExtended {
    pub loan: Pubkey,
    pub new_due_timestamp: i64,
    pub extension_fee: u64,
}

#[event]
pub struct PriceFeedInitialized {
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub authority: Pubkey,
}

#[event]
pub struct PriceUpdated {
    pub mint: Pubkey,
    pub price_lamports: u64,
    pub confidence_bps: u16,
    pub timestamp: i64,
}

#[event]
pub struct LoanLiquidated {
    pub pool: Pubkey,
    pub loan: Pubkey,
    pub borrower: Pubkey,
    pub keeper: Pubkey,
    // [I-03 · Sec3] Separate per-asset fields — SPL collateral and wSOL proceeds
    // are different units and must never be summed into one number.
    pub collateral_seized_spl: u64,
    pub proceeds_seized_wsol: u64,
    pub keeper_reward_spl: u64,
    pub keeper_reward_wsol: u64,
    /// Unsold SPL collateral sent to the pool authority for off-chain sale
    /// (later reconciled to LPs via recover_liquidated_collateral, L-02).
    pub authority_amount_spl: u64,
    /// [I-02 · Sec3] Recovered wSOL proceeds routed to the LP vault + credited
    /// to pool.total_deposits (L-02). Renamed from `authority_amount_wsol`,
    /// which was misleading — this value goes to the LP vault, NOT the authority.
    pub lp_recovered_wsol: u64,
    pub collateral_mint: Pubkey,
    pub loan_token_mint: Pubkey,
}

/// v4 — Emitted on every convert_collateral_slice call. Captures both
/// the gross (pre-fee) and net (post-fee) so off-chain accounting can
/// reconcile fee accrual without re-querying state.
#[event]
pub struct CollateralConverted {
    pub loan: Pubkey,
    pub slice_bps: u16,
    pub slice_amount_sold: u64,
    pub sol_received_gross: u64,
    pub protocol_fee: u64,
    pub net_sol_to_vault: u64,
    pub remaining_collateral: u64,
    pub total_sol_proceeds: u64,
    pub auto_sells_fired: u8,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid loan option. Must be 0, 1, or 2.")]
    InvalidLoanOption,
    #[msg("Invalid collateral amount.")]
    InvalidCollateralAmount,
    #[msg("Invalid collateral value.")]
    InvalidCollateralValue,
    #[msg("Invalid amount.")]
    InvalidAmount,
    #[msg("Math overflow.")]
    MathOverflow,
    #[msg("Insufficient pool liquidity.")]
    InsufficientLiquidity,
    #[msg("Loan is not active.")]
    LoanNotActive,
    #[msg("Loan is not yet due for liquidation.")]
    LoanNotDue,
    #[msg("Unauthorized.")]
    Unauthorized,
    #[msg("Protocol fee too high (max 50%).")]
    FeeTooHigh,
    #[msg("Insufficient shares.")]
    InsufficientShares,
    #[msg("Pool is paused.")]
    PoolPaused,
    #[msg("Keeper reward too high (max 20%).")]
    KeeperRewardTooHigh,
    #[msg("Price attestation is stale (older than 2 minutes).")]
    StalePriceAttestation,
    #[msg("Collateral value exceeds attested price beyond tolerance.")]
    CollateralValueExceedsAttestation,
    #[msg("Price attestation mint does not match collateral mint.")]
    PriceMintMismatch,
    #[msg("TWAP requires more price history than is currently available.")]
    TwapInsufficientHistory,
    #[msg("Spot price is too far above the TWAP — pump detected, refusing to lend.")]
    PriceImpactPumpDetected,
    #[msg("Price sample timestamp went backwards — clock skew or replay.")]
    PriceTimestampWentBackwards,
    #[msg("Invalid category. Must be 0 (memecoin) or 1 (RWA).")]
    InvalidCategory,
    #[msg("admin_withdraw refused: would drain share-backed LP deposits. Only excess (vault_balance - total_deposits) is admin-withdrawable.")]
    AdminWithdrawWouldDrainLpFunds,
    // v4 in-vault auto-sell error variants ────────────────────────────
    #[msg("slice_bps must be in (0, 10000].")]
    InvalidSlice,
    #[msg("Computed slice amount is zero — collateral too small for this slice_bps.")]
    SliceTooSmall,
    #[msg("Slice exceeds remaining collateral. Some auto-sells already fired and reduced the pool.")]
    SliceExceedsRemaining,
    #[msg("Swap returned less than min_sol_out. Slippage exceeded the cap you specified.")]
    SlippageExceeded,
    #[msg("convert_collateral_slice requires a swap program + accounts in remaining_accounts. Engine must pre-assemble the swap.")]
    SwapMissing,
    #[msg("Only the pool's configured engine authority can call convert_collateral_slice. Refusing.")]
    EngineUnauthorized,
    #[msg("Invalid pool config: engine_authority must be a non-zero key distinct from the pool authority, and fee_wallet must be a loan-token account.")]
    InvalidPoolConfig,
    #[msg("fee_wallet must equal the pool's configured fee wallet (LendingPool.fee_wallet). The 1% protocol skim can only flow there.")]
    InvalidFeeWallet,

    // ── V4.1 ANTI-DRAIN ERRORS ──────────────────────────────────────
    #[msg("min_sol_out is below the on-chain oracle floor. The program refuses fires that could drain collateral via under-priced swaps.")]
    MinOutBelowOracleFloor,
    #[msg("[H-02] Conversion not authorized: the loan is not overdue and has no borrower-armed trigger satisfied at the current price. A compromised engine cannot force-sell a healthy, un-armed loan.")]
    ConversionNotAuthorized,
    #[msg("[H-02] Invalid auto-sell trigger: price must be > 0, direction must be 0 (take-profit) or 1 (stop-loss), and max_slice_bps must be in (0, 10000].")]
    InvalidTrigger,
    #[msg("[M-01] Extension requires the pool authority to co-sign: the loan is not provably healthy on-chain (stale price or under-collateralized).")]
    ExtendRequiresAuthority,
    #[msg("[M-04] Price update exceeds the per-update sanity bound (>100x move vs the previous sample). Rejected as a likely fat-finger/unit error; walk the price over multiple updates if the move is genuine.")]
    PriceChangeExceedsBound,
    #[msg("[L-02] Loan is not in the Liquidated state — recovery only applies to a liquidated loan.")]
    LoanNotLiquidated,
    #[msg("Swap program not in the V4.1 allowlist (Jupiter v6 + Orca Whirlpool). Refusing to invoke arbitrary programs as swap routers.")]
    SwapProgramNotAllowed,
    #[msg("Oracle sample is empty for this collateral mint. Push at least one update_price sample before firing.")]
    OracleEmpty,
    #[msg("Oracle sample is older than MAX_ORACLE_AGE_SECONDS. Engine must push a fresh price sample before this fire.")]
    OracleStale,
    #[msg("price_history.mint does not match loan.collateral_mint. Wrong oracle account passed.")]
    OracleMintMismatch,
    #[msg("price_history.pool does not match the pool account. Wrong oracle account passed.")]
    OraclePoolMismatch,

    // ── Sec3 remediation (2026-07) ──────────────────────────────────
    #[msg("[H-01] Collateral mint carries an unsupported Token-2022 extension (permanent-delegate / non-transferable). Refusing to custody it.")]
    UnsupportedCollateralExtension,
    #[msg("[H-01] Collateral vault received zero tokens after the transfer.")]
    ZeroCollateralReceived,
    #[msg("[H-02] The collateral slice was not consumed as swap input — the engine account still holds it. Refusing.")]
    CollateralNotConsumed,
    #[msg("[L-05] pool account does not match loan.pool. Wrong pool passed for the oracle floor.")]
    PoolMismatch,
    #[msg("[M-02] A partial repayment must leave a remainder. Use repay_loan for the final payment so collateral is returned and the loan is closed.")]
    UseRepayLoanForFinalPayment,
    #[msg("[M-02] Loan has no outstanding debt and cannot be liquidated.")]
    LoanFullyRepaid,
    #[msg("[Q-02] Loan is past due and can no longer be extended — it is liquidatable.")]
    LoanOverdueForExtension,
    #[msg("[H-02] Loan is past due — the conversion trigger no longer restricts the engine, so it can no longer be armed or disarmed.")]
    LoanOverdue,
    #[msg("[L-07] Pool is insolvent (zero deposits, outstanding shares). New deposits are paused until recovery.")]
    PoolInsolvent,
    #[msg("[I-01] loan_token_mint / wsol_mint must be the canonical Wrapped SOL mint.")]
    WrongWsolMint,
}

#[cfg(test)]
mod price_history_tests {
    use super::*;

    fn empty_history() -> PriceHistory {
        PriceHistory {
            mint: Pubkey::default(),
            pool: Pubkey::default(),
            authority: Pubkey::default(),
            head_index: 0,
            count: 0,
            _padding: [0; 6],
            samples: [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY],
            bump: 0,
        }
    }

    // [L-01 · Sec3] Clustered same-timestamp samples must NOT satisfy the gate.
    #[test]
    fn clustered_samples_should_not_satisfy_min_twap_history() {
        let mut history = empty_history();
        for _ in 0..MIN_SAMPLES_FOR_TWAP {
            history.append(PriceSample { price_lamports: 10_000, timestamp: 0 });
        }
        history.append(PriceSample { price_lamports: 10_000, timestamp: MIN_HISTORY_SECONDS });
        assert!(
            history.twap(MIN_HISTORY_SECONDS).is_none(),
            "same-timestamp samples should not satisfy the minimum TWAP history gate"
        );
    }

    // [L-01 · Sec3] The pre-window price must be carried forward from the cutoff.
    #[test]
    fn twap_should_carry_forward_pre_window_price() {
        let mut history = empty_history();
        history.append(PriceSample { price_lamports: 100, timestamp: 0 });
        let first_in_window = TWAP_WINDOW_SECONDS;
        for i in 0..MIN_SAMPLES_FOR_TWAP {
            history.append(PriceSample {
                price_lamports: 1_000,
                timestamp: first_in_window + i as i64 * 10,
            });
        }
        let now = TWAP_WINDOW_SECONDS + 100;
        let (twap, _, _) = history.twap(now).expect("twap should be available");
        assert_eq!(
            twap, 150u128,
            "TWAP should include the pre-window price carried forward from cutoff until the first in-window update"
        );
    }
}

/// [Q-04 · Sec3] The conversion allowance: a per-fire cap AND a cumulative
/// total. These two numbers are what let a laddered exit keep working while
/// still bounding what a compromised engine could ever take.
#[cfg(test)]
mod conversion_allowance_tests {
    use super::{conversion_authorized, trigger_config_allowed};

    /// Calls the SHIPPED authorization helper — the same one
    /// `convert_collateral_slice` calls. An earlier version of these tests
    /// re-implemented the arithmetic, which meant they could pass while the
    /// program did something else entirely. On a path that moves collateral,
    /// the test has to exercise the real decision, not a copy of it.
    ///
    /// Armed at price 1_000 take-profit with spot 1_000, so the price side is
    /// always satisfied and each case isolates the CAP behaviour.
    fn fire_allowed(slice_bps: u16, max_slice_bps: u16, total_bps: u16, converted_bps: u16) -> bool {
        conversion_authorized(
            false, // not overdue — exercise the trigger path
            1_000, // armed price
            0,     // take-profit
            1_000, // spot == armed price, so the trigger is met
            slice_bps,
            max_slice_bps,
            total_bps,
            converted_bps,
        )
    }

    #[test]
    fn disarmed_loan_cannot_be_converted() {
        // armed_price 0 = disarmed. No cap arithmetic should rescue it.
        assert!(!conversion_authorized(false, 0, 0, 5_000, 1_000, 10_000, 10_000, 0));
    }

    #[test]
    fn overdue_authorizes_regardless_of_trigger() {
        // Past due the loan is liquidatable and conversion is allowed even
        // while disarmed — the pre-existing design, unchanged by Q-04.
        assert!(conversion_authorized(true, 0, 0, 0, 10_000, 0, 0, 0));
    }

    #[test]
    fn trigger_config_is_refused_once_overdue() {
        // [H-02, 2nd review] now == due is still fine; one second past is not.
        assert!(trigger_config_allowed(1_000, 1_000), "at the boundary, arming is still allowed");
        assert!(!trigger_config_allowed(1_001, 1_000), "one second overdue must refuse");
        assert!(trigger_config_allowed(999, 1_000));
    }

    #[test]
    fn trigger_config_boundary_matches_the_convert_gate() {
        // The two must be exact complements, or a loan could be overdue for
        // conversion while still armable — the gap Sec3 flagged.
        for (now, due) in [(999i64, 1_000i64), (1_000, 1_000), (1_001, 1_000)] {
            let overdue = now > due; // exactly how convert_collateral_slice computes it
            assert_eq!(
                trigger_config_allowed(now, due),
                !overdue,
                "arming must be allowed exactly when the loan is NOT overdue (now={now}, due={due})"
            );
        }
    }

    #[test]
    fn ladder_legs_all_fire_under_one_arming() {
        // The 70/20/10 take-profit ladder the product actually offers.
        // Borrower arms: no single fire above 70%, 100% total.
        let (max_slice, total) = (7_000u16, 10_000u16);
        let mut converted = 0u16;
        for leg in [7_000u16, 2_000, 1_000] {
            assert!(
                fire_allowed(leg, max_slice, total, converted),
                "ladder leg {leg} bps must fire — collapsing the two caps would break this"
            );
            converted += leg;
        }
        assert_eq!(converted, 10_000, "ladder sells the whole position across 3 legs");
    }

    #[test]
    fn cumulative_total_bounds_a_compromised_engine() {
        // Q-04's attack: repeat the SAME authorized slice to drain the position.
        // Borrower authorized 30% in total, in fires of at most 10%.
        let (max_slice, total) = (1_000u16, 3_000u16);
        let mut converted = 0u16;
        for _ in 0..3 {
            assert!(fire_allowed(1_000, max_slice, total, converted));
            converted += 1_000;
        }
        assert!(
            !fire_allowed(1_000, max_slice, total, converted),
            "a 4th fire must be refused — the borrower authorized 30%, not unlimited"
        );
    }

    #[test]
    fn single_fire_cannot_exceed_per_fire_cap() {
        // Plenty of total left, but one fire may still not exceed the per-fire cap.
        assert!(!fire_allowed(5_001, 5_000, 10_000, 0));
        assert!(fire_allowed(5_000, 5_000, 10_000, 0));
    }

    #[test]
    fn allowance_is_consumed_not_refreshed_by_a_smaller_fire() {
        // Partial usage still consumes: 2 x 60% must not be possible under an
        // 80% total just because each fire is under the per-fire cap.
        let (max_slice, total) = (6_000u16, 8_000u16);
        assert!(fire_allowed(6_000, max_slice, total, 0));
        assert!(!fire_allowed(6_000, max_slice, total, 6_000));
    }
}

/// [H-02 · Sec3] Unit tests for the borrower-armed conversion trigger gate.
#[cfg(test)]
mod conversion_gate_tests {
    use super::armed_price_reached;

    #[test]
    fn disarmed_loan_never_fires() {
        // armed_price == 0 → disarmed → never authorized, any direction/price.
        assert!(!armed_price_reached(0, 0, 1_000));
        assert!(!armed_price_reached(0, 1, 1_000));
        assert!(!armed_price_reached(0, 0, 0));
    }

    #[test]
    fn take_profit_fires_only_at_or_above_target() {
        // direction 0 = take-profit: fire when spot RISES to >= armed price.
        let armed = 1_000u64;
        assert!(!armed_price_reached(armed, 0, 999), "below target must NOT fire");
        assert!(armed_price_reached(armed, 0, 1_000), "at target fires");
        assert!(armed_price_reached(armed, 0, 5_000), "above target (spike) fires — capture upside");
    }

    #[test]
    fn stop_loss_fires_only_at_or_below_target() {
        // direction 1 = stop-loss: fire when spot FALLS to <= armed price.
        let armed = 1_000u64;
        assert!(!armed_price_reached(armed, 1, 1_001), "above target must NOT fire");
        assert!(armed_price_reached(armed, 1, 1_000), "at target fires");
        assert!(armed_price_reached(armed, 1, 500), "below target fires — protect downside");
    }

    #[test]
    fn unknown_direction_never_fires() {
        // Any direction other than 0/1 is invalid → never authorized.
        assert!(!armed_price_reached(1_000, 2, 5_000));
        assert!(!armed_price_reached(1_000, 255, 5_000));
    }
}

/// [M-01 · Sec3] Unit tests for the on-chain extend-loan health check.
#[cfg(test)]
mod extend_health_tests {
    use super::*;

    /// A feed of `price` held constant across a 600s window ending at `now`
    /// (>= MIN_HISTORY_SECONDS coverage, latest sample fresh, all in the
    /// 30-min TWAP window, >= MIN_SAMPLES_FOR_TWAP samples).
    fn feed_with_constant_price(price: u64, now: i64) -> PriceHistory {
        let mut h = PriceHistory {
            mint: Pubkey::default(),
            pool: Pubkey::default(),
            authority: Pubkey::default(),
            head_index: 0,
            count: 0,
            _padding: [0; 6],
            samples: [PriceSample { price_lamports: 0, timestamp: 0 }; PRICE_HISTORY_CAPACITY],
            bump: 0,
        };
        let span: i64 = 600;
        let n: i64 = MIN_SAMPLES_FOR_TWAP as i64 + 2; // 10 samples
        for i in 0..n {
            let ts = now - span + (span * i / (n - 1));
            h.append(PriceSample { price_lamports: price, timestamp: ts });
        }
        h
    }

    #[test]
    fn healthy_loan_self_extends_unhealthy_needs_authority() {
        let now = 1_000_000i64;
        // 1 SOL/token (1e9 lamports), 6 decimals, 100 whole tokens collateral →
        // current value 100 SOL. At 50% LTV that supports up to 50 SOL of debt.
        let feed = feed_with_constant_price(1_000_000_000, now);
        // 40 SOL debt <= 50 SOL supported → HEALTHY (self-extend, no authority).
        assert!(extend_loan_is_healthy(&feed, 6, now, 100_000_000, 0, 40_000_000_000, 5000));
        // 60 SOL debt > 50 SOL supported → NOT healthy (authority required).
        assert!(!extend_loan_is_healthy(&feed, 6, now, 100_000_000, 0, 60_000_000_000, 5000));
    }

    #[test]
    fn stale_price_forces_authority() {
        let now = 1_000_000i64;
        // Latest sample is ~10_000s old → beyond MAX_ORACLE_AGE_SECONDS.
        let feed = feed_with_constant_price(1_000_000_000, now - 10_000);
        assert!(!extend_loan_is_healthy(&feed, 6, now, 100_000_000, 0, 1, 5000));
    }

    #[test]
    fn already_converted_proceeds_count_toward_health() {
        let now = 1_000_000i64;
        let feed = feed_with_constant_price(1_000_000_000, now);
        // 0 SPL collateral left but 60 SOL already auto-sold into proceeds; at
        // 50% LTV that supports 30 SOL debt. 25 SOL debt → HEALTHY.
        assert!(extend_loan_is_healthy(&feed, 6, now, 0, 60_000_000_000, 25_000_000_000, 5000));
    }
}

/// [M-04 · Sec3] Unit tests for the per-update price-change sanity bound.
#[cfg(test)]
mod price_bound_tests {
    use super::price_change_within_bound;

    #[test]
    fn first_sample_always_ok() {
        assert!(price_change_within_bound(0, 12_345));
        assert!(price_change_within_bound(0, 1));
    }

    #[test]
    fn within_100x_ok() {
        assert!(price_change_within_bound(100, 100));
        assert!(price_change_within_bound(100, 10_000)); // exactly 100x up
        assert!(price_change_within_bound(100, 1)); // exactly 100x down
        assert!(price_change_within_bound(1_000, 50_000));
    }

    #[test]
    fn beyond_100x_rejected() {
        assert!(!price_change_within_bound(100, 10_001)); // >100x up (fat-finger)
        assert!(!price_change_within_bound(10_000, 99)); // >100x down
        assert!(!price_change_within_bound(1_000, 1)); // 1000x down
    }
}

#[cfg(test)]
mod pool_config_tests {
    use super::*;

    fn key(b: u8) -> Pubkey { Pubkey::new_from_array([b; 32]) }

    fn pool() -> LendingPool {
        LendingPool {
            authority: key(1),
            loan_token_vault: key(2),
            loan_token_mint: key(3),
            protocol_fee_bps: 100,
            keeper_reward_bps: 500,
            total_deposits: 0,
            total_shares: 0,
            total_borrowed: 0,
            total_fees_earned: 0,
            pending_fees: 0,
            total_loans_issued: 0,
            total_liquidations: 0,
            paused: false,
            bump: 0,
            vault_bump: 0,
            engine_authority: key(4),
            fee_wallet: key(5),
        }
    }

    #[test]
    fn authority_can_rotate_engine_and_fee_wallet_and_event_carries_old_and_new() {
        let mut p = pool();
        let ev = apply_pool_config(&mut p, key(9), &key(1), key(14), key(15)).expect("authority allowed");
        assert_eq!(p.engine_authority, key(14));
        assert_eq!(p.fee_wallet, key(15));
        assert_eq!(ev, PoolConfigUpdated {
            pool: key(9),
            authority: key(1),
            old_engine_authority: key(4),
            new_engine_authority: key(14),
            old_fee_wallet: key(5),
            new_fee_wallet: key(15),
        });
    }

    #[test]
    fn non_authority_is_rejected_and_nothing_changes() {
        let mut p = pool();
        let err = apply_pool_config(&mut p, key(9), &key(77), key(14), key(15)).unwrap_err();
        assert_eq!(err, ErrorCode::Unauthorized.into());
        assert_eq!(p.engine_authority, key(4));
        assert_eq!(p.fee_wallet, key(5));
    }

    #[test]
    fn engine_may_not_be_zero_or_the_pool_authority() {
        let mut p = pool();
        let e = apply_pool_config(&mut p, key(9), &key(1), Pubkey::default(), key(15)).unwrap_err();
        assert_eq!(e, ErrorCode::InvalidPoolConfig.into());
        let e = apply_pool_config(&mut p, key(9), &key(1), key(1), key(15)).unwrap_err();
        assert_eq!(e, ErrorCode::InvalidPoolConfig.into());
        assert!(!pool_config_valid(&key(1), &key(1)));
        assert!(!pool_config_valid(&key(1), &Pubkey::default()));
        assert!(pool_config_valid(&key(1), &key(2)));
        assert_eq!(p.engine_authority, key(4));
    }

    #[test]
    fn fee_wallet_may_not_be_zero() {
        let mut p = pool();
        let e = apply_pool_config(&mut p, key(9), &key(1), key(14), Pubkey::default()).unwrap_err();
        assert_eq!(e, ErrorCode::InvalidPoolConfig.into());
        assert_eq!(p.fee_wallet, key(5));
    }
}
