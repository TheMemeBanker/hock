import Link from "next/link";
import { Mark } from "./Mark";

/**
 * The empty-board state: instead of a blank table, the track a coin runs on HOCK.
 * Launched -> the $50k line -> collateral ready. The aperture lights up as it crosses.
 */
export function LaunchTrack({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`track${compact ? " compact" : ""}`} role="img" aria-label="A coin launches, clears the $50,000 market cap line, and becomes collateral.">
      <div className="track-rail" aria-hidden>
        <i className="track-fill" />
        <b className="track-line" />
      </div>
      <ol className="track-steps">
        <li>
          <span className="track-node"><Mark size={22} tone="var(--line-2)" hot="var(--line-2)" small /></span>
          <span className="lab">00:00</span>
          <strong>Launched</strong>
          <small>One signature. Art and metadata stored for good. Live on the curve and on this board within a minute.</small>
        </li>
        <li>
          <span className="track-node grading"><Mark size={22} tone="var(--muted)" hot="var(--warn)" small /></span>
          <span className="lab">Grading</span>
          <strong>Climbing to $50k</strong>
          <small>Market cap read live. Under the line the gate also checks that the coin can actually be sold.</small>
        </li>
        <li>
          <span className="track-node ready"><Mark size={22} tone="var(--ink)" hot="var(--accent)" small /></span>
          <span className="lab">$50,000</span>
          <strong>Collateral ready</strong>
          <small>Borrowing opens. Lock the coin in the vault, take SOL from the pool, repay to unlock.</small>
        </li>
      </ol>
      {!compact && (
        <div className="track-foot">
          <span className="mono" style={{ color: "var(--muted)", fontSize: 13 }}>Nothing launched yet. The first coin on HOCK appears here the moment its transaction confirms.</span>
          <Link className="btn primary" href="/launch" style={{ minHeight: 44, padding: "0 18px", fontSize: 13 }}>Be the first</Link>
        </div>
      )}
    </div>
  );
}
