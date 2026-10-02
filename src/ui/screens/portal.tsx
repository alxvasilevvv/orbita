import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, EV_RU, useMe } from "../lib";

const SCOPE_RU: Record<string, string> = { publish_post: "Публикация", comment: "Комментарии", react: "Реакции", analytics_read: "Чтение аналитики", profile_edit_tasks: "Задачи по профилю", ai_processing: "Обработка AI" };

/** Кабинет клиента: согласование, план, опубликованное, отчёты, согласия. Без внутренних задач и затрат. */
export function PortalPage() {
  const s = useApi<any>("/api/portal");
  const me = useMe();
  const { busy, run } = useAction();
  const [comments, setComments] = useState<Record<string, string>>({});
  return (
    <>
      <h1>{t("Кабинет клиента")}</h1>
      <p className="lede">{me?.display_name}. {t("Здесь вы согласуете материалы, видите план и результаты, управляете согласиями.")}</p>
      <Loadable s={s}>{(d) => d.accounts.length === 0 ? <div className="empty">{t("У вас пока нет доступных аккаунтов.")}</div> : d.accounts.map((a: any) => (
        <section key={a.account.id} className="portal-acc">
          <h2>{a.account.display_name} <span className="muted small">{a.account.client_name}</span></h2>
          {a.strategy && <p className="small">{t("Цель")}: <b>{a.strategy.goal}</b> · {t("Частота")}: {a.strategy.posts_per_week} {t("в неделю")} · {t("Направления")}: {(a.strategy.pillars ?? []).join(", ")}</p>}
          <h3>{t("Ждут вашего согласования")}</h3>
          {a.approvals.length === 0 ? <p className="muted small">{t("Сейчас ничего не ждёт вашего решения.")}</p> : <div className="list">{a.approvals.map((x: any) => (
            <div key={x.approval_request_id} className="item">
              <div className="spread"><b>{x.title}</b><span className="small muted">{t("Версия")} {x.version}{x.due_at ? ` · ${t("план")} ${fmt(x.due_at, a.account.timezone)}` : ""}</span></div>
              <div className="post" style={{ marginTop: 6 }}>{x.body}</div>
              {x.media_ids?.length > 0 && <p className="small muted">{t("Вложений")}: {x.media_ids.length}</p>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/content/${x.content_item_id}/decision`, { body: { decision: "approved", approval_request_id: x.approval_request_id } }), "Версия согласована", s.reload)}>{t("Согласовать версию")} {x.version}</button>
                <input type="text" placeholder={t("Что изменить")} value={comments[x.approval_request_id] ?? ""} onChange={(e) => setComments({ ...comments, [x.approval_request_id]: e.target.value })} style={{ minWidth: 260 }} />
                <button className="btn" disabled={busy || !(comments[x.approval_request_id] ?? "").trim()} onClick={() => run(() => api(`/api/content/${x.content_item_id}/decision`, { body: { decision: "changes_requested", comment: comments[x.approval_request_id], approval_request_id: x.approval_request_id } }), "Правки отправлены команде", s.reload)}>{t("Запросить правки")}</button>
              </div>
            </div>))}</div>}
          <div className="grid cols-2" style={{ marginTop: 14 }}>
            <div className="panel">
              <h3>{t("Запланировано")}</h3>
              {a.upcoming.length === 0 ? <p className="muted small">{t("Нет запланированных публикаций.")}</p> : <ul>{a.upcoming.map((u: any, i: number) => <li key={i}>{u.title}, {fmt(u.scheduled_at, a.account.timezone)}</li>)}</ul>}
            </div>
            <div className="panel">
              <h3>{t("Опубликовано")}</h3>
              {a.published.length === 0 ? <p className="muted small">{t("Публикаций пока нет.")}</p> : <ul className="plain">{a.published.map((p: any, i: number) => <li key={i} className={`ev ${p.evidence_type}`}>{p.url ? <a href={p.url} target="_blank" rel="noreferrer">{p.title}</a> : p.title} <span className={`evlabel ${p.evidence_type}`}>{t(EV_RU[p.evidence_type])}</span><div className="small muted">{fmt(p.published_at, a.account.timezone)}</div></li>)}</ul>}
            </div>
            <div className="panel">
              <h3>{t("Отчёты")}</h3>
              {a.reports.length === 0 ? <p className="muted small">{t("Отчёты появятся после проверки командой.")}</p> : <ul>{a.reports.map((r: any) => <li key={r.id}><a href={`#/reports/${r.id}`}>{r.kind === "monthly" ? t("Ежемесячный отчёт") : t("Еженедельный отчёт")} {String(r.period_start).slice(0, 10)} – {String(r.period_end).slice(0, 10)}</a></li>)}</ul>}
            </div>
            <div className="panel">
              <h3>{t("Ваши согласия")}</h3>
              <p className="small muted">{t("Отзыв согласия на публикацию сразу отменяет ещё не отправленные публикации.")}</p>
              <ul className="plain">{a.consents.map((c: any) => <li key={c.id} className="spread"><span>{t(SCOPE_RU[c.action_scope] ?? c.action_scope)} {c.revoked_at ? <span className="muted small">({t("отозвано")} {fmt(c.revoked_at)})</span> : null}</span>
                {!c.revoked_at && <button className="btn small danger" disabled={busy} onClick={() => run(() => api(`/api/accounts/${a.account.id}/consents/${c.action_scope}/revoke`, { body: {} }), "Согласие отозвано", s.reload)}>{t("Отозвать")}</button>}</li>)}</ul>
            </div>
          </div>
        </section>))}</Loadable>
    </>
  );
}
