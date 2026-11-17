/**
 * The HOCK mark: the aperture. Eight swept blades around a hex core, one blade lit.
 * A vault door and an engine in one shape. `small` switches to the six-blade cut that stays crisp under 32px.
 * `tone` is the blade and core colour, `hot` the lit blade and centre.
 */
import { memo } from "react";

const R_OUT = 56, R_IN = 34;
function pt(r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [64 + r * Math.cos(a), 64 + r * Math.sin(a)];
}
function blades(n: number, gap: number, twist: number, lit: number, rOut = R_OUT, rIn = R_IN): { d: string; lit: boolean }[] {
  const step = 360 / n;
  const out: { d: string; lit: boolean }[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = i * step + gap / 2, a1 = (i + 1) * step - gap / 2;
    const [p0x, p0y] = pt(rOut, a0), [p1x, p1y] = pt(rOut, a1);
    const [q1x, q1y] = pt(rIn, a1 + twist), [q0x, q0y] = pt(rIn, a0 + twist);
    out.push({ d: `M${p0x.toFixed(2)} ${p0y.toFixed(2)} A${rOut} ${rOut} 0 0 1 ${p1x.toFixed(2)} ${p1y.toFixed(2)} L${q1x.toFixed(2)} ${q1y.toFixed(2)} A${rIn} ${rIn} 0 0 0 ${q0x.toFixed(2)} ${q0y.toFixed(2)} Z`, lit: i === lit });
  }
  return out;
}
const HEX = (r: number) => "M" + Array.from({ length: 6 }, (_, i) => pt(r, 60 * i - 30).map((v) => v.toFixed(2)).join(" ")).join(" L") + " Z";
const BIG = blades(8, 7, 14, 6);
const SMALL = blades(6, 9, 16, 4, 58, 34);
const HEX_BIG = HEX(19), HEX_SMALL = HEX(18);

export const Mark = memo(function Mark({ size = 40, tone = "currentColor", hot = "var(--accent)", small, label = "HOCK", className }: { size?: number; tone?: string; hot?: string; small?: boolean; label?: string; className?: string }) {
  const set = small || size <= 32 ? SMALL : BIG;
  return (
    <svg viewBox="0 0 128 128" width={size} height={size} role="img" aria-label={label} className={className} style={{ display: "block", flexShrink: 0 }}>
      {set.map((b, i) => <path key={i} d={b.d} fill={b.lit ? hot : tone} />)}
      <path d={small || size <= 32 ? HEX_SMALL : HEX_BIG} fill="none" stroke={tone} strokeWidth={small || size <= 32 ? 7 : 5} strokeLinejoin="round" />
      <circle cx="64" cy="64" r="5" fill={hot} />
    </svg>
  );
});

/** Wordmark lockup: the aperture is the O in HOCK. `size` is the cap height in px. */
export function Lockup({ size = 26, tone = "currentColor", hot = "var(--accent)" }: { size?: number; tone?: string; hot?: string }) {
  const o = Math.round(size * 0.78);
  return (
    <span className="wm lockup" style={{ fontSize: size, color: tone }} aria-label="HOCK">
      <span aria-hidden>H</span>
      <Mark size={o} tone={tone} hot={hot} small={o <= 32} label="" />
      <span aria-hidden>CK</span>
    </span>
  );
}
