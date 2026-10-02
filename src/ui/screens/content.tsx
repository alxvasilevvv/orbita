import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useAction, useToast, Loadable, go, fmt, State, STATE_RU, EV_RU, MODE_RU, KIND_RU, type LoadState } from "../lib";

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
  const acc = useApiAccount(s.data?.item?.account_id);
  return (
    <Loadable s={s}>{(d) => {
      const it = d.item; const cur = d.versions[0]; const text = body ?? cur?.body ?? "";
      const perms: string[] = acc?.permissions ?? [];
      const can = (op: string) => perms.includes(op);
      const job = d.jobs[0];
      const after = () => { setBody(null); s.reload(); };
      const schedule = (ambiguity?: string) => run(async () => {
        try { await api(`/api/content/${id}/schedule`, { body: { local_time: when, ...(ambiguity ? { ambiguity } : {}) } }); setAmb(null); }
        catch (e: any) { if (e.details?.earlier_utc) setAmb(e.details); throw e; }
      }, "Публикация запланирована", after);
      return (
        <>
          {acc && <a href={`#/accounts/${it.account_id}`} className="small">{acc.account.display_name}</a>}
          <div className="spread"><h1>{it.title}</h1><State s={it.state} /></div>
          <p className="lede">Версия {cur?.version ?? 0}{cur?.origin === "ai_draft" ? ", черновик AI (требует редактуры)" : ""}. Часовой пояс аккаунта {acc?.account.timezone}.</p>
          {d.readiness.length > 0 && <div className="notice" style={{ marginBottom: 14 }}><b>Публикация заблокирована:</b><ul style={{ margin: "4px 0 0" }}>{d.readiness.map((r: string) => <li key={r}>{r}</li>)}</ul></div>}
          {it.state === "publication_unknown" && <div className="notice error" style={{ marginBottom: 14 }}>LinkedIn не подтвердил результат. Откройте профиль и проверьте, вышел ли пост. Не публикуйте повторно до проверки.</div>}
          <div className="grid cols-2">
            <div className="grid">
              {can("edit_content") && !["published", "publishing", "publication_unknown", "archived", "cancelled"].includes(it.state) ? <>
                <label className="field">Текст публикации<textarea value={text} onChange={(e) => setBody(e.target.value)} /></label>
                {["approved", "scheduled", "client_review"].includes(it.state) && body !== null && <p className="small" style={{ color: "var(--ev-manual)" }}>Сохранение новой версии аннулирует текущее согласование.</p>}
                <div className="row">
                  <button className="btn primary" disabled={busy || body === null || body === cur?.body} onClick={() => run(() => api(`/api/content/${id}/versions`, { body: { body: text } }), "Версия сохранена", after)}>Сохранить версию</button>
                  {["draft", "changes_requested"].includes(it.state) && <button className="btn" disabled={busy || !cur || body !== null} onClick={() => run(() => api(`/api/content/${id}/submit`, { body: {} }), "Отправлено редактору", after)}>Отправить редактору</button>}
                </div>
                {can("run_ai") && <div className="row"><input type="text" placeholder="Тема для AI-черновика" value={topic} onChange={(e) => setTopic(e.target.value)} /><button className="btn" disabled={busy || !topic} onClick={() => run(() => api(`/api/content/${id}/ai-draft`, { body: { topic } }), "AI-черновик создан как новая версия", after)}>Создать AI-черновик</button></div>}
              </> : cur ? <div className="post">{cur.body}</div> : <div className="empty">Текста ещё нет.</div>}
              <p className="muted small">Предпросмотр приблизительный: LinkedIn может обрезать текст и отображать его иначе.</p>
            </div>
            <div className="grid" style={{ alignContent: "start" }}>
              {["editorial_review", "client_review"].includes(it.state) && (can(it.state === "editorial_review" ? "editorial_approve" : "client_approve")) && <div className="panel grid">
                <h3>{it.state === "editorial_review" ? "Редакторская проверка" : "Согласование клиента"} версии {cur.version}</h3>
                {cur.created_by === me.data?.id && <p className="small" style={{ color: "var(--ev-fail)" }}>Вы автор этой версии и не можете её согласовать.</p>}
                <textarea style={{ minHeight: 70 }} placeholder="Комментарий (обязателен при запросе правок)" value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/content/${id}/decision`, { body: { decision: "approved", comment: comment || undefined } }), "Версия согласована", after)}>Согласовать версию {cur.version}</button>
                  <button className="btn" disabled={busy || !comment} onClick={() => run(() => api(`/api/content/${id}/decision`, { body: { decision: "changes_requested", comment } }), "Правки запрошены", after)}>Запросить правки</button>
                </div>
              </div>}
              {it.state === "approved" && can("schedule") && <div className="panel grid">
                <h3>Запланировать публикацию</h3>
                <label className="field">Время в часовом поясе аккаунта ({acc?.account.timezone})<input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setAmb(null); }} /></label>
                {amb ? <div className="row"><span className="small">Время встречается дважды:</span><button className="btn" onClick={() => schedule("earlier")}>Раньше ({fmt(amb.earlier_utc, "UTC")})</button><button className="btn" onClick={() => schedule("later")}>Позже ({fmt(amb.later_utc, "UTC")})</button></div>
                  : <button className="btn primary" disabled={busy || !when} onClick={() => schedule()}>Запланировать публикацию</button>}
              </div>}
              {["approved", "scheduled"].includes(it.state) && job?.mode === "assisted" && can("publish") && <div className="panel grid">
                <h3>Публикация через человека</h3>
                <p className="small">Автоматическая публикация недоступна. Опубликуйте текст в LinkedIn вручную и вставьте ссылку на пост. Запись будет помечена как ручная отметка, а не подтверждение API.</p>
                <div className="row"><input type="url" placeholder="https://www.linkedin.com/feed/update/…" value={url} onChange={(e) => setUrl(e.target.value)} style={{ minWidth: 300 }} /><button className="btn primary" disabled={busy || !url} onClick={() => run(() => api(`/api/content/${id}/mark-published`, { body: { url } }), "Публикация отмечена", after)}>Отметить публикацию</button></div>
              </div>}
              {it.state === "publication_unknown" && can("publish") && <div className="panel grid">
                <h3>Разрешить неопределённость</h3>
                <div className="row"><input type="url" placeholder="Ссылка, если пост вышел" value={url} onChange={(e) => setUrl(e.target.value)} /><button className="btn primary" disabled={busy || !url} onClick={() => run(() => api(`/api/content/${id}/resolve-unknown`, { body: { outcome: "published", url } }), "Отмечено как опубликованное", after)}>Пост вышел</button></div>
                <div className="row"><input type="text" placeholder="Что проверили" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn" disabled={busy || !comment} onClick={() => run(() => api(`/api/content/${id}/resolve-unknown`, { body: { outcome: "not_published", comment } }), "Отмечено: пост не вышел", after)}>Пост не вышел</button></div>
              </div>}
              {d.publication && <div className={`panel ev ${d.publication.evidence_type}`}><h3>Опубликовано</h3><p className={`evlabel ${d.publication.evidence_type}`}>{EV_RU[d.publication.evidence_type]}</p>{d.publication.url && <a href={d.publication.url} target="_blank" rel="noreferrer">Открыть пост</a>}{d.publication.external_id && <div className="small muted">{d.publication.external_id}</div>}</div>}
              {job && <div className="panel small"><h3>Задание публикации</h3><dl className="kv"><dt>Режим</dt><dd><span className={`mode ${job.mode}`}>{MODE_RU[job.mode]}</span></dd><dt>Статус</dt><dd>{job.status}</dd><dt>Попыток</dt><dd className="num">{job.attempts}</dd><dt>Время</dt><dd className="num">{fmt(job.run_at, acc?.account.timezone)}</dd>{job.last_error && <><dt>Причина</dt><dd>{job.last_error}</dd></>}</dl></div>}
              <div className="panel small"><h3>История согласований</h3>{d.approvals.length === 0 ? <p className="muted">Ещё не отправлялся на согласование.</p> : <ul style={{ margin: 0, paddingLeft: 18 }}>{d.approvals.map((a: any) => <li key={a.id}>{a.stage === "editorial" ? "Редактор" : "Клиент"}: {a.status === "invalidated" ? "аннулировано новой версией" : a.status === "approved" ? "согласовано" : a.status === "pending" ? "ожидает" : "нужны правки"}{a.decisions?.[0]?.comment ? `, «${a.decisions[0].comment}»` : ""}</li>)}</ul>}</div>
            </div>
          </div>
          <h2>Версии</h2>
          <div className="list">{d.versions.map((v: any) => <details key={v.id} className="item"><summary>Версия {v.version}, {v.origin === "ai_draft" ? "AI" : "человек"}, {fmt(v.created_at)}</summary><div className="post" style={{ marginTop: 8 }}>{v.body}</div></details>)}</div>
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

