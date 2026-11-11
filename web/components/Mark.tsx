/** The HOCK mark: the pawnbroker's sign rebuilt as a launch gantry. Rail, three stems, three coins. */
export function Mark({ size = 40, rail = "#141414", coin = "#FFB800", label = "HOCK" }: { size?: number; rail?: string; coin?: string; label?: string }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} role="img" aria-label={label}>
      <rect x="10" y="8" width="80" height="12" rx="6" fill={rail} />
      <rect x="27" y="18" width="6" height="14" fill={rail} />
      <rect x="67" y="18" width="6" height="14" fill={rail} />
      <rect x="47" y="18" width="6" height="48" fill={rail} />
      <circle cx="30" cy="46" r="16" fill={coin} />
      <circle cx="70" cy="46" r="16" fill={coin} />
      <circle cx="50" cy="80" r="16" fill={coin} />
    </svg>
  );
}
