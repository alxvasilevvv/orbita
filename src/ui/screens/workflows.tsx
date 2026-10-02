import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t } from "../lib";

const AUD_RU: Record<string, string> = { account_manager: "аккаунт-менеджеру", editor: "редактору", client_approvers: "согласующим клиента", author: "автору", ops_director: "операционному директору", strategist: "стратегу", owner: "владельцу", unassigned: "без исполнителя" };

function describeAction(a: any) {
  if (a.type === "notify") return `${t("Уведомить")} ${t(AUD_RU[a.audience] ?? a.audience)}`;
  if (a.type === "create_task") return `${t("Задача")} ${t(AUD_RU[a.assignee] ?? a.assignee)}: «${a.title}», ${t("срок")} ${a.due_in_hours} ${t("ч")}`;
  if (a.type === "pause_publishing") return t("Приостановить публикацию аккаунта");
  return a.type;
}

export function WorkflowsPage() {
  const s = useApi<any>("/api/workflows");
  const accounts = useApi<any[]>("/api/accounts?limit=500");
  const { busy, run } = useAction();
  const [preview, setPreview] = useState<Record<string, any[]>>({});
  const [runs, setRuns] = useState<Record<string, any[]>>({});
  const [acc, setAcc] = useState("");
  const [f, setF] = useState({ key: "", name: "", trigger: "plan.week_behind", condKind: "", notify: "account_manager", taskTitle: "", taskHours: 24 });
  return (
    <>
      <h1>{t("Сценарии")}</h1>
      <p className="lede">{t("Событие → условия → внутренние действия. Сценарии создают задачи и уведомления, но не публикуют и не выполняют внешних действий: это остаётся за согласованием. Каждый запуск записывается, повтор события не дублирует действия, глубина цепочки ограничена.")}</p>
      <Loadable s={s}>{(d) => (
        <div className="grid cols-2-1">
          <div className="list">{d.workflows.map((w: any) => (
            <div key={w.id} className="item">
              <div className="spread"><b>{w.name}</b><span className="small muted">v{w.version}{w.is_builtin ? ` · ${t("встроенный")}` : ""}</span></div>
              <div className="small"><b>{t("Событие")}:</b> {t(d.triggers[w.trigger] ?? w.trigger)}{w.conditions?.length ? <> · <b>{t("Условия")}:</b> {w.conditions.map((c: any) => `${c.field} ${c.op} ${JSON.stringify(c.value)}`).join(", ")}</> : null}</div>
              <ul className="small" style={{ margin: "4px 0" }}>{w.actions.map((a: any, i: number) => <li key={i}>{describeAction(a)}</li>)}</ul>
              <div className="small muted">{t("Запусков")}: {w.runs} · {t("последний")}: {fmt(w.last_run)} · {t("лимит в сутки")}: {w.max_runs_per_day} · {t("владелец")}: {w.owner_name ?? t("система")}</div>
              <div className="row" style={{ marginTop: 6 }}>
                <label className="row small"><input type="checkbox" checked={w.enabled} disabled={busy} onChange={(e) => run(() => api(`/api/workflows/${w.id}/enabled`, { body: { enabled: e.target.checked } }), e.target.checked ? "Сценарий включён" : "Сценарий выключен", s.reload)} /> {t("Включён")}</label>
                <button className="btn small" disabled={busy} onClick={() => run(async () => { setPreview({ ...preview, [w.id]: await api(`/api/workflows/${w.id}/preview`, { body: acc ? { account_id: acc } : {} }) }); }, "Предпросмотр готов")}>{t("Предпросмотр")}</button>
                <button className="btn small" disabled={busy} onClick={() => run(async () => { setRuns({ ...runs, [w.id]: await api(`/api/workflows/${w.id}/runs`) }); }, "Журнал загружен")}>{t("Журнал запусков")}</button>
              </div>
              {preview[w.id] && <div className="notice info small" style={{ marginTop: 6 }}>{preview[w.id].length === 0 ? t("Сценарий не сработал бы на тестовом событии.") : preview[w.id].map((p: any, i: number) => <div key={i}>{t("Выполнилось бы")}: {p.actions.map((a: any) => a.type === "conditions_not_met" ? t("условия не выполнены") : describeAction(a)).join("; ")}</div>)}</div>}
              {runs[w.id] && <table className="small" style={{ marginTop: 6 }}><thead><tr><th>{t("Когда")}</th><th>{t("Статус")}</th><th>{t("Действия")}</th></tr></thead><tbody>{runs[w.id].length === 0 ? <tr><td colSpan={3} className="muted">{t("Запусков ещё не было")}</td></tr> : runs[w.id].map((r: any) => <tr key={r.id}><td className="num">{fmt(r.created_at)}</td><td>{r.status}</td><td>{(r.actions_taken ?? []).map((a: any) => a.type).join(", ")}{r.error ? ` (${r.error})` : ""}</td></tr>)}</tbody></table>}
            </div>))}</div>
          <div className="grid" style={{ alignContent: "start" }}>
            <div className="panel">
              <h3>{t("Тестовое событие для предпросмотра")}</h3>
              <select value={acc} onChange={(e) => setAcc(e.target.value)} style={{ width: "100%" }}><option value="">{t("Без аккаунта")}</option>{accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.client_name}: {a.display_name}</option>)}</select>
            </div>
            <div className="panel grid">
              <h3>{t("Новый сценарий или новая версия")}</h3>
              <label className="field">{t("Ключ (латиница, повторный ключ создаёт новую версию)")}<input type="text" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="founders-behind" /></label>
              <label className="field">{t("Название")}<input type="text" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
              <label className="field">{t("Событие")}<select value={f.trigger} onChange={(e) => setF({ ...f, trigger: e.target.value })}>{Object.entries(d.triggers).map(([k, v]: any) => <option key={k} value={k}>{t(v)}</option>)}</select></label>
              <label className="field">{t("Условие: тип аккаунта")}<select value={f.condKind} onChange={(e) => setF({ ...f, condKind: e.target.value })}><option value="">{t("Любой")}</option>{["executive", "founder", "expert", "employee", "job_seeker", "company_page"].map((k) => <option key={k} value={k}>{k}</option>)}</select></label>
              <label className="field">{t("Уведомить")}<select value={f.notify} onChange={(e) => setF({ ...f, notify: e.target.value })}><option value="">{t("Никого")}</option>{Object.entries(AUD_RU).filter(([k]) => k !== "unassigned").map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select></label>
              <label className="field">{t("Создать задачу (название, необязательно)")}<input type="text" value={f.taskTitle} onChange={(e) => setF({ ...f, taskTitle: e.target.value })} /></label>
              {f.taskTitle && <label className="field">{t("Срок, часов")}<input type="text" inputMode="numeric" value={f.taskHours} onChange={(e) => setF({ ...f, taskHours: Number(e.target.value) || 24 })} /></label>}
              <button className="btn primary" disabled={busy || !f.key || !f.name || (!f.notify && !f.taskTitle)} onClick={() => run(() => api("/api/workflows", { body: {
                key: f.key, name: f.name, trigger: f.trigger,
                conditions: f.condKind ? [{ field: "account.kind", op: "eq", value: f.condKind }] : [],
                actions: [...(f.notify ? [{ type: "notify", audience: f.notify }] : []), ...(f.taskTitle ? [{ type: "create_task", title: f.taskTitle, due_in_hours: f.taskHours }] : [])],
              } }), "Сценарий сохранён", s.reload)}>{t("Сохранить сценарий")}</button>
            </div>
          </div>
        </div>)}</Loadable>
    </>
  );
}
