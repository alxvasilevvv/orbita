-- Закрытие задач по заданиям публикации и причина отмены материала.
-- Задачи закрыты для представителей клиента (RLS, app.internal), но отзыв согласия клиентом
-- должен отменить задачу ручной публикации. Функция меняет только задачи, чьё задание
-- уже отменено (или снова поставлено в очередь), поэтому не даёт доступа сверх уже сделанного.
CREATE OR REPLACE FUNCTION app_close_job_tasks(p_jobs uuid[]) RETURNS int
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH upd AS (
    UPDATE tasks t SET status = 'cancelled', completed_at = now()
      FROM publication_jobs j
     WHERE j.id = ANY(p_jobs)
       AND t.status IN ('open', 'in_progress', 'blocked')
       AND ((j.status = 'cancelled' AND t.source_ref IN ('assisted:' || j.id, 'publish_blocked:' || j.id))
         OR (j.status IN ('queued', 'leased', 'succeeded') AND t.source_ref = 'publish_blocked:' || j.id))
    RETURNING t.id)
  SELECT count(*)::int FROM upd
$$;
GRANT EXECUTE ON FUNCTION app_close_job_tasks(uuid[]) TO app_user;

ALTER TABLE content_items ADD COLUMN cancel_reason text;
