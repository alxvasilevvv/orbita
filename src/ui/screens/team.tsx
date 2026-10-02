import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, ROLE_RU, useMe, money } from "../lib";

export function TeamPage() {
  const s = useApi<any>("/api/team");
  const clients = useApi<any[]>("/api/clients");
  const accounts = useApi<any[]>("/api/accounts?limit=500");
  const me = useMe();
  const finance = me?.agency_ops.includes("view_finance");
  const { busy, run } = useAction();
  const [grant, setGrant] = useState({ user_id: "", role: "author", scope: "" });
  const [inv, setInv] = useState({ email: "", display_name: "" });
  const [edit, setEdit] = useState<Record<string, { cap?: string; rate?: string }>>({});
  return (
    <>
      <h1>{t("Команда")}</h1>
      <p className="lede">{t("Роли выдаются на агентство, клиента или аккаунт. Вход через корпоративный IdP с MFA: пароли в платформе не хранятся. При увольнении доступ отзывается сразу, задачи снимаются с исполнителя.")}</p>
      <Loadable s={s}>{(d) => (
        <div className="grid cols-2-1">
          <table>
            <thead><tr><th>{t("Сотрудник")}</th><th>{t("Роли и область")}</th><th>{t("Часов в неделю")}</th>{finance && <th>{t("Ставка, $/ч")}</th>}<th /></tr></thead>
            <tbody>{d.users.map((u: any) => (
              <tr key={u.id} className={u.is_active ? "" : "muted"}>
                <td><b>{u.display_name}</b><div className="small muted">{u.email}{u.mfa_enrolled ? "" : ` · ${t("MFA не подключена")}`}</div></td>
                <td>{u.memberships.length === 0 ? <span className="muted small">{t("нет ролей")}</span> : u.memberships.map((m: any) => (
                  <span key={m.id} className="chip">{t(ROLE_RU[m.role])}{m.client_name ? `: ${m.client_name}` : m.account_name ? `: ${m.account_name}` : ` · ${t("агентство")}`}
                    <button className="chip-x" aria-label={t("Отозвать роль")} disabled={busy} onClick={() => run(() => api(`/api/team/roles/${m.id}/revoke`, { body: {} }), "Роль отозвана", s.reload)}>×</button></span>))}</td>
                <td><input type="text" inputMode="decimal" className="w-s" defaultValue={u.weekly_capacity_hours} onChange={(e) => setEdit({ ...edit, [u.id]: { ...edit[u.id], cap: e.target.value } })} /></td>
                {finance && <td><input type="text" inputMode="decimal" className="w-s" defaultValue={u.internal_hourly_rate ?? ""} placeholder={t("нет")} onChange={(e) => setEdit({ ...edit, [u.id]: { ...edit[u.id], rate: e.target.value } })} /></td>}
                <td className="row">
                  {edit[u.id] && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/api/team/${u.id}`, { method: "PATCH", body: { ...(edit[u.id].cap ? { weekly_capacity_hours: Number(edit[u.id].cap) } : {}), ...(edit[u.id].rate !== undefined ? { internal_hourly_rate: edit[u.id].rate === "" ? null : Number(edit[u.id].rate) } : {}) } }), "Сохранено", () => { setEdit({ ...edit, [u.id]: undefined as any }); s.reload(); })}>{t("Сохранить")}</button>}
                  {u.is_active && u.id !== me?.id && <button className="btn small danger" disabled={busy} onClick={() => run(() => api(`/api/users/${u.id}/offboard`, { body: {} }), "Доступ отозван", s.reload)}>{t("Отозвать доступ")}</button>}
                </td>
              </tr>))}</tbody>
          </table>
          <div className="grid" style={{ alignContent: "start" }}>
            <div className="panel grid">
              <h3>{t("Выдать роль")}</h3>
              <select value={grant.user_id} onChange={(e) => setGrant({ ...grant, user_id: e.target.value })}><option value="">{t("Сотрудник")}</option>{d.users.filter((u: any) => u.is_active).map((u: any) => <option key={u.id} value={u.id}>{u.display_name}</option>)}</select>
              <select value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>{d.roles.map((r: string) => <option key={r} value={r}>{t(ROLE_RU[r])}</option>)}</select>
              <select value={grant.scope} onChange={(e) => setGrant({ ...grant, scope: e.target.value })}>
                <option value="">{t("Всё агентство")}</option>
                <optgroup label={t("Клиент")}>{clients.data?.map((c) => <option key={c.id} value={`c:${c.id}`}>{c.name}</option>)}</optgroup>
                <optgroup label={t("Аккаунт")}>{accounts.data?.map((a) => <option key={a.id} value={`a:${a.id}`}>{a.client_name}: {a.display_name}</option>)}</optgroup>
              </select>
              <button className="btn primary" disabled={busy || !grant.user_id} onClick={() => run(() => api("/api/team/roles", { body: { user_id: grant.user_id, role: grant.role, scope_client_id: grant.scope.startsWith("c:") ? grant.scope.slice(2) : null, scope_account_id: grant.scope.startsWith("a:") ? grant.scope.slice(2) : null } }), "Роль выдана", s.reload)}>{t("Выдать роль")}</button>
            </div>
            <div className="panel grid">
              <h3>{t("Пригласить сотрудника или представителя клиента")}</h3>
              <input type="text" placeholder={t("Имя")} value={inv.display_name} onChange={(e) => setInv({ ...inv, display_name: e.target.value })} />
              <input type="text" placeholder="email@company.com" value={inv.email} onChange={(e) => setInv({ ...inv, email: e.target.value })} />
              <button className="btn primary" disabled={busy || !inv.email || !inv.display_name} onClick={() => run(() => api("/api/team/invite", { body: inv }), "Приглашение создано", () => { setInv({ email: "", display_name: "" }); s.reload(); })}>{t("Пригласить")}</button>
              <p className="small muted">{t("После приглашения выдайте роль. Вход появится, когда IdP подтвердит email.")}</p>
            </div>
            {finance && <ClientSettings clients={clients.data ?? []} reload={clients.reload} />}
          </div>
        </div>)}</Loadable>
    </>
  );
}

function ClientSettings({ clients, reload }: { clients: any[]; reload: () => void }) {
  const { busy, run } = useAction();
  const [v, setV] = useState<Record<string, any>>({});
  return (
    <div className="panel grid">
      <h3>{t("Условия клиентов")}</h3>
      <table className="small"><thead><tr><th>{t("Клиент")}</th><th>{t("SLA согласования, ч")}</th><th>{t("AI-бюджет, $/мес")}</th><th>{t("Договор, $/мес")}</th><th /></tr></thead><tbody>
        {clients.map((c) => (
          <tr key={c.id}>
            <td>{c.name}{c.status !== "active" ? <div className="muted">{c.status}</div> : null}</td>
            <td><input className="w-s" defaultValue={c.approval_sla_hours} onChange={(e) => setV({ ...v, [c.id]: { ...v[c.id], approval_sla_hours: Number(e.target.value) } })} /></td>
            <td><input className="w-s" defaultValue={c.ai_budget_usd_month ?? ""} placeholder={t("без лимита")} onChange={(e) => setV({ ...v, [c.id]: { ...v[c.id], ai_budget_usd_month: e.target.value === "" ? null : Number(e.target.value) } })} /></td>
            <td><input className="w-s" defaultValue={c.monthly_fee ?? ""} onChange={(e) => setV({ ...v, [c.id]: { ...v[c.id], monthly_fee: e.target.value === "" ? null : Number(e.target.value) } })} /></td>
            <td>{v[c.id] && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/api/clients/${c.id}`, { method: "PATCH", body: v[c.id] }), "Сохранено", reload)}>{t("Сохранить")}</button>}</td>
          </tr>))}
      </tbody></table>
      <p className="small muted">{t("Текущий договор")}: {money(clients.reduce((s, c) => s + Number(c.monthly_fee ?? 0), 0))} {t("в месяц")}</p>
    </div>
  );
}

export function IncidentsPage() {
  const s = useApi<any[]>("/api/incidents");
  const { busy, run } = useAction();
  const [f, setF] = useState({ severity: "medium", kind: "", summary: "" });
  const [res, setRes] = useState<Record<string, string>>({});
  return (
    <>
      <h1>{t("Инциденты")}</h1>
      <p className="lede">{t("Сбои публикации, исчерпанные повторы, проблемы доступа. Автоматические инциденты создаёт исполнитель публикаций; остальные вносит команда.")}</p>
      <div className="grid cols-2-1">
        <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Инцидентов нет.")}</div> : (
          <div className="list">{rows.map((i) => (
            <div key={i.id} className={`item sev-${i.severity}`}>
              <div className="spread"><b>{i.summary}</b><span className={`state ${i.status === "open" ? "failed" : "published"}`}>{i.status === "open" ? t("открыт") : t("решён")}</span></div>
              <div className="small muted">{i.severity} · {i.kind} · {fmt(i.created_at)}{i.client_name ? ` · ${i.client_name}` : ""}{i.account_name ? `, ${i.account_name}` : ""}{i.owner_name ? ` · ${t("ответственный")}: ${i.owner_name}` : ""}</div>
              {i.resolution && <div className="small">{t("Решение")}: {i.resolution}</div>}
              {i.status === "open" && <div className="row" style={{ marginTop: 6 }}>
                <input type="text" placeholder={t("Что сделали")} value={res[i.id] ?? ""} onChange={(e) => setRes({ ...res, [i.id]: e.target.value })} />
                <button className="btn" disabled={busy || !(res[i.id] ?? "").trim()} onClick={() => run(() => api(`/api/incidents/${i.id}/resolve`, { body: { resolution: res[i.id] } }), "Инцидент закрыт", s.reload)}>{t("Закрыть инцидент")}</button>
              </div>}
            </div>))}</div>)}</Loadable>
        <div className="panel grid" style={{ alignContent: "start" }}>
          <h3>{t("Зарегистрировать инцидент")}</h3>
          <select value={f.severity} onChange={(e) => setF({ ...f, severity: e.target.value })}>{["low", "medium", "high", "critical"].map((x) => <option key={x}>{x}</option>)}</select>
          <input type="text" placeholder={t("Тип, например «доступ»")} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} />
          <textarea style={{ minHeight: 70 }} placeholder={t("Что произошло")} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
          <button className="btn primary" disabled={busy || !f.kind || f.summary.length < 3} onClick={() => run(() => api("/api/incidents", { body: f }), "Инцидент зарегистрирован", () => { setF({ severity: "medium", kind: "", summary: "" }); s.reload(); })}>{t("Зарегистрировать")}</button>
          <p className="small muted">{t("Порядок действий описан в docs/runbook.md.")}</p>
        </div>
      </div>
    </>
  );
}
