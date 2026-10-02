import type { Queryable } from "../db/db";

/**
 * Отменяет ещё не выполненные задания публикации (в очереди и ожидающие человека)
 * и закрывает связанные задачи ручной публикации и разбора блокировки.
 * Запланированные материалы без задания возвращаются в «согласован», чтобы не висеть в календаре.
 */
export async function cancelPendingJobs(
  q: Queryable,
  where: { contentItemId?: string; accountId?: string; clientId?: string },
  code: string,
  opts: { resetScheduled?: boolean } = {},
): Promise<string[]> {
  const [col, val] = where.contentItemId ? ["content_item_id", where.contentItemId] : where.accountId ? ["account_id", where.accountId] : ["client_id", where.clientId];
  if (!val) throw new Error("cancelPendingJobs: не задана область");
  const rows = (await q.query(
    `UPDATE publication_jobs SET status = 'cancelled', last_error_code = $2, lease_owner = NULL, lease_until = NULL, updated_at = now()
      WHERE ${col} = $1 AND status IN ('queued', 'awaiting_human') RETURNING id, content_item_id`, [val, code])).rows as { id: string; content_item_id: string }[];
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await q.query("SELECT app_close_job_tasks($1::uuid[])", [ids]);
  if (opts.resetScheduled) {
    await q.query("UPDATE content_items SET state = 'approved', scheduled_at = NULL, updated_at = now(), row_version = row_version + 1 WHERE id = ANY($1::uuid[]) AND state = 'scheduled'",
      [[...new Set(rows.map((r) => r.content_item_id))]]);
  }
  return ids;
}
