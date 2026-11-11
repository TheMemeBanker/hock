"use client";

import { useState } from "react";

/** Full address, never truncated, with a copy control. */
export function CopyAddress({ value, label, size = 13 }: { value: string; label?: string; size?: number }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable: the full value is on screen */
    }
  }
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", maxWidth: "100%" }}>
      {label && <span className="lab">{label}</span>}
      <code className="mono" style={{ fontSize: size, color: "var(--body)", background: "#fff", padding: "6px 10px", borderRadius: 8, border: "1px solid var(--line)", overflowWrap: "anywhere" }}>{value}</code>
      <button type="button" onClick={copy} className="btn line" style={{ minHeight: 32, padding: "0 12px", fontSize: 12 }} aria-label={`Copy ${label ?? "address"}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
