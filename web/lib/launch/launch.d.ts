export const LAUNCH_CONFIG: { tradeLocal: string; pool: string; rpcs: string[]; uploadProxy?: string };
export const DRY: boolean;
export function buildCreateTransaction(args: Record<string, unknown>): Promise<unknown>;
export function launch(args: Record<string, unknown>): Promise<{ mint: string; sig: string | null; uri?: string; dry: boolean }>;
