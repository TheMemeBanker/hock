import Link from "next/link";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";

export default function NotFound() {
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(64px,10vw,140px) 0", display: "flex", flexDirection: "column", gap: 18, alignItems: "flex-start" }}>
        <span className="lab">404</span>
        <h1 className="wm" style={{ margin: 0, fontSize: "clamp(40px,6vw,88px)", lineHeight: 1 }}>Nothing hocked here.</h1>
        <p style={{ margin: 0, maxWidth: "56ch", color: "var(--body)" }}>That page does not exist. If you followed a coin link, check the full mint address against the board; the site never shortens addresses.</p>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <Link className="btn primary" href="/board">The board</Link>
          <Link className="btn line" href="/">Home</Link>
        </div>
      </section>
      <Footer />
    </div>
  );
}
