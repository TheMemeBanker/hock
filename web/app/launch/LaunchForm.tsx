"use client";

import { useEffect, useMemo, useRef, useState } from "react";
// The launch library is plain JS lifted from a proven launcher; typed loosely here on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { useWallet } from "@solana/wallet-adapter-react";
import Link from "next/link";
import { CLUSTER, explorerUrl } from "@/lib/solana/constants";

const TEST_CLUSTER = CLUSTER !== "mainnet-beta";

type Step = 1 | 2 | 3 | 4;
const STEPS: { id: Step; label: string }[] = [
  { id: 1, label: "Store" },
  { id: 2, label: "Build" },
  { id: 3, label: "Sign" },
  { id: 4, label: "Confirm" },
];

type Result = { mint: string; sig: string | null; dry: boolean };

/**
 * The launch form. All work happens in the browser through lib/launch:
 * metadata to Arweave (Irys) or IPFS (Pinata via relay), PumpPortal builds
 * the create transaction, we simulate it, the wallet signs, we rebroadcast
 * with a priority fee until confirmed, then register the mint with the gate.
 */
export function LaunchForm() {
  const wallet = useWallet();
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [desc, setDesc] = useState("");
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [buy, setBuy] = useState("0");
  const [slip, setSlip] = useState("10");
  const [prio, setPrio] = useState("0.0005");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [website, setWebsite] = useState("");
  const [vanity, setVanity] = useState(false);
  const [agree, setAgree] = useState(false);
  const [status, setStatus] = useState<string>("Connect a wallet to launch.");
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [done, setDone] = useState<Set<Step>>(new Set());
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!image) { setPreview(null); return; }
    const u = URL.createObjectURL(image);
    setPreview(u);
    return () => URL.revokeObjectURL(u);
  }, [image]);

  useEffect(() => {
    if (!wallet.connected) setStatus("Connect a wallet to launch.");
    else if (!name || !symbol || !image) setStatus("Name, ticker and art are required.");
    else if (!agree) setStatus("Confirm you have read the risk disclosure.");
    else setStatus("Ready. Everything is simulated before you sign.");
  }, [wallet.connected, name, symbol, image, agree]);

  const canLaunch = wallet.connected && !!name && !!symbol && !!image && agree && !busy;
  const dry = useMemo(() => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("dry") === "1", []);

  function stepHook(n: number, state?: string) {
    const id = n as Step;
    if (state === "done") {
      setDone((d) => { const nd = new Set(d); for (let i = 1; i <= id; i++) nd.add(i as Step); return nd; });
      setStep(null);
    } else {
      setDone((d) => { const nd = new Set(d); for (let i = 1; i < id; i++) nd.add(i as Step); return nd; });
      setStep(id);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canLaunch || !wallet.publicKey) return;
    setBusy(true); setErr(null); setResult(null); setDone(new Set());
    try {
      let r: { mint: string; sig: string | null; uri?: string; dry: boolean };
      if (TEST_CLUSTER) {
        // Devnet/localnet: PumpPortal is mainnet-only, so create a Token-2022 test mint with on-chain metadata instead.
        const { launchDevnet } = await import("@/lib/launch/devnet-launch");
        r = await launchDevnet({
          wallet: wallet as unknown as Parameters<typeof launchDevnet>[0]["wallet"],
          pubkey: wallet.publicKey,
          meta: { name: name.trim(), symbol: symbol.trim().toUpperCase(), description: desc.trim(), twitter: twitter.trim(), telegram: telegram.trim(), website: website.trim() },
          imageFile: image!,
          rpcUrl: `${window.location.origin}/api/rpc`,
          uploadProxy: process.env.NEXT_PUBLIC_UPLOAD_RELAY_URL || `${window.location.origin}/api/upload`,
          dry,
          onStatus: (s: string) => setStatus(s),
          onStep: (n: number, state?: string) => stepHook(n, state),
        });
      } else {
      const { launch } = (await import("@/lib/launch/launch")) as unknown as { launch: (o: Record<string, unknown>) => Promise<{ mint: string; sig: string | null; uri?: string; dry: boolean }> };
      r = await launch({
        wallet,
        pubkey: wallet.publicKey,
        meta: { name: name.trim(), symbol: symbol.trim().toUpperCase(), description: desc.trim(), twitter: twitter.trim(), telegram: telegram.trim(), website: website.trim() },
        imageFile: image!,
        buy: Number(buy) || 0,
        slip: Number(slip) || 10,
        prio: Number(prio) || 0.0005,
        vanity,
        dry,
        config: {
          tradeLocal: process.env.NEXT_PUBLIC_PUMPPORTAL_TRADE_LOCAL ?? "https://pumpportal.fun/api/trade-local",
          uploadProxy: process.env.NEXT_PUBLIC_UPLOAD_RELAY_URL ?? "",
          rpcs: [`${window.location.origin}/api/rpc`],
          irysBundle: "/vendor/irys.bundle.js",
          irysGateway: "https://gateway.irys.xyz/",
          gateway: "https://ipfs.io/ipfs/",
          fetchGateway: "https://gateway.pinata.cloud/ipfs/",
          pool: "pump",
        },
        onStatus: (s: string) => setStatus(s),
        onStep: (n: number, state?: string) => stepHook(n, state),
      });
      }
      const sig: string | null = r.sig ?? null;
      setResult({ mint: r.mint, sig, dry });
      setDone(new Set<Step>([1, 2, 3, 4]));
      setStatus(dry ? "Dry run complete. Nothing was broadcast." : "Live. Your coin is on the board and the gate is grading it.");
      if (!dry && sig) {
        // Register with the gate right away so the board shows it before the indexer catches up.
        fetch("/api/mints/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: r.mint, name, symbol: symbol.toUpperCase(), sig, launcher: wallet.publicKey.toBase58(), metadataUri: r.uri ?? null }) }).catch(() => {});
      }
    } catch (ex) {
      const m = ex instanceof Error ? ex.message : String(ex);
      setErr(m);
      setStatus("Not launched. Nothing left your wallet.");
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  const field: React.CSSProperties = { width: "100%", border: "1.5px solid var(--line)", borderRadius: 12, background: "var(--field)", color: "var(--ink)", font: "inherit", fontSize: 16, padding: "13px 14px", outline: "none" };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) clamp(260px,24vw,380px)", gap: 28, alignItems: "start" }} className="launch-grid">
      <form onSubmit={onSubmit} className="card" style={{ display: "grid", gap: 18 }} autoComplete="off" noValidate>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="two">
          <label><span className="lab">Name <i style={{ fontStyle: "normal", textTransform: "none", letterSpacing: 0, opacity: .8 }}>{name.length}/32</i></span><input style={field} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Rocket Frog" required /></label>
          <label><span className="lab">Ticker <i style={{ fontStyle: "normal", textTransform: "none", letterSpacing: 0, opacity: .8 }}>{symbol.length}/10</i></span><input style={{ ...field, textTransform: "uppercase" }} maxLength={10} value={symbol} onChange={(e) => setSymbol(e.target.value.replace(/[^a-z0-9]/gi, ""))} placeholder="FROG" required /></label>
        </div>
        <label><span className="lab">Description <i style={{ fontStyle: "normal", textTransform: "none", letterSpacing: 0, opacity: .8 }}>{desc.length}/500</i></span><textarea style={{ ...field, resize: "vertical" }} maxLength={500} rows={2} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="One line people will actually read." /></label>
        <div>
          <span className="lab">Art <i style={{ fontStyle: "normal", textTransform: "none", letterSpacing: 0, opacity: .8 }}>square works best · png, jpg, gif, webp · up to 4 MB</i></span>
          <label style={{ display: "grid", placeItems: "center", minHeight: 96, border: `1.5px dashed ${image ? "var(--accent)" : "var(--line)"}`, borderRadius: 12, background: "var(--field)", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: 14, textAlign: "center" }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0] ?? null; if (f && f.size > 4 * 1024 * 1024) { setErr("Art must be 4 MB or smaller."); return; } setErr(null); setImage(f); }} />
            {image ? `${image.name} (${(image.size / 1024).toFixed(0)} KB)` : "Drop an image or click to choose"}
          </label>
        </div>

        {TEST_CLUSTER && (
          <p style={{ margin: 0, fontSize: 13, color: "var(--body)", lineHeight: 1.6, borderLeft: "3px solid var(--warn)", paddingLeft: 12 }}>
            <strong>Test cluster ({CLUSTER}).</strong> Launching here creates a Token-2022 test mint with on-chain metadata, mints 1,000,000,000 to your wallet and revokes the mint authority. Art and metadata are stored by this site (mainnet uses Arweave). There is no bonding curve and no PumpPortal on this cluster; the gate grades it against synthetic market rows the engine operator sets.
          </p>
        )}
        <details style={{ borderTop: "1px dashed var(--line)", paddingTop: 12 }} hidden={TEST_CLUSTER}>
          <summary style={{ cursor: "pointer", fontSize: 14, color: "var(--muted)", listStyle: "none" }}>Options</summary>
          <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }} className="three">
              <label><span className="lab">Initial buy (SOL)</span><input style={field} inputMode="decimal" value={buy} onChange={(e) => setBuy(e.target.value)} /></label>
              <label><span className="lab">Slippage %</span><input style={field} inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} /></label>
              <label><span className="lab">Priority fee (SOL)</span><input style={field} inputMode="decimal" value={prio} onChange={(e) => setPrio(e.target.value)} /></label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 14 }} className="three">
              <label><span className="lab">X</span><input style={field} value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="https://x.com/…" /></label>
              <label><span className="lab">Telegram</span><input style={field} value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="https://t.me/…" /></label>
              <label><span className="lab">Website</span><input style={field} value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://…" /></label>
            </div>
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: "var(--muted)", cursor: "pointer" }}>
              <input type="checkbox" checked={vanity} onChange={(e) => setVanity(e.target.checked)} style={{ marginTop: 4 }} />
              <span>Mint address ending in <b style={{ color: "var(--ink)" }}>pump</b>. Grinds in your browser, usually a few minutes, skippable.</span>
            </label>
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>Creating the coin is free. An initial buy pays the router's 0.5 percent fee. Every launch is simulated against our RPC before your wallet is asked to sign; the wallet then shows the exact network fee.</p>
          </div>
        </details>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, color: "var(--muted)", cursor: "pointer" }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} style={{ marginTop: 4 }} />
          <span>I have read the <Link href="/docs/risk">risk disclosure</Link>. I understand HOCK never holds my keys and cannot reverse a launch.</span>
        </label>

        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <button type="submit" className="btn primary" disabled={!canLaunch}>{busy ? "Working…" : dry ? "Dry run" : "Launch it"}</button>
          <div aria-live="polite" style={{ fontSize: 14, color: err ? "var(--danger)" : "var(--muted)", minWidth: 0 }}>{err ?? status}</div>
        </div>

        {(busy || done.size > 0) && (
          <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "repeat(4,minmax(0,1fr))", gap: 8 }}>
            {STEPS.map((s) => (
              <li key={s.id} style={{ fontSize: 12, paddingTop: 8, borderTop: `3px solid ${done.has(s.id) ? "var(--accent)" : step === s.id ? "var(--warn)" : "var(--line)"}`, color: done.has(s.id) ? "var(--accent-2)" : step === s.id ? "var(--ink)" : "var(--muted)", fontWeight: 700 }}>{s.label}</li>
            ))}
          </ol>
        )}

        {result && (
          <div style={{ borderRadius: 14, background: "var(--accent-dim)", padding: "14px 16px", fontSize: 14, lineHeight: 1.7 }}>
            <div><strong>{result.dry ? "Dry run complete." : "Live."}</strong> Mint <code className="mono" style={{ overflowWrap: "anywhere" }}>{result.mint}</code></div>
            {result.sig && <div>Transaction <a href={explorerUrl("tx", result.sig)} target="_blank" rel="noopener noreferrer">{result.sig.slice(0, 8)}…{result.sig.slice(-8)}</a></div>}
            {!result.dry && <div><Link href={`/coin/${result.mint}`} style={{ fontWeight: 800 }}>Open your coin's page</Link> to watch the gate grade it.</div>}
          </div>
        )}
      </form>

      <aside aria-label="Preview" style={{ position: "sticky", top: 16 }}>
        <div style={{ background: "var(--card)", border: "1px solid var(--line)", borderRadius: 20, overflow: "hidden", boxShadow: "var(--shadow-card)" }}>
          <div style={{ aspectRatio: "1/1", background: "var(--panel-2)", display: "grid", placeItems: "center", overflow: "hidden" }}>
            {preview ? <img src={preview} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <span style={{ color: "var(--muted)", fontSize: 13 }}>your art</span>}
          </div>
          <div style={{ padding: "14px 16px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <b style={{ fontSize: 16, overflowWrap: "anywhere" }}>{name || "Your coin"}</b>
              <span style={{ color: "var(--accent-2)", fontWeight: 800, fontSize: 13 }}>${symbol.toUpperCase() || "TICKER"}</span>
            </div>
            <p style={{ margin: "6px 0 0", fontSize: 13, color: "var(--muted)", lineHeight: 1.5, overflowWrap: "anywhere" }}>{desc || "The description shows here."}</p>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, marginTop: 12, fontSize: 11, color: "var(--muted)" }}>
              <span>by <b style={{ color: "var(--ink)" }}>{wallet.publicKey ? `${wallet.publicKey.toBase58().slice(0, 4)}…${wallet.publicKey.toBase58().slice(-4)}` : "you"}</b></span>
              <span className="pill launched">Launched</span>
            </div>
          </div>
        </div>
        <p style={{ margin: "12px 4px 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>This is exactly how the coin's card looks on the board. Once it clears the gate the badge turns to Collateral ready and a Hock button appears.</p>
      </aside>
    </div>
  );
}
