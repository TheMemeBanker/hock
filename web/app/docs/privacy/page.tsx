import { DocShell, H2 } from "@/components/DocShell";

export const metadata = { title: "Privacy" };

export default function Privacy() {
  return (
    <DocShell title="Privacy" kicker="What the site sees, and what it keeps" current="/docs/privacy">
      <H2>No accounts</H2>
      <p>There is no sign-up. You connect a wallet; the site reads public chain state for that address. Disconnecting ends the session.</p>
      <H2>What passes through our servers</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li><strong>RPC proxy.</strong> Read and broadcast calls are forwarded to an RPC provider so its key stays off the client. Requests are rate-limited per IP and not logged beyond what is needed to operate the limiter.</li>
        <li><strong>Upload relay.</strong> Launch metadata and images you choose to publish are relayed to permanent storage. Anything you publish is public and permanent.</li>
        <li><strong>Database reads.</strong> Pages read gate grades, pool snapshots and mint registrations written by the engine. These are derived from public chain and market data.</li>
      </ul>
      <H2>What the engine records</H2>
      <p>Loan and order lifecycle state indexed from the chain, attestation logs, gate grades and a notification outbox for borrowers who opt in. Wallet addresses are public keys; the engine stores no names, emails or device identifiers unless you provide a contact for notifications, in which case it is used only for that purpose.</p>
      <H2>Cookies and analytics</H2>
      <p>No advertising trackers. The site may use local storage for interface preferences such as the last wallet used. No third-party analytics scripts are loaded.</p>
      <H2>Third parties</H2>
      <p>Your browser also talks directly to the launch router, storage gateways and price APIs listed in the site's content-security policy. Their privacy practices are their own.</p>
      <H2>Requests</H2>
      <p>Chain data cannot be deleted. For anything held off chain that identifies you, contact the operator through the source repository linked in the footer.</p>
    </DocShell>
  );
}
