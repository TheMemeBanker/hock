/**
 * The HOCK mark: the tag. A claim ticket with a punched hole and the H cut out of it, so the mark is the
 * letter and the object at once. `tone` is the tag colour. `hot`, when it differs from `tone`, stamps the H
 * in that colour instead of cutting it out (the "lit" state on the launch track). `small` switches to the
 * cut without the H that stays crisp under 32px; there `hot` fills the punched hole instead.
 */
import { memo } from "react";

export const TAG_BODY = "M14 64 L44 26 H110 a10 10 0 0 1 10 10 V92 a10 10 0 0 1 -10 10 H44 Z";
export const TAG_HOLE = "M40 64 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0 Z";
export const TAG_H = "M62 42 H74 V58 H90 V42 H102 V86 H90 V70 H74 V86 H62 Z";
export const TAG_BODY_SMALL = "M10 64 L44 22 H112 a10 10 0 0 1 10 10 V96 a10 10 0 0 1 -10 10 H44 Z";
export const TAG_HOLE_SMALL = "M38 64 a9 9 0 1 0 18 0 a9 9 0 1 0 -18 0 Z";

export const Mark = memo(function Mark({ size = 40, tone = "currentColor", hot, small, label = "HOCK", className }: { size?: number; tone?: string; hot?: string; small?: boolean; label?: string; className?: string }) {
  const s = small || size <= 32;
  const stamped = !!hot && hot !== tone;
  const d = s ? `${TAG_BODY_SMALL} ${TAG_HOLE_SMALL}` : stamped ? `${TAG_BODY} ${TAG_HOLE}` : `${TAG_BODY} ${TAG_HOLE} ${TAG_H}`;
  return (
    <svg viewBox="0 0 128 128" width={size} height={size} role="img" aria-label={label} className={className} style={{ display: "block", flexShrink: 0 }}>
      <path d={d} fill={tone} fillRule="evenodd" />
      {stamped && (s ? <circle cx="47" cy="64" r="6.5" fill={hot} /> : <path d={TAG_H} fill={hot} />)}
    </svg>
  );
});

/** Wordmark lockup: the tag, then HOCK in the display serif. `size` is the cap height in px. */
export function Lockup({ size = 26, tone = "currentColor" }: { size?: number; tone?: string; hot?: string }) {
  const m = Math.round(size * 1.08);
  return (
    <span className="wm lockup" style={{ fontSize: size, color: tone }} aria-label="HOCK">
      <Mark size={m} tone="var(--manila)" small={m <= 32} label="" />
      <span aria-hidden>HOCK</span>
    </span>
  );
}
