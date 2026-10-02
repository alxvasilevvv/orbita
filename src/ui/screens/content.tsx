import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useAction, useToast, Loadable, go, fmt, State, STATE_RU, EV_RU, MODE_RU, KIND_RU, type LoadState, t, num } from "../lib";
import { tx } from "../i18n";
import { MediaLibrary } from "./account-extra";

/* ---------- редактор материала ---------- */
export function ContentPage({ id }: { id: string }) {
  const s = useApi<any>(`/api/content/${id}`);
  const me = useApi<any>("/api/me");
  const { busy, run } = useAction();
  const [body, setBody] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [comment, setComment] = useState("");
  const [when, setWhen] = useState("");
  const [amb, setAmb] = useState<null | { earlier_utc: string; later_utc: string }>(null);
  const [url, setUrl] = useState("");
  const [media, setMedia] = useState<string[] | null>(null);
  const [review, setReview] = useState<any | null>(null);
  const acc = useApiAccount(me.data?.internal ? s.data?.item?.account_id : undefined);
  return (
    <Loadable s={s}>{(d) => {
      const it = d.item; const cur = d.versions[0]; const text = body ?? cur?.body ?? "";
      const curMedia: string[] = cur?.media_ids ?? [];
      const selMedia = media ?? curMedia;
      const mediaChanged = media !== null && JSON.stringify([...media].sort()) !== JSON.stringify([...curMedia].sort());
      const dirty = (body !== null && body !== cur?.body) || mediaChanged;
      const perms: string[] = acc?.permissions ?? [];
      const can = (op: string) => perms.includes(op);
      const job = d.jobs[0];
      const after = () => { setBody(null); setMedia(null); s.reload(); };
      const schedule = (ambiguity?: string) => run(async () => {
        try { await api(`/api/content/${id}/schedule`, { body: { local_time: when, ...(ambiguity ? { ambiguity } : {}) } }); setAmb(null); }
        catch (e: any) { if (e.details?.earlier_utc) setAmb(e.details); throw e; }
      }, "Публикация запланирована", after);
      return (
        <>
          {acc && <a href={`#/accounts/${it.account_id}`} className="small">{acc.account.display_name}</a>}
          <div className="spread"><h1>{it.title}</h1><State s={it.state} /></div>
          <p className="lede">{t("Версия")} {cur?.version ?? 0}{cur?.origin === "ai_draft" ? t(", черновик AI (требует редактуры)") : ""}{t(". Часовой пояс аккаунта")} {acc?.account.timezone}.</p>
          {d.readiness.length > 0 && <div className="notice" style={{ marginBottom: 14 }}><b>{t("Публикация заблокирована:")}</b><ul style={{ margin: "4px 0 0" }}>{d.readiness.map((r: string) => <li key={r}>{tx(r)}</li>)}</ul></div>}
          {it.state === "publication_unknown" && <div className="notice error" style={{ marginBottom: 14 }}>{t("LinkedIn не подтвердил результат. Откройте профиль и проверьте, вышел ли пост. Не публикуйте повторно до проверки.")}</div>}
          <div className="grid cols-2">
            <div className="grid">
              {can("edit_content") && !["published", "publishing", "publication_unknown", "archived", "cancelled"].includes(it.state) ? <>
                <label className="field">{t("Текст публикации")}<textarea value={text} onChange={(e) => setBody(e.target.value)} /></label>
                <p className={`small num ${text.length > 3000 ? "bad" : "muted"}`}>{num(text.length)} / 3000 {t("символов")}</p>
                {["approved", "scheduled", "client_review"].includes(it.state) && dirty && <p className="small" style={{ color: "var(--ev-manual)" }}>{t("Сохранение новой версии аннулирует текущее согласование.")}</p>}
                <div className="row">
                  <button className="btn primary" disabled={busy || !dirty || !text.trim()} onClick={() => run(() => api(`/api/content/${id}/versions`, { body: { body: text, media_ids: selMedia } }), "Версия сохранена", after)}>{t("Сохранить версию")}</button>
                  {["draft", "changes_requested"].includes(it.state) && <button className="btn" disabled={busy || !cur || dirty} onClick={() => run(() => api(`/api/content/${id}/submit`, { body: {} }), "Отправлено редактору", after)}>{t("Отправить редактору")}</button>}
                </div>
                {can("run_ai") && <div className="row"><input type="text" placeholder={t("Тема для AI-черновика")} value={topic} onChange={(e) => setTopic(e.target.value)} /><button className="btn" disabled={busy || !topic} onClick={() => run(() => api(`/api/content/${id}/ai-draft`, { body: { topic } }), "AI-черновик создан как новая версия", after)}>{t("Создать AI-черновик")}</button></div>}
                {can("run_ai") && cur && <div className="row">
                  <button className="btn" disabled={busy} onClick={() => run(async () => setReview(await api(`/api/content/${id}/ai-review`, { body: { role: "editor" } })), "AI-проверка готова")}>{t("AI-проверка редактора")}</button>
                  <button className="btn" disabled={busy} onClick={() => run(async () => setReview(await api(`/api/content/${id}/ai-review`, { body: { role: "fact_checker" } })), "Проверка фактов готова")}>{t("Проверить факты")}</button>
                </div>}
                {review && <AiReview r={review} onClose={() => setReview(null)} />}
                {acc && can("edit_content") && <MediaLibrary accountId={it.account_id} selectable selected={selMedia} onToggle={(mid) => setMedia(selMedia.includes(mid) ? selMedia.filter((x) => x !== mid) : [...selMedia, mid])} />}
              </> : cur ? <><div className="post">{cur.body}</div>{curMedia.length > 0 && <p className="small muted">{t("Вложений")}: {curMedia.length}</p>}</> : <div className="empty">{t("Текста ещё нет.")}</div>}
              <p className="muted small">{t("Предпросмотр приблизительный: LinkedIn может обрезать текст и отображать его иначе.")}</p>
            </div>
            <div className="grid" style={{ alignContent: "start" }}>
              {["editorial_review", "client_review"].includes(it.state) && (can(it.state === "editorial_review" ? "editorial_approve" : "client_approve")) && <div className="panel grid">
                <h3>{it.state === "editorial_review" ? t("Редакторская проверка") : t("Согласование клиента")} {t("версии")} {cur.version}</h3>
                {cur.created_by === me.data?.id && <p className="small" style={{ color: "var(--ev-fail)" }}>{t("Вы автор этой версии и не можете её согласовать.")}</p>}
                <textarea style={{ minHeight: 70 }} placeholder={t("Комментарий (обязателен при запросе правок)")} value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/content/${id}/decision`, { body: { decision: "approved", comment: comment || undefined } }), "Версия согласована", after)}>{t("Согласовать версию")} {cur.version}</button>
                  <button className="btn" disabled={busy || !comment} onClick={() => run(() => api(`/api/content/${id}/decision`, { body: { decision: "changes_requested", comment } }), "Правки запрошены", after)}>{t("Запросить правки")}</button>
                </div>
              </div>}
              {it.state === "approved" && can("schedule") && <div className="panel grid">
                <h3>{t("Запланировать публикацию")}</h3>
                <label className="field">{t("Время в часовом поясе аккаунта (")}{acc?.account.timezone})<input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setAmb(null); }} /></label>
                {amb ? <div className="row"><span className="small">{t("Время встречается дважды:")}</span><button className="btn" onClick={() => schedule("earlier")}>{t("Раньше (")}{fmt(amb.earlier_utc, "UTC")})</button><button className="btn" onClick={() => schedule("later")}>{t("Позже (")}{fmt(amb.later_utc, "UTC")})</button></div>
                  : <button className="btn primary" disabled={busy || !when} onClick={() => schedule()}>{t("Запланировать публикацию")}</button>}
              </div>}
              {["approved", "scheduled"].includes(it.state) && job?.mode === "assisted" && can("publish") && <div className="panel grid">
                <h3>{t("Публикация через человека")}</h3>
                <p className="small">{t("Автоматическая публикация недоступна. Опубликуйте текст в LinkedIn вручную и вставьте ссылку на пост. Запись будет помечена как ручная отметка, а не подтверждение API.")}</p>
                <div className="row"><input type="url" placeholder="https://www.linkedin.com/feed/update/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 300 }} /><button className="btn primary" disabled={busy || !url} onClick={() => run(() => api(`/api/content/${id}/mark-published`, { body: { url } }), "Публикация отмечена", after)}>{t("Отметить публикацию")}</button></div>
              </div>}
              {it.state === "publication_unknown" && can("publish") && <div className="panel grid">
                <h3>{t("Разрешить неопределённость")}</h3>
                <div className="row"><input type="url" placeholder={t("Ссылка, если пост вышел")} value={url} onChange={(e) => setUrl(e.target.value)} /><button className="btn primary" disabled={busy || !url} onClick={() => run(() => api(`/api/content/${id}/resolve-unknown`, { body: { outcome: "published", url } }), "Отмечено как опубликованное", after)}>{t("Пост вышел")}</button></div>
                <div className="row"><input type="text" placeholder={t("Что проверили")} value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn" disabled={busy || !comment} onClick={() => run(() => api(`/api/content/${id}/resolve-unknown`, { body: { outcome: "not_published", comment } }), "Отмечено: пост не вышел", after)}>{t("Пост не вышел")}</button></div>
              </div>}
              {d.publication && <div className={`panel ev ${d.publication.evidence_type}`}><h3>{t("Опубликовано")}</h3><p className={`evlabel ${d.publication.evidence_type}`}>{t(EV_RU[d.publication.evidence_type])}</p>{d.publication.url && <a href={d.publication.url} target="_blank" rel="noreferrer">{t("Открыть пост")}</a>}{d.publication.external_id && <div className="small muted">{d.publication.external_id}</div>}</div>}
              {job && <div className="panel small"><h3>{t("Задание публикации")}</h3><dl className="kv"><dt>{t("Режим")}</dt><dd><span className={`mode ${job.mode}`}>{t(MODE_RU[job.mode])}</span></dd><dt>{t("Статус")}</dt><dd>{job.status}</dd><dt>{t("Попыток")}</dt><dd className="num">{job.attempts}</dd><dt>{t("Время")}</dt><dd className="num">{fmt(job.run_at, acc?.account.timezone)}</dd>{job.last_error && <><dt>{t("Причина")}</dt><dd>{job.last_error}</dd></>}</dl></div>}
              <div className="panel small"><h3>{t("История согласований")}</h3>{d.approvals.length === 0 ? <p className="muted">{t("Ещё не отправлялся на согласование.")}</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{d.approvals.map((a: any) => <li key={a.id}>{a.stage === "editorial" ? t("Редактор") : t("Клиент")}: {a.status === "invalidated" ? t("аннулировано новой версией") : a.status === "approved" ? t("согласовано") : a.status === "pending" ? t("ожидает") : t("нужны правки")}{a.decisions?.[0]?.comment ? `, «${a.decisions[0].comment}»` : ""}</li>)}</ul>}</div>
            </div>
          </div>
          <h2>{t("Версии")}</h2>
          <div className="list">{d.versions.map((v: any) => <details key={v.id} className="item"><summary>{t("Версия")} {v.version}, {v.origin === "ai_draft" ? "AI" : t("человек")}, {fmt(v.created_at)}</summary><div className="post" style={{ marginTop: 8 }}>{v.body}</div></details>)}</div>
        </>
      );
    }}</Loadable>
  );
}
// Права и часовой пояс аккаунта для редактора.
export const accCache = new Map<string, any>();
export function useApiAccount(accountId?: string) {
  const [a, setA] = useState<any>(accountId ? accCache.get(accountId) : undefined);
  useEffect(() => { if (accountId) api(`/api/accounts/${accountId}`).then((d) => { accCache.set(accountId, d); setA(d); }).catch(() => {}); }, [accountId]);
  return a;
}


/** Редакторская оценка AI: баллы с причинами. Это рекомендация, а не прогноз охвата. */
function AiReview({ r, onClose }: { r: any; onClose: () => void }) {
  return (
    <div className="panel ai-review">
      <div className="spread"><h3>{r.task_type === "fact_check" ? t("Проверка фактов") : t("Редакторская оценка AI")}</h3><button className="btn link small" onClick={onClose}>{t("Скрыть")}</button></div>
      <p className="small muted">{t("Оценка AI: редакторская рекомендация, а не прогноз охвата.")}</p>
      {r.scores?.length > 0 && <table className="small"><tbody>{r.scores.map((x: any) => (
        <tr key={x.criterion}><td>{t(x.criterion)}</td><td><span className="score" aria-label={`${x.score} / 5`}>{"●".repeat(x.score)}<span className="off">{"●".repeat(5 - x.score)}</span></span></td><td className="muted">{x.reason}</td></tr>))}</tbody></table>}
      {r.unverified_claims?.length > 0 && <div className="notice small" style={{ marginTop: 8 }}><b>{t("Без подтверждения")}:</b><ul style={{ margin: "4px 0 0" }}>{r.unverified_claims.map((c: string) => <li key={c}>{c}</li>)}</ul></div>}
      {r.risk_flags?.length > 0 && <p className="small" style={{ color: "var(--ev-fail)" }}>{t("Риски")}: {r.risk_flags.join("; ")}</p>}
      {r.review_notes?.length > 0 && <ul className="small">{r.review_notes.map((n: string) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}
