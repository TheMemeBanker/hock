export function pinViaProxy(meta: Record<string, unknown>, file: File, config: Record<string, unknown>): Promise<string>;
export function pinViaPinata(meta: Record<string, unknown>, file: File, jwt: string, config: Record<string, unknown>): Promise<string>;
export function pinViaIrys(meta: Record<string, unknown>, file: File, onStatus: (s: string, cls?: string) => void, ctx: { wallet: unknown; pubkey: unknown; config: Record<string, unknown> }): Promise<{ uri: string }>;
