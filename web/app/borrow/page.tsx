import { redirect } from "next/navigation";

/** The dashboard lives at /dashboard; /borrow is kept as an alias for older links. */
export default function BorrowRedirect() {
  redirect("/dashboard");
}
