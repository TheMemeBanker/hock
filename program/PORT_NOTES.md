# HOCK lending program — port notes

Ported from the prior audited lending program (Anchor 0.32.1, Rust 2021) into a
fresh, standalone Anchor workspace. Nothing in this directory references the
prior product; the on-chain logic is otherwise carried over line-for-line.

## Program id

- `hock_lending`: **Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb** (`declare_id!`, Anchor.toml localnet + devnet)
- The program keypair and the devnet deployer keypair live OUTSIDE the repo in
  `~/hock-keys/` (mode 700). They are not committed, not printed, and not used by
  any script. `target/deploy/hock_lending-keypair.json` produced by `anchor build`
  is a throwaway build artifact — deploy must pass the real keypair explicitly
  with `--program-keypair`. Nothing has been deployed anywhere.

## Functional changes vs the prior program

1. **Authorities moved out of constants and onto `LendingPool`.**
   - New fields: `engine_authority: Pubkey`, `fee_wallet: Pubkey` (appended after
     `vault_bump`; `INIT_SPACE` grows by 64 bytes).
   - `initialize_pool(protocol_fee_bps, keeper_reward_bps, engine_authority)` now
     also takes a `fee_wallet: Account<TokenAccount>` whose mint must equal the
     (wSOL) loan token mint (`InvalidFeeWallet` otherwise). `engine_authority`
     must be non-zero and must differ from the pool authority (`InvalidPoolConfig`).
   - New instruction `set_pool_config(engine_authority)` with context
     `SetPoolConfig { pool (has_one = authority), authority: Signer, fee_wallet:
     TokenAccount (mint == pool.loan_token_mint) }`. Same validation as init, plus
     a second explicit `signer == pool.authority` check inside the pure helper
     `apply_pool_config`. Emits `PoolConfigUpdated { pool, authority,
     old_engine_authority, new_engine_authority, old_fee_wallet, new_fee_wallet }`.
   - `PoolInitialized` event gained `engine_authority` and `fee_wallet`.
   - Every account constraint that previously compared against the constants now
     compares against the pool field:
     `RequestLoan.fee_wallet_token_account`, `ExtendLoan.fee_wallet_token_account`,
     `ConvertCollateralSlice.fee_wallet` → `address = pool.fee_wallet`;
     `ConvertCollateralSlice.engine` → `address = pool.engine_authority`.
     All three contexts already carried `pool` (bound to the loan's pool), so no
     new cross-pool exposure is introduced.
   - Pause flag and keeper-reward admin paths are unchanged.
2. **Identity scrub.** Crate renamed `hock_lending`; program module `hock_lending`;
   fee-wallet error message and comments reworded. No wallet or program ids from
   the prior product remain anywhere under `~/hock/program`.
3. **Nothing else.** A code-only diff (comments stripped, renames normalised)
   between the source and `src/lib.rs` contains only: the two removed constants,
   the pool fields, the init/set_pool_config handlers + helper + event + error
   variant, the four constraint rewrites above, one error-message string, and the
   new test module.

## Safety gates — verified unchanged

All constants and gate code are byte-identical to the source (checked with a
const-by-const diff): oracle staleness 120 s; TWAP 8 samples / 300 s minimum
span / 1800 s window; spot-vs-TWAP pump guard 1500 bps; per-update price factor
100; oracle floor on `min_sol_out`; swap-program allowlist (Jupiter v6 +
Orca Whirlpool); max protocol slippage 1500 bps; PermanentDelegate /
NonTransferable refusal; memecoin + RWA tier tables; L-05 pool binding on the
price feed. No gate had to be loosened for the authority refactor.

## Toolchain

- anchor-cli 0.32.1 (via avm; `avm use 0.32.1` reported success but left the
  `~/.avm/bin/anchor` symlink on 0.31.1, so the link was re-pointed by hand).
- anchor-lang / anchor-spl 0.32.x as pinned by `Cargo.lock` (carried over from the
  source so the SBF toolchain's cargo 1.79 can resolve — a fresh resolution pulls
  an edition-2024 `crypto-common` and fails).
- solana-cli 2.1.0, rustc 1.97 (host tests).

## Test results

- `anchor build` (anchor-cli 0.32.1): **clean, 0 warnings**. Artifacts:
  `target/deploy/hock_lending.so` (659,688 bytes), `target/idl/hock_lending.json`
  (address = Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb; `initialize_pool` carries
  the `engine_authority: pubkey` arg and `fee_wallet` account; `set_pool_config`,
  `PoolConfigUpdated`, `InvalidPoolConfig` present).
- `cargo test --lib` (host): **25 passed, 0 failed** — the 20 pre-existing unit
  tests (price history / TWAP gate, price bound, conversion gate, conversion
  allowance, extend health) + Anchor's generated `test_id` + 4 new
  `pool_config_tests` (authority rotates and the returned event carries old+new
  values; non-authority rejected with `Unauthorized` and state untouched; engine
  may not be zero or the pool authority; fee wallet may not be zero). Host build
  emits only Anchor's usual `unexpected cfg anchor-debug` warnings.
- Matrix harness (`scripts/matrix-harness.mjs`): **ported, not yet run** against a
  local validator (Phase A alone needs ~8 minutes of wall clock for the oracle
  history and staleness waits, which did not fit the time cap). New cases added:
  A0a–A0c (init refusals: wrong-mint fee wallet, engine == authority, zero engine),
  A16b–A16g (set_pool_config: non-authority refused, wrong-mint fee wallet refused,
  engine == authority refused, authority rotation lands + event log present, old
  engine refused with `EngineUnauthorized`, new engine passes the signer gate and
  stops at `MinOutBelowOracleFloor`, then rotate back). All original A/B cases
  are retained unchanged.
- Nothing deployed; no cluster touched. No git operations performed here.

## Files

- `Anchor.toml` — workspace config; program id for localnet/devnet; devnet wallet path (outside repo).
- `Cargo.toml` — cargo workspace root + release profile (overflow checks on, fat LTO).
- `Cargo.lock` — pinned dependency set that builds on the SBF toolchain.
- `package.json` — harness dependencies (`@solana/web3.js`, `@solana/spl-token`) and `matrix`/`dump` scripts.
- `.gitignore` — target/, node_modules/, .anchor/, test-ledger/, *.so, keys/, matrix-state/.
- `programs/hock-lending/Cargo.toml` — program crate `hock_lending` (cdylib + lib, anchor 0.32.1).
- `programs/hock-lending/Xargo.toml` — SBF std features.
- `programs/hock-lending/src/lib.rs` — the lending program (pool, price feeds/TWAP, borrow, convert, extend, repay, liquidate, recover) + unit tests.
- `scripts/matrix-harness.mjs` — local-validator lifecycle + refusal matrix (Phase A fresh clock, Phase B warped); program id from env `HOCK_PROGRAM_ID` or Anchor.toml; IDL from `target/idl/hock_lending.json`; keys/state in `matrix-state/`.
- `scripts/dump-matrix-state.mjs` — dumps Phase-A accounts as `--account` files for a warped restart.
- `PORT_NOTES.md` — this file.

## How to run

```
anchor build
cargo test --manifest-path programs/hock-lending/Cargo.toml --lib
npm install
solana-test-validator -r --bpf-program Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb target/deploy/hock_lending.so
node scripts/matrix-harness.mjs A      # ~8 min (builds 300 s of oracle history, 125 s stale wait)
node scripts/dump-matrix-state.mjs     # then restart the validator warped ~2.5 days with the dumped accounts
node scripts/matrix-harness.mjs B
```
