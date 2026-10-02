import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, money, num, useMe } from "../lib";
import { tx } from "../i18n";
import { intlLocale } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

export function AgencyReportPage() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const s = useApi<any>(`/api/agency-report?month=${month}`);
  const q = useApi<any[]>("/api/ai/quality");
  return (
    <>
      <h1>{t("Экономика агентства")}</h1>
      <p className="lede">{t("Часы, себестоимость, доход по договору и маржа по клиентам. Это производственные показатели агентства, не результаты клиентов.")}</p>
      <label className="row small" style={{ marginBottom: 12 }}>{t("Месяц")} <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
      <Loadable s={s}>{(d) => (
        <>
          <div className="vitals">
            <div className="vital"><b className="num">{money(d.totals.revenue)}</b><span>{t("доход по договорам")}</span></div>
            <div className="vital"><b className="num">{money(d.totals.cost)}</b><span>{t("себестоимость")}</span></div>
            <div className="vital"><b className="num">{d.totals.revenue && d.totals.margin_computable ? `${num(((d.totals.revenue - d.totals.cost) / d.totals.revenue) * 100, 0)}%` : t("нет данных")}</b><span>{t("маржа")}</span></div>
            <div className="vital"><b className="num">{num(d.totals.hours, 1)}</b><span>{t("часов")}</span></div>
          </div>
          <h2>{t("По клиентам")}</h2>
          <table>
            <thead><tr><th>{t("Клиент")}</th><th>{t("Аккаунтов")}</th><th>{t("Часы")}</th><th>{t("Труд")}</th><th>AI</th><th>{t("Инфраструктура")}</th><th>{t("Доход")}</th><th>{t("Маржа")}</th><th>{t("Просрочки")}</th><th>{t("Доработки")}</th><th>{t("Причины перерасхода")}</th></tr></thead>
            <tbody>{d.clients.map((c: any) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td><td className="num">{c.accounts}</td><td className="num">{num(c.hours, 1)}</td><td className="num">{money(c.labor_cost)}</td><td className="num">{money(c.ai_cost)}</td>
                <td className="num">{c.overhead == null ? t("не задано") : money(c.overhead)}</td><td className="num">{money(c.revenue)}</td>
                <td className={`num ${c.margin != null && c.margin < 0.2 ? "bad" : ""}`}>{c.margin == null ? t("не рассчитывается") : `${num(c.margin * 100, 0)}%`}</td>
                <td className="num">{c.overdue}</td><td className="num">{c.revisions}</td>
                <td><ul className="reasons">{c.overrun_reasons.length ? c.overrun_reasons.map((r: string) => <li key={r}>{tx(r)}</li>) : <li className="ok">{t("Нет")}</li>}</ul></td>
              </tr>))}</tbody>
          </table>
          <p className="small muted">{tx(d.formula)}. {d.notes.map(tx).join(" ")}</p>
          <h2>{t("Загрузка команды за месяц")}</h2>
          <table><thead><tr><th>{t("Сотрудник")}</th><th>{t("Учтено часов")}</th><th>{t("Загрузка")}</th></tr></thead>
            <tbody>{d.team.map((u: any) => <tr key={u.display_name}><td>{u.display_name}</td><td className="num">{num(u.minutes / 60, 1)}</td><td className="num">{u.utilization == null ? "–" : `${num(u.utilization * 100, 0)}%`}</td></tr>)}</tbody></table>
        </>)}</Loadable>
      <h2>{t("Качество AI")}</h2>
      <p className="small muted">{t("Решение редактора фиксируется при согласовании: принято как есть, отредактировано, переписано или отклонено. Стоимость считается только при заданной цене провайдера.")}</p>
      <Loadable s={q}>{(rows) => rows.length === 0 ? <div className="empty">{t("AI ещё не использовался.")}</div> : (
        <table><thead><tr><th>{t("Роль")}</th><th>{t("Провайдер, модель")}</th><th>{t("Версия промпта")}</th><th>{t("Запусков")}</th><th>{t("Решено")}</th><th>{t("Как есть")}</th><th>{t("Отредактировано")}</th><th>{t("Переписано или отклонено")}</th><th>{t("Средняя доля правок")}</th><th>{t("Стоимость")}</th><th>{t("Задержка")}</th></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i}><td>{r.role}</td><td className="small">{r.provider} / {r.model}</td><td className="small">{r.prompt_version}</td><td className="num">{r.runs}</td><td className="num">{r.decided}</td><td className="num">{r.accepted_as_is}</td><td className="num">{r.edited}</td><td className="num">{r.rejected_or_rewritten}</td><td className="num">{r.avg_edit_ratio == null ? "–" : `${num(r.avg_edit_ratio * 100, 0)}%`}</td><td className="num">{r.priced_runs ? money(r.cost_usd) : t("цена не задана")}</td><td className="num">{r.avg_latency_ms == null ? "–" : `${r.avg_latency_ms} ${t("мс")}`}</td></tr>)}</tbody></table>)}</Loadable>
    </>
  );
}

const KIND_RU: Record<string, string> = { content: "Материалы и публикации", actions: "Журнал действий", metrics: "Показатели", tasks: "Задачи", time: "Учёт времени" };
const STATUS_RU: Record<string, string> = { queued: "в очереди", running: "собирается", ready: "готов", failed: "ошибка", expired: "истёк" };

export function ExportsPage() {
  const s = useApi<any[]>("/api/exports");
  const accounts = useApi<any[]>("/api/accounts?limit=500");
  const me = useMe();
  const { busy, run } = useAction();
  const [f, setF] = useState({ kind: "content", account_id: "" });
  return (
    <>
      <h1>{t("Экспорты")}</h1>
      <p className="lede">{t("Файлы собираются в фоне и хранятся 7 дней. Данные LinkedIn API не выгружаются, пока это не разрешено условиями источника. Ссылка на скачивание временная.")}</p>
      <div className="panel row" style={{ marginBottom: 14 }}>
        <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{Object.entries(KIND_RU).filter(([k]) => k !== "time" || me?.agency_ops.includes("view_finance")).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select>
        <select value={f.account_id} onChange={(e) => setF({ ...f, account_id: e.target.value })}>
          {me?.agency_ops.includes("view_finance") && <option value="">{t("Всё агентство")}</option>}
          {!me?.agency_ops.includes("view_finance") && <option value="">{t("Выберите аккаунт")}</option>}
          {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.client_name}: {a.display_name}</option>)}
        </select>
        <button className="btn primary" disabled={busy || (!f.account_id && !me?.agency_ops.includes("view_finance"))} onClick={() => run(() => api("/api/exports", { body: { kind: f.kind, ...(f.account_id ? { account_id: f.account_id } : {}) } }), "Экспорт поставлен в очередь", s.reload)}>{t("Запросить экспорт")}</button>
        <button className="btn" onClick={s.reload}>{t("Обновить")}</button>
      </div>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Экспортов ещё нет.")}</div> : (
        <table><thead><tr><th>{t("Что")}</th><th>{t("Статус")}</th><th>{t("Строк")}</th><th>{t("Запрошен")}</th><th>{t("Доступен до")}</th><th /></tr></thead>
          <tbody>{rows.map((e) => <tr key={e.id}><td>{t(KIND_RU[e.kind])}</td><td>{t(STATUS_RU[e.status])}{e.error ? `: ${e.error}` : ""}</td><td className="num">{e.row_count ?? "–"}</td><td className="num">{fmt(e.created_at)}</td><td className="num">{fmt(e.expires_at)}</td>
            <td>{e.status === "ready" && <button className="btn small" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/exports/${e.id}/download`); location.href = r.url; }, "Скачивание начато")}>{t("Скачать CSV")}</button>}</td></tr>)}</tbody></table>)}</Loadable>
    </>
  );
}
void intlLocale;
