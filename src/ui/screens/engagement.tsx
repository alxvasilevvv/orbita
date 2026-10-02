import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, num } from "../lib";

const ACTION_RU: Record<string, string> = { comment: "Комментарий", react: "Реакция", reply: "Ответ" };
const STATUS_RU: Record<string, string> = { proposed: "предложено", blocked: "заблокировано", approved: "согласовано", rejected: "отклонено", executed: "выполнено", expired: "истекло" };

export function EngagementQueue({ accountId, reloadKey = 0 }: { accountId?: string; reloadKey?: number }) {
  const [status, setStatus] = useState("");
  const s = useApi<any[]>(`/api/engagement?${accountId ? `account_id=${accountId}&` : ""}${status ? `status=${status}` : ""}`, [reloadKey]);
  const { busy, run } = useAction();
  const [urls, setUrls] = useState<Record<string, string>>({});
  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="small">{t("Показать")}{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">{t("Активные")}</option>
            {Object.entries(STATUS_RU).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
          </select>
        </label>
      </div>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Очередь пуста. Добавьте материал, где клиент может содержательно высказаться.")}</div> : (
        <div className="list">{rows.map((r) => (
          <div key={r.id} className={`item ${r.status === "blocked" ? "blocked" : ""}`}>
            <div className="spread">
              <div><b>{t(ACTION_RU[r.action_type])}</b> {!accountId && <span className="muted">· {r.account_name}</span>} <span className={`state ${r.status}`}>{t(STATUS_RU[r.status])}</span></div>
              <div className="small num" title={t("Эвристика агентства, не алгоритм LinkedIn")}>{r.priority != null ? `${t("Приоритет")} ${num(Number(r.priority), 2)}` : t("Без балла: есть блокировка")}</div>
            </div>
            <div className="small"><a href={r.target_url} target="_blank" rel="noreferrer">{r.target_author || r.target_url}</a>{r.target_excerpt ? <span className="muted">: {r.target_excerpt.slice(0, 180)}</span> : null}</div>
            <div className="small" style={{ marginTop: 4 }}><b>{t("Почему")}:</b> {r.rationale}</div>
            <div className="scores small muted">
              {[["relevance", "релевантность"], ["audience_fit", "аудитория"], ["contribution_value", "вклад"], ["timeliness", "актуальность"]].map(([k, l]) => <span key={k}>{t(l)} {num(Number(r[k]), 2)}</span>)}
            </div>
            {r.proposed_comment && <div className="post" style={{ marginTop: 6 }}>{r.proposed_comment}</div>}
            {r.block_reasons?.length > 0 && <ul className="reasons" style={{ marginTop: 6 }}>{r.block_reasons.map((b: string) => <li key={b}>{b}</li>)}</ul>}
            <div className="row small" style={{ marginTop: 8 }}>
              <span className="muted">{t("Согласует")}: {r.required_approver === "client" ? t("клиент лично") : t("аккаунт-менеджер")} · {t("Исполнение")}: {r.execution_mode === "api" ? "API" : t("человек в LinkedIn")} · {t("Сегодня выполнено")} {r.executed_today}/{r.daily_cap}</span>
            </div>
            {r.status === "proposed" && <div className="row" style={{ marginTop: 8 }}>
              <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/engagement/${r.id}/decision`, { body: { decision: "approved", comment_text: r.proposed_comment ?? undefined } }), "Действие согласовано", s.reload)}>{t("Согласовать этот текст")}</button>
              <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/engagement/${r.id}/decision`, { body: { decision: "rejected" } }), "Рекомендация отклонена", s.reload)}>{t("Отклонить")}</button>
            </div>}
            {r.status === "approved" && <div className="row" style={{ marginTop: 8 }}>
              <span className="small">{t("Выполните действие в LinkedIn и отметьте результат. Запись будет ручной отметкой.")}</span>
              <input type="url" placeholder={t("Ссылка на комментарий (необязательно)")} value={urls[r.id] ?? ""} onChange={(e) => setUrls({ ...urls, [r.id]: e.target.value })} />
              <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/engagement/${r.id}/executed`, { body: urls[r.id] ? { result_url: urls[r.id] } : {} }), "Выполнение отмечено", s.reload)}>{t("Отметить выполнение")}</button>
            </div>}
            {r.status === "executed" && <div className="small muted" style={{ marginTop: 6 }}>{t("Выполнено")} {fmt(r.executed_at)} · {t("Ручная отметка")}</div>}
          </div>))}</div>)}</Loadable>
    </div>
  );
}

export function EngagementForm({ accountId, onCreated }: { accountId?: string; onCreated: () => void }) {
  const accounts = useApi<any[]>(accountId ? null : "/api/accounts?limit=500");
  const { busy, run } = useAction();
  const [f, setF] = useState({ account: accountId ?? "", target_url: "", target_author: "", target_excerpt: "", action_type: "comment", relevance: 0.7, audience_fit: 0.7, contribution_value: 0.6, timeliness: 0.6, rationale: "", proposed_comment: "", source: "manager_added" });
  const [aiNote, setAiNote] = useState<string | null>(null);
  const acc = accountId ?? f.account;
  return (
    <div className="panel grid">
      <h3>{t("Новая рекомендация")}</h3>
      <p className="small muted">{t("Реакции и комментарии выполняются только после человеческого выбора и согласования конкретного текста. Массовые однотипные комментарии и взаимная поддержка между клиентами блокируются.")}</p>
      {!accountId && <label className="field">{t("Аккаунт")}<select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">{t("Выберите аккаунт")}</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.client_name}: {a.display_name}</option>)}</select></label>}
      <label className="field">{t("Ссылка на материал в LinkedIn")}<input type="url" value={f.target_url} onChange={(e) => setF({ ...f, target_url: e.target.value })} placeholder="https://www.linkedin.com/posts/…" /></label>
      <div className="grid cols-2">
        <label className="field">{t("Автор материала")}<input type="text" value={f.target_author} onChange={(e) => setF({ ...f, target_author: e.target.value })} /></label>
        <label className="field">{t("Тип действия")}<select value={f.action_type} onChange={(e) => setF({ ...f, action_type: e.target.value })}>{Object.entries(ACTION_RU).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select></label>
      </div>
      <label className="field">{t("Фрагмент материала")}<textarea style={{ minHeight: 70 }} value={f.target_excerpt} onChange={(e) => setF({ ...f, target_excerpt: e.target.value })} /></label>
      <div className="grid cols-2">
        {([["relevance", "Соответствие теме"], ["audience_fit", "Релевантность аудитории"], ["contribution_value", "Возможность содержательного вклада"], ["timeliness", "Актуальность"]] as const).map(([k, l]) => (
          <label key={k} className="field">{t(l)}: <b className="num">{num(f[k], 2)}</b><input type="range" min={0} max={1} step={0.05} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} /></label>))}
      </div>
      <label className="field">{t("Основание рекомендации")}<input type="text" value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} /></label>
      {f.action_type !== "react" && <>
        <label className="field">{t("Предлагаемый комментарий")}<textarea style={{ minHeight: 80 }} value={f.proposed_comment} onChange={(e) => setF({ ...f, proposed_comment: e.target.value })} /></label>
        <div className="row">
          <button className="btn" disabled={busy || !acc || !f.target_excerpt} onClick={() => run(async () => { const r = await api(`/api/accounts/${acc}/ai/comment`, { body: { excerpt: f.target_excerpt } }); setF((x) => ({ ...x, proposed_comment: r.proposed_comment })); setAiNote(r.risk_flags.length ? r.risk_flags.join("; ") : null); }, "Вариант от AI подставлен, проверьте его")}>{t("Предложить вариант с AI")}</button>
          {aiNote && <span className="small" style={{ color: "var(--ev-manual)" }}>{aiNote}</span>}
        </div>
      </>}
      <button className="btn primary" disabled={busy || !acc || !f.target_url || !f.rationale} onClick={() => run(() => api(`/api/accounts/${acc}/engagement`, { body: { ...f, account: undefined, proposed_comment: f.action_type === "react" ? undefined : f.proposed_comment || undefined, target_author: f.target_author || undefined, target_excerpt: f.target_excerpt || undefined } }), "Рекомендация добавлена в очередь", () => { setF({ ...f, target_url: "", target_author: "", target_excerpt: "", rationale: "", proposed_comment: "" }); onCreated(); })}>{t("Добавить в очередь")}</button>
    </div>
  );
}

export function EngagementPage() {
  const [k, setK] = useState(0);
  return (
    <>
      <h1>{t("Взаимодействия")}</h1>
      <p className="lede">{t("Очередь реакций, комментариев и ответов. Приоритет: настраиваемая эвристика агентства, а не алгоритм LinkedIn. Блокировка важнее любого балла.")}</p>
      <div className="grid cols-2-1">
        <EngagementQueue reloadKey={k} />
        <EngagementForm onCreated={() => setK(k + 1)} />
      </div>
    </>
  );
}
