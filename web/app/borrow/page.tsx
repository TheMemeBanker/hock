import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { PageIntro } from "@/components/PageIntro";
import { getCollateralReadyMints } from "@/lib/data/reads";
import { Tickets } from "./Tickets";

export const revalidate = 30;
export const metadata = { title: "Borrow" };

export default async function BorrowPage() {
  const readyMints = await getCollateralReadyMints();
  return (
    <div className="wrap">
      <Header />
      <section style={{ padding: "clamp(40px,5vw,72px) 0" }}>
        <PageIntro title="Borrow" kicker="Your tickets, read from chain">
          Every open loan for the connected wallet, with the actions the program allows: repay, partial repay, add collateral, extend, arm or disarm a limit-close. Each action is simulated against the live chain before your wallet is asked to sign.
        </PageIntro>
        <Tickets readyMints={readyMints} />
      </section>
      <Footer />
    </div>
  );
}
