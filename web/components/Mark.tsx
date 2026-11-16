/**
 * The HOCK mark: the pawnbroker's three spheres redrawn as circuit nodes.
 * Two ring nodes above, one live node below, joined by a Y of traces.
 * `tone` is the ring and trace colour, `live` the filled node.
 */
export function Mark({ size = 40, tone = "currentColor", live = "var(--accent)", label = "HOCK" }: { size?: number; tone?: string; live?: string; label?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={label} style={{ display: "block", flexShrink: 0 }}>
      <path d="M33.3 35.3 L50 52 L66.7 35.3 M50 52 L50 67" fill="none" stroke={tone} strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="26" cy="28" r="8.5" fill="none" stroke={tone} strokeWidth="5" />
      <circle cx="26" cy="28" r="4" fill={tone} />
      <circle cx="74" cy="28" r="8.5" fill="none" stroke={tone} strokeWidth="5" />
      <circle cx="74" cy="28" r="4" fill={tone} />
      <circle cx="50" cy="78" r="11" fill={live} />
    </svg>
  );
}
