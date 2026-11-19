"use client";

import { useState } from "react";
import { Mark } from "./Mark";
import { HOCK_CA, HOCK_PUMP_URL } from "@/lib/token";

/**
 * The $HOCK slot on the home page. Pending: the contract address is published here first and every other
 * $HOCK is an impostor. Published: the full address, click to copy, and the pump.fun link.
 */
export function HockStrip() {
  const [copied, setCopied] = useState(false);
  function copy() {
    if (!HOCK_CA) return;
    try { void navigator.clipboard?.writeText(HOCK_CA); setCopied(true); setTimeout(() => setCopied(false), 1400); } catch {}
  }
  const code = { fontSize: 12, background: "var(--field)", padding: "10px 14px", borderRadius: "var(--radius-sm)", border: "1px solid var(--line)" } as const;
  return (
    <div className="ca-strip" id="hock">
      <Mark size={28} tone="var(--manila)" />
      <span className="wm" style={{ fontSize: 20, color: "var(--ink)" }}>$HOCK</span>
      {HOCK_CA ? (
        <>
          <span>The official $HOCK contract address. Anything else using the name is an impostor.</span>
          <button type="button" className="mono ca-copy" onClick={copy} title="Click to copy" aria-label={`Copy contract address ${HOCK_CA}`} style={{ ...code, marginLeft: "auto", color: "var(--ink)", cursor: "pointer", wordBreak: "break-all", textAlign: "left" }}>
            {copied ? "Copied" : HOCK_CA}
          </button>
          <a className="btn line" href={HOCK_PUMP_URL} target="_blank" rel="noopener noreferrer">pump.fun</a>
        </>
      ) : (
        <>
          <span>The contract address is published here first. Until it appears on this page, every $HOCK is an impostor.</span>
          <code className="mono" style={{ ...code, marginLeft: "auto", color: "var(--muted)" }}>not yet published</code>
        </>
      )}
    </div>
  );
}
