/**
 * The one place the $HOCK contract address lives. Header pill, footer link and the home strip all import
 * it, so the surfaces can never drift. Empty string = not yet published (every surface shows its pending
 * state and points at the strip on the home page). Verify a new mint on-chain + DexScreener before
 * changing this; scripts/wire-hock.sh does the verify + set + push in one go.
 */
export const HOCK_CA = "Ag3BHSuUdbhUS9yzHxis3r3zu5m66K9XLTR9KysBpump";
export const HOCK_PUMP_URL = HOCK_CA ? `https://pump.fun/coin/${HOCK_CA}` : "";
/** Where a "$HOCK" link goes: the live pair once published, the strip on the home page until then. */
export const HOCK_HREF = HOCK_PUMP_URL || "/#hock";
