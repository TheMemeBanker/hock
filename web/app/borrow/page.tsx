import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { getCollateralReadyMints } from "@/lib/data/reads";
import { DashboardGate } from "./DashboardGate";

export const revalidate = 30;
export const metadata = { title: "Dashboard" };

export default async function BorrowPage() {
  const readyMints = await getCollateralReadyMints();
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0" }}>
        <DashboardGate readyMints={readyMints} />
      </section>
      <Footer />
    </div>
  );
}
