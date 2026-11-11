import { redirect } from "next/navigation";

/** /dashboard is the name people reach for; the page lives at /borrow. */
export default function DashboardRedirect() {
  redirect("/borrow");
}
