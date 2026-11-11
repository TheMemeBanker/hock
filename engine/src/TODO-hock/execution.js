// TODO-hock: order execution module (not lifted — it is coupled to the source
// schema and fire path). armed-order-health-probe imports dryRunArmedOrder();
// until HOCK's execution path exists every probe reports a clear failure.
export async function dryRunArmedOrder(_order) {
  return { ok: false, phase: "not_wired", reason: "TODO-hock: execution.js not implemented" };
}
