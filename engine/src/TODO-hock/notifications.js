// TODO-hock: operator/user notification sink. The source engine wrote rows to a
// pending_notifications table consumed by a chat bot; HOCK has no delivery
// channel yet. Logs and resolves so callers keep their fire-and-forget shape.
export async function enqueueNotification({ userId, kind, payload }) {
  console.warn(`[notify:TODO-hock] user=${userId} kind=${kind}`, JSON.stringify(payload));
}
