import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { LaunchForm } from "./LaunchForm";

export const metadata = { title: "Launch a coin" };

export default function LaunchPage() {
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, flexWrap: "wrap", marginBottom: 12 }}>
          <h1 className="wm" style={{ margin: 0, fontSize: "clamp(40px,5vw,72px)", lineHeight: 1 }}>Launch a coin</h1>
          <span style={{ fontSize: 16, color: "var(--muted)" }}>One signature. Free to create. Born collateral.</span>
        </div>
        <p style={{ margin: "0 0 28px", maxWidth: "70ch", color: "var(--body)" }}>
          Name it, drop the art, sign once. The art and metadata are stored permanently on Arweave, the mint keypair is generated in your browser, and the create transaction is simulated before you ever see a signature prompt. The moment it confirms, your coin is on the board and the gate starts grading it.
        </p>
        <LaunchForm />
      </section>
      <Footer />
    </div>
  );
}
