// TODO-hock: operator alert channel. The source bot DM'd an admin chat id;
// HOCK has no operator channel wired yet. getAdminId() reads HOCK_ADMIN_ID
// so the watchdog can arm itself; notifyAdmin() logs until a channel exists.
export function getAdminId() {
  const id = Number(process.env.HOCK_ADMIN_ID);
  return Number.isFinite(id) && id > 0 ? id : null;
}
export async function notifyAdmin(_bot, text) {
  console.warn("[admin-notify:TODO-hock]\n" + text);
}
