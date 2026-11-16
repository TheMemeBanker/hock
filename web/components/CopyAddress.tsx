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
    <span className="copy-addr">
      {label && <span className="lab">{label}</span>}
      <code className="mono" style={{ fontSize: size }}>{value}</code>
      <button type="button" onClick={copy} className="btn line inline" style={{ minHeight: 32, padding: "0 12px", fontSize: 12 }} aria-label={`Copy ${label ?? "address"}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
