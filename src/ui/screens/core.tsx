import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useAction, useToast, Loadable, go, fmt, State, STATE_RU, EV_RU, MODE_RU, KIND_RU, type LoadState, t, useMe } from "../lib";
import { tx } from "../i18n";

/* ---------- обзор агентства ---------- */
export function Overview() {
  const s = useApi<any>("/api/overview");
  const attention = useApi<any[]>("/api/accounts?attention=1");
  return (
    <>
      <h1>{t("Обзор агентства")}</h1>
      <p className="lede">{t("Производственные показатели команды. Результаты клиентов смотрите в аналитике каждого аккаунта: это разные вещи.")}</p>
      <Loadable s={s}>{(d) => {
        const p = d.production;
        const v = [["accounts", "аккаунтов в работе"], ["publications_today", "публикаций сегодня"], ["overdue_tasks", "просроченных задач", true], ["stale_approvals", "согласований дольше 48 ч", true], ["publish_errors", "ошибок публикации", true], ["connection_problems", "проблем с подключением", true], ["open_incidents", "открытых инцидентов", true]] as const;
        return (
          <>
            <div className="vitals">{v.map(([k, l, bad]) => <div key={k} className={`vital ${bad && p[k] > 0 ? "alert" : ""}`}><b className="num">{p[k]}</b><span>{t(l)}</span></div>)}</div>
            <h2>{t("Требуют внимания")}</h2>
            <Loadable s={attention}>{(rows) => rows.length ? <AccountTable rows={rows} /> : <div className="empty">{t("Все аккаунты в порядке: нет ошибок, зависших согласований и просрочек.")}</div>}</Loadable>
            {d.team_load.length > 0 && <>
              <h2>{t("Загрузка команды на неделю")}</h2>
              <table><thead><tr><th>{t("Сотрудник")}</th><th>{t("Назначено")}</th><th style={{ width: "40%" }}>{t("Ёмкость")}</th><th>{t("Просрочено")}</th></tr></thead><tbody>
                {d.team_load.map((u: any) => { const cap = Number(u.weekly_capacity_hours) * 60; const pct = cap ? Math.min(100, (u.assigned_minutes / cap) * 100) : 0; return (
                  <tr key={u.id}><td>{u.display_name}</td><td className="num">{(u.assigned_minutes / 60).toFixed(1).replace(".", ",")} {t("ч из")} {u.weekly_capacity_hours}</td><td><div className={`bar ${u.ok ? "" : "over"}`} aria-label={`${pct.toFixed(0)}%`}><i style={{ width: `${pct}%` }} /></div>{!u.ok && <span className="small" style={{ color: "var(--ev-fail)" }}>{t("Перегрузка на")} {(u.overBy / 60).toFixed(1)} {t("ч")}</span>}</td><td className="num">{u.overdue}</td></tr>); })}
              </tbody></table>
            </>}
            {d.finance && <>
              <h2>{t("Часы и себестоимость за 30 дней")}</h2>
              <table><thead><tr><th>{t("Клиент")}</th><th>{t("Часы")}</th><th>{t("Труд")}</th><th>AI</th><th>{t("Доход по договору")}</th><th>{t("Маржа")}</th></tr></thead><tbody>
                {d.finance.map((f: any) => { const cost = Number(f.labor_cost_30d) + Number(f.ai_cost_30d); const fee = f.monthly_fee == null ? null : Number(f.monthly_fee); return (
                  <tr key={f.id}><td>{f.name}</td><td className="num">{(f.minutes_30d / 60).toFixed(1)}</td><td className="num">${Number(f.labor_cost_30d).toFixed(0)}</td><td className="num">${Number(f.ai_cost_30d).toFixed(2)}</td><td className="num">{fee == null ? t("не указан") : `$${fee.toFixed(0)}`}</td><td className="num">{fee && f.minutes_30d > 0 ? `${(((fee - cost) / fee) * 100).toFixed(0)}%` : <span className="muted" title={t("Время за 30 дней не учтено: маржа не рассчитывается")}>{t("не рассчитывается")}</span>}</td></tr>); })}
              </tbody></table>
              <p className="muted small">{tx(d.finance_note)}</p>
            </>}
          </>
        );
      }}</Loadable>
    </>
  );
}

/* ---------- реестр ---------- */
export function AccountTable({ rows }: { rows: any[] }) {
  return (
    <table>
      <thead><tr><th>{t("Клиент и аккаунт")}</th><th>{t("Тип")}</th><th>{t("Цель")}</th><th>{t("Менеджер")}</th><th>{t("Подключение")}</th><th>{t("Следующая публикация")}</th><th>{t("Выполнение плана")}</th><th>{t("Причина внимания")}</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id} className="click" tabIndex={0} onClick={() => go(`/accounts/${r.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/accounts/${r.id}`)}>
          <td><b>{r.display_name}</b><div className="muted small">{r.client_name}</div></td>
          <td>{t(KIND_RU[r.kind])}</td>
          <td>{r.goal ?? <span className="muted">{t("нет стратегии")}</span>}</td>
          <td>{r.manager_name ?? "–"}</td>
          <td>{r.connection_status === "none" ? <span className="muted">{t("не подключён")}</span> : r.connection_status}</td>
          <td className="num">{fmt(r.next_publication, r.timezone)}</td>
          <td className="num">{tx(r.plan_progress)}</td>
          <td><ul className="reasons">{r.attention_reasons.length ? r.attention_reasons.map((x: string) => <li key={x}>{tx(x)}</li>) : <li className="ok">{t("Нет")}</li>}</ul></td>
        </tr>))}
      </tbody>
    </table>
  );
}

export function Accounts() {
  const [q, setQ] = useState("");
  const [onlyAttention, setOnly] = useState(false);
  const s = useApi<any[]>(`/api/accounts?q=${encodeURIComponent(q)}${onlyAttention ? "&attention=1" : ""}`);
  const [sel, setSel] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [result, setResult] = useState<any[] | null>(null);
  const { busy, run } = useAction();
  return (
    <>
      <h1>{t("Аккаунты")}</h1>
      <p className="lede">{t("Все управляемые профили и страницы, к которым у вас есть доступ.")}</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder={t("Поиск по клиенту или аккаунту")} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("Поиск")} />
        <label className="row small"><input type="checkbox" checked={onlyAttention} onChange={(e) => setOnly(e.target.checked)} /> {t("Только требующие внимания")}</label>
      </div>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Ничего не найдено. Измените запрос или снимите фильтр.")}</div> : (
        <>
          <table>
            <thead><tr><th><span className="muted">{t("Выбрать")}</span></th><th>{t("Аккаунт")}</th><th>{t("Тип")}</th><th>{t("Подключение")}</th><th>{t("Согласования")}</th><th>{t("Следующая публикация")}</th><th>{t("Причина внимания")}</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" aria-label={`${t("Выбрать")} ${r.display_name}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
                <td><a href={`#/accounts/${r.id}`}><b>{r.display_name}</b></a><div className="muted small">{r.client_name}</div></td>
                <td>{t(KIND_RU[r.kind])}</td>
                <td>{r.connection_status === "none" ? <span className="muted">{t("не подключён")}</span> : r.connection_status}</td>
                <td className="num">{r.pending_approvals}</td>
                <td className="num">{fmt(r.next_publication, r.timezone)}</td>
                <td><ul className="reasons">{r.attention_reasons.length ? r.attention_reasons.map((x: string) => <li key={x}>{tx(x)}</li>) : <li className="ok">{t("Нет")}</li>}</ul></td>
              </tr>))}</tbody>
          </table>
          <div className="panel" style={{ marginTop: 14 }}>
            <h3>{t("Массовое назначение внутренней задачи")}</h3>
            <p className="muted small">{t("Выбрано аккаунтов:")} {sel.length}{t(". Сначала посмотрите состав, затем создайте задачи.")}</p>
            <div className="row">
              <input type="text" placeholder={t("Название задачи")} value={title} onChange={(e) => setTitle(e.target.value)} />
              <button className="btn" disabled={!sel.length || !title || busy} onClick={() => run(async () => setResult((await api("/api/bulk/tasks", { body: { account_ids: sel, title, dry_run: true } })).results), "Состав проверен")}>{t("Проверить состав")}</button>
              <button className="btn primary" disabled={!sel.length || !title || busy} onClick={() => run(async () => setResult((await api("/api/bulk/tasks", { body: { account_ids: sel, title } })).results), "Задачи созданы")}>{t("Создать задачи")}</button>
            </div>
            {result && <ul className="small">{result.map((r) => <li key={r.account_id}>{rows.find((x) => x.id === r.account_id)?.display_name ?? r.account_id}: {r.status === "created" ? t("создана") : r.status === "would_create" ? t("будет создана") : `${t("ошибка")}: ${r.error}`}</li>)}</ul>}
          </div>
        </>
      )}</Loadable>
    </>
  );
}


/* ---------- центр согласований ---------- */
export function Approvals({ onChange }: { onChange: () => void }) {
  const s = useApi<any[]>("/api/approvals");
  const me = useMe();
  const { busy, run } = useAction();
  const [sel, setSel] = useState<string[]>([]);
  const [result, setResult] = useState<any[] | null>(null);
  const canBatch = me?.agency_ops.includes("editorial_approve");
  return (
    <>
      <h1>{t("Согласования")}</h1>
      <p className="lede">{t("Каждый материал согласуется в конкретной версии и для конкретного аккаунта. Изменение текста после согласования отправляет материал на повторный круг.")}</p>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Нет материалов, ожидающих согласования.")}</div> : (
        <>
          {canBatch && rows.some((r) => r.stage === "editorial") && <div className="panel row" style={{ marginBottom: 12 }}>
            <span className="small">{t("Пакетное редакторское согласование")}: {t("выбрано")} {sel.length}. {t("Каждый материал проходит все обычные проверки отдельно.")}</span>
            <button className="btn primary" disabled={busy || !sel.length} onClick={() => run(async () => {
              const items = rows.filter((r) => sel.includes(r.approval_request_id)).map((r) => ({ content_item_id: r.content_item_id, approval_request_id: r.approval_request_id }));
              const r = await api("/api/approvals/batch", { body: { decision: "approved", items } });
              setResult(r.results.map((x: any) => ({ ...x, row: rows.find((y) => y.content_item_id === x.content_item_id) })));
              setSel([]);
            }, "Пакетное согласование выполнено", () => { s.reload(); onChange(); })}>{t("Согласовать выбранные версии")}</button>
          </div>}
          {result && <div className="notice info small" style={{ marginBottom: 12 }}><ul style={{ margin: 0 }}>{result.map((x) => <li key={x.content_item_id}>{x.row?.account_name}: {x.row?.title}, v{x.row?.version}: {x.status === "error" ? `${t("ошибка")}: ${x.error}` : t("согласовано редактором")}</li>)}</ul></div>}
          <div className="list">{rows.map((r) => (
            <div key={r.approval_request_id} className={`item ${r.sla_overdue ? "overdue" : ""}`}>
              <div className="spread">
                <span className="row">
                  {canBatch && r.stage === "editorial" && <input type="checkbox" aria-label={r.title} checked={sel.includes(r.approval_request_id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.approval_request_id] : sel.filter((x) => x !== r.approval_request_id))} />}
                  <a href={`#/content/${r.content_item_id}`}><b>{r.title}</b></a>
                </span>
                <span className="row">{r.sla_overdue && <span className="state failed">{t("SLA нарушен")}</span>}<span className="state editorial_review">{r.stage === "editorial" ? t("у редактора") : t("у клиента")}</span></span>
              </div>
              <div className="small muted">{r.client_name}, {t("аккаунт")} «{r.account_name}», {t("версия")} {r.version}{r.media_ids?.length ? `, ${t("вложений")} ${r.media_ids.length}` : ""}, {t("ждёт с")} {fmt(r.created_at)} · SLA {r.sla_hours} {t("ч")}{r.due_at ? ` · ${t("план")} ${fmt(r.due_at)}` : ""}</div>
              <div className="post" style={{ marginTop: 8, maxHeight: 120, overflow: "hidden" }}>{r.body}</div>
            </div>))}</div>
        </>)}</Loadable>
    </>
  );
}

/* ---------- задачи ---------- */
export function TaskList({ rows, reload }: { rows: any[]; reload: () => void }) {
  const { busy, run } = useAction();
  if (!rows.length) return <div className="empty">{t("Открытых задач нет.")}</div>;
  return (
    <table><thead><tr><th>{t("Задача")}</th><th>{t("Исполнитель")}</th><th>{t("Срок")}</th><th>{t("Приоритет")}</th><th /></tr></thead><tbody>
      {rows.map((tk) => (
        <tr key={tk.id}>
          <td><b>{tk.title}</b>{tk.account_name && <div className="muted small">{tk.client_name}, {tk.account_name}</div>}{tk.details && <details className="small"><summary>{t("Подробности")}</summary><div className="post">{tk.details}</div></details>}</td>
          <td>{tk.assignee_name ?? <span className="muted">{t("не назначен")}</span>}</td>
          <td className="num" style={{ color: tk.due_at && new Date(tk.due_at) < new Date() && !["done", "cancelled"].includes(tk.status) ? "var(--ev-fail)" : undefined }}>{fmt(tk.due_at)}</td>
          <td className="small">{tk.priority_score != null ? Number(tk.priority_score ?? tk.priority).toFixed(2) : tk.priority ?? "–"}<div className="muted">{tk.priority_reason}</div></td>
          <td>{["done", "cancelled"].includes(tk.status) ? <span className="muted">{tk.status === "done" ? t("выполнена") : t("отменена")}</span> : ["assisted_publish", "resolve_unknown"].includes(tk.type) ? <span className="small muted">{t("Закрывается отметкой в материале")}</span> : <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/tasks/${tk.id}`, { method: "PATCH", body: { status: "done" } }), "Задача выполнена", reload)}>{t("Отметить выполненной")}</button>}</td>
        </tr>))}
    </tbody></table>
  );
}
export function Tasks() {
  const [mine, setMine] = useState(false);
  const s = useApi<any[]>(`/api/tasks${mine ? "?mine=1" : ""}`);
  return (
    <>
      <h1>{t("Задачи")}</h1>
      <p className="lede">{t("Отсортированы по приоритету: срочность 0,40, влияние 0,35, блокировка других 0,25. Веса настраиваются; конфликт прав или конфиденциальности блокирует задачу, а не снижает балл.")}</p>
      <label className="row small" style={{ marginBottom: 12 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t("Только мои")}</label>
      <Loadable s={s}>{(rows) => <TaskList rows={rows} reload={s.reload} />}</Loadable>
    </>
  );
}

/* ---------- журнал, отчёт, интеграции ---------- */
export function Audit() {
  const s = useApi<any[]>("/api/audit");
  return (
    <>
      <h1>{t("Журнал аудита")}</h1>
      <p className="lede">{t("Чувствительные операции агентства. Журнал хранит метаданные действий, а не тексты клиентов.")}</p>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">{t("Событий нет.")}</div> : (
        <table><thead><tr><th>{t("Время")}</th><th>{t("Кто")}</th><th>{t("Действие")}</th><th>{t("Объект")}</th><th>{t("Детали")}</th></tr></thead><tbody>
          {rows.map((e) => <tr key={e.id}><td className="num small">{fmt(e.created_at)}</td><td>{e.actor_name ?? t("система")}</td><td>{e.action}</td><td className="small">{e.entity_type}</td><td className="small muted">{JSON.stringify(e.details)}</td></tr>)}
        </tbody></table>)}</Loadable>
    </>
  );
}

export function ReportPage({ id }: { id: string }) {
  const s = useApi<any>(`/api/reports/${id}`);
  return (
    <Loadable s={s}>{(r) => { const b = r.body; return (
      <>
        <a href={`#/accounts/${r.account_id}`} className="small">{b.account}</a>
        <h1>{t("Еженедельный отчёт")}</h1>
        <p className="lede">{b.account}, {b.period.period_start} – {b.period.period_end}</p>
        <h2>{t("Опубликованные материалы")}</h2>
        {b.published.length ? <div className="list">{b.published.map((p: any, i: number) => <div key={i} className={`item ev ${p.evidence_type}`}><b>{p.title}</b> <span className={`evlabel ${p.evidence_type}`}>{t(EV_RU[p.evidence_type])}</span>{p.url && <div className="small"><a href={p.url}>{p.url}</a></div>}</div>)}</div> : <p className="muted">{t("За период публикаций нет.")}</p>}
        <h2>{t("Выполненные работы")}</h2>
        {b.work_done.length ? <ul>{b.work_done.map((t: any, i: number) => <li key={i}>{t.title}</li>)}</ul> : <p className="muted">{t("Закрытых задач нет.")}</p>}
        <h2>{t("Доступные результаты")}</h2>
        {b.metrics.length ? <ul>{b.metrics.map((m: any) => <li key={m.content_item_id}>{t("Показы")} {m.impressions ?? t("нет данных")}, interaction rate {m.interaction_rate}</li>)}</ul> : <p className="muted">{t("Показателей за период нет.")}</p>}
        {b.opportunities.length > 0 && <><h2>{t("Подтверждённые возможности")}</h2><ul>{b.opportunities.map((o: any, i: number) => <li key={i}>{o.title} ({o.stage}{t(", атрибуция:")} {o.attribution})</li>)}</ul></>}
        <h2>{t("Ограничения данных")}</h2>
        <ul>{b.data_limitations.map((x: string) => <li key={x}>{tx(x)}</li>)}</ul>
        <h2>{t("Следующий план")}</h2>
        {b.next_plan.length ? <ul>{b.next_plan.map((n: any, i: number) => <li key={i}>{n.title}, {fmt(n.scheduled_at, n.scheduled_tz)}</li>)}</ul> : <p className="muted">{t("Запланированных публикаций нет.")}</p>}
        <h2>{t("Что требуется от клиента")}</h2>
        {b.client_action_required.length ? <ul>{b.client_action_required.map((x: string) => <li key={x}>{tx(x)}</li>)}</ul> : <p className="muted">{t("Ничего.")}</p>}
      </>); }}</Loadable>
  );
}

export function Integrations() {
  const s = useApi<any>("/api/meta");
  return (
    <>
      <h1>{t("Интеграции")}</h1>
      <p className="lede">{t("Что LinkedIn предлагает в принципе и что реально одобрено нашему приложению. Операция работает через API только если продукт одобрен, аккаунт подключён и владелец выдал нужное разрешение.")}</p>
      <Loadable s={s}>{(m) => (
        <>
          <div className="notice info" style={{ marginBottom: 14 }}>{t("Одобренные продукты приложения:")} {m.approved_products.length ? m.approved_products.join(", ") : t("нет. Все операции идут через людей и ручной импорт.")}</div>
          <table><thead><tr><th>{t("Операция")}</th><th>{t("Продукт LinkedIn")}</th><th>{t("Разрешение")}</th><th>{t("Нужно одобрение LinkedIn")}</th><th>{t("Альтернатива")}</th></tr></thead><tbody>
            {m.capability_catalog.map((c: any) => <tr key={c.operation}><td>{t(c.label)}</td><td className="small">{c.product ?? t("нет публичного API")}</td><td className="small">{c.permission ?? "–"}</td><td>{c.needsLinkedInApproval ? t("да") : t("нет")}</td><td className="small">{t(c.fallbackText)}</td></tr>)}
          </tbody></table>
          <h2>{t("Бюджет запросов в сутки")}</h2>
          <p className="muted small">{t("4 синхронизации в сутки × 3 запроса с пагинацией, 0,4 публикации на аккаунт по 2 запроса, 1 взаимодействие на аккаунт, резерв 30%. Фактические квоты смотрите в Developer Portal.")}</p>
          <table><thead><tr><th>{t("Аккаунтов")}</th><th>{t("Синхронизация")}</th><th>{t("Публикации")}</th><th>{t("Взаимодействия")}</th><th>{t("Итого с резервом")}</th></tr></thead><tbody>
            {m.request_budget.map((b: any) => <tr key={b.accounts}><td className="num">{b.accounts}</td><td className="num">{b.sync}</td><td className="num">{b.pub}</td><td className="num">{b.interactions}</td><td className="num"><b>{b.total}</b></td></tr>)}
          </tbody></table>
        </>)}</Loadable>
    </>
  );
}

