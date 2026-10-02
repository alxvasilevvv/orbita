import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useAction, useToast, Loadable, go, fmt, State, STATE_RU, EV_RU, MODE_RU, KIND_RU, type LoadState } from "../lib";

/* ---------- обзор агентства ---------- */
export function Overview() {
  const s = useApi<any>("/api/overview");
  const attention = useApi<any[]>("/api/accounts?attention=1");
  return (
    <>
      <h1>Обзор агентства</h1>
      <p className="lede">Производственные показатели команды. Результаты клиентов смотрите в аналитике каждого аккаунта: это разные вещи.</p>
      <Loadable s={s}>{(d) => {
        const p = d.production;
        const v = [["accounts", "аккаунтов в работе"], ["publications_today", "публикаций сегодня"], ["overdue_tasks", "просроченных задач", true], ["stale_approvals", "согласований дольше 48 ч", true], ["publish_errors", "ошибок публикации", true], ["connection_problems", "проблем с подключением", true], ["open_incidents", "открытых инцидентов", true]] as const;
        return (
          <>
            <div className="vitals">{v.map(([k, l, bad]) => <div key={k} className={`vital ${bad && p[k] > 0 ? "alert" : ""}`}><b className="num">{p[k]}</b><span>{l}</span></div>)}</div>
            <h2>Требуют внимания</h2>
            <Loadable s={attention}>{(rows) => rows.length ? <AccountTable rows={rows} /> : <div className="empty">Все аккаунты в порядке: нет ошибок, зависших согласований и просрочек.</div>}</Loadable>
            {d.team_load.length > 0 && <>
              <h2>Загрузка команды на неделю</h2>
              <table><thead><tr><th>Сотрудник</th><th>Назначено</th><th style={{ width: "40%" }}>Ёмкость</th><th>Просрочено</th></tr></thead><tbody>
                {d.team_load.map((u: any) => { const cap = Number(u.weekly_capacity_hours) * 60; const pct = cap ? Math.min(100, (u.assigned_minutes / cap) * 100) : 0; return (
                  <tr key={u.id}><td>{u.display_name}</td><td className="num">{(u.assigned_minutes / 60).toFixed(1).replace(".", ",")} ч из {u.weekly_capacity_hours}</td><td><div className={`bar ${u.ok ? "" : "over"}`} aria-label={`${pct.toFixed(0)}%`}><i style={{ width: `${pct}%` }} /></div>{!u.ok && <span className="small" style={{ color: "var(--ev-fail)" }}>Перегрузка на {(u.overBy / 60).toFixed(1)} ч</span>}</td><td className="num">{u.overdue}</td></tr>); })}
              </tbody></table>
            </>}
            {d.finance && <>
              <h2>Часы и себестоимость за 30 дней</h2>
              <table><thead><tr><th>Клиент</th><th>Часы</th><th>Труд</th><th>AI</th><th>Доход по договору</th><th>Маржа</th></tr></thead><tbody>
                {d.finance.map((f: any) => { const cost = Number(f.labor_cost_30d) + Number(f.ai_cost_30d); const fee = f.monthly_fee == null ? null : Number(f.monthly_fee); return (
                  <tr key={f.id}><td>{f.name}</td><td className="num">{(f.minutes_30d / 60).toFixed(1)}</td><td className="num">${Number(f.labor_cost_30d).toFixed(0)}</td><td className="num">${Number(f.ai_cost_30d).toFixed(2)}</td><td className="num">{fee == null ? "не указан" : `$${fee.toFixed(0)}`}</td><td className="num">{fee ? `${(((fee - cost) / fee) * 100).toFixed(0)}%` : "не рассчитывается"}</td></tr>); })}
              </tbody></table>
              <p className="muted small">{d.finance_note}</p>
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
      <thead><tr><th>Клиент и аккаунт</th><th>Тип</th><th>Цель</th><th>Менеджер</th><th>Подключение</th><th>Следующая публикация</th><th>Выполнение плана</th><th>Причина внимания</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id} className="click" tabIndex={0} onClick={() => go(`/accounts/${r.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/accounts/${r.id}`)}>
          <td><b>{r.display_name}</b><div className="muted small">{r.client_name}</div></td>
          <td>{KIND_RU[r.kind]}</td>
          <td>{r.goal ?? <span className="muted">нет стратегии</span>}</td>
          <td>{r.manager_name ?? "—"}</td>
          <td>{r.connection_status === "none" ? <span className="muted">не подключён</span> : r.connection_status}</td>
          <td className="num">{fmt(r.next_publication, r.timezone)}</td>
          <td className="num">{r.plan_progress}</td>
          <td><ul className="reasons">{r.attention_reasons.length ? r.attention_reasons.map((x: string) => <li key={x}>{x}</li>) : <li className="ok">Нет</li>}</ul></td>
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
      <h1>Аккаунты</h1>
      <p className="lede">Все управляемые профили и страницы, к которым у вас есть доступ.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <input type="search" placeholder="Поиск по клиенту или аккаунту" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Поиск" />
        <label className="row small"><input type="checkbox" checked={onlyAttention} onChange={(e) => setOnly(e.target.checked)} /> Только требующие внимания</label>
      </div>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">Ничего не найдено. Измените запрос или снимите фильтр.</div> : (
        <>
          <table>
            <thead><tr><th><span className="muted">Выбрать</span></th><th>Аккаунт</th><th>Тип</th><th>Подключение</th><th>Согласования</th><th>Следующая публикация</th><th>Причина внимания</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" aria-label={`Выбрать ${r.display_name}`} checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /></td>
                <td><a href={`#/accounts/${r.id}`}><b>{r.display_name}</b></a><div className="muted small">{r.client_name}</div></td>
                <td>{KIND_RU[r.kind]}</td>
                <td>{r.connection_status === "none" ? <span className="muted">не подключён</span> : r.connection_status}</td>
                <td className="num">{r.pending_approvals}</td>
                <td className="num">{fmt(r.next_publication, r.timezone)}</td>
                <td><ul className="reasons">{r.attention_reasons.length ? r.attention_reasons.map((x: string) => <li key={x}>{x}</li>) : <li className="ok">Нет</li>}</ul></td>
              </tr>))}</tbody>
          </table>
          <div className="panel" style={{ marginTop: 14 }}>
            <h3>Массовое назначение внутренней задачи</h3>
            <p className="muted small">Выбрано аккаунтов: {sel.length}. Сначала посмотрите состав, затем создайте задачи.</p>
            <div className="row">
              <input type="text" placeholder="Название задачи" value={title} onChange={(e) => setTitle(e.target.value)} />
              <button className="btn" disabled={!sel.length || !title || busy} onClick={() => run(async () => setResult((await api("/api/bulk/tasks", { body: { account_ids: sel, title, dry_run: true } })).results), "Состав проверен")}>Проверить состав</button>
              <button className="btn primary" disabled={!sel.length || !title || busy} onClick={() => run(async () => setResult((await api("/api/bulk/tasks", { body: { account_ids: sel, title } })).results), "Задачи созданы")}>Создать задачи</button>
            </div>
            {result && <ul className="small">{result.map((r) => <li key={r.account_id}>{rows.find((x) => x.id === r.account_id)?.display_name ?? r.account_id}: {r.status === "created" ? "создана" : r.status === "would_create" ? "будет создана" : `ошибка: ${r.error}`}</li>)}</ul>}
          </div>
        </>
      )}</Loadable>
    </>
  );
}


/* ---------- центр согласований ---------- */
export function Approvals({ onChange }: { onChange: () => void }) {
  const s = useApi<any[]>("/api/approvals");
  return (
    <>
      <h1>Согласования</h1>
      <p className="lede">Каждый материал согласуется в конкретной версии и для конкретного аккаунта. Изменение текста после согласования отправляет материал на повторный круг.</p>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">Нет материалов, ожидающих согласования.</div> : (
        <div className="list">{rows.map((r) => (
          <div key={r.approval_request_id} className="item">
            <div className="spread"><a href={`#/content/${r.content_item_id}`}><b>{r.title}</b></a><span className="state editorial_review">{r.stage === "editorial" ? "у редактора" : "у клиента"}</span></div>
            <div className="small muted">{r.client_name}, аккаунт «{r.account_name}», версия {r.version}, ждёт с {fmt(r.created_at)}</div>
            <div className="post" style={{ marginTop: 8, maxHeight: 120, overflow: "hidden" }}>{r.body}</div>
          </div>))}</div>)}</Loadable>
    </>
  );
}

/* ---------- задачи ---------- */
export function TaskList({ rows, reload }: { rows: any[]; reload: () => void }) {
  const { busy, run } = useAction();
  if (!rows.length) return <div className="empty">Открытых задач нет.</div>;
  return (
    <table><thead><tr><th>Задача</th><th>Исполнитель</th><th>Срок</th><th>Приоритет</th><th /></tr></thead><tbody>
      {rows.map((t) => (
        <tr key={t.id}>
          <td><b>{t.title}</b>{t.account_name && <div className="muted small">{t.client_name}, {t.account_name}</div>}{t.details && <details className="small"><summary>Подробности</summary><div className="post">{t.details}</div></details>}</td>
          <td>{t.assignee_name ?? <span className="muted">не назначен</span>}</td>
          <td className="num" style={{ color: t.due_at && new Date(t.due_at) < new Date() && !["done", "cancelled"].includes(t.status) ? "var(--ev-fail)" : undefined }}>{fmt(t.due_at)}</td>
          <td className="small">{t.priority_score != null ? Number(t.priority_score ?? t.priority).toFixed(2) : t.priority ?? "—"}<div className="muted">{t.priority_reason}</div></td>
          <td>{["done", "cancelled"].includes(t.status) ? <span className="muted">{t.status === "done" ? "выполнена" : "отменена"}</span> : ["assisted_publish", "resolve_unknown"].includes(t.type) ? <span className="small muted">Закрывается отметкой в материале</span> : <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/tasks/${t.id}`, { method: "PATCH", body: { status: "done" } }), "Задача выполнена", reload)}>Отметить выполненной</button>}</td>
        </tr>))}
    </tbody></table>
  );
}
export function Tasks() {
  const [mine, setMine] = useState(false);
  const s = useApi<any[]>(`/api/tasks${mine ? "?mine=1" : ""}`);
  return (
    <>
      <h1>Задачи</h1>
      <p className="lede">Отсортированы по приоритету: срочность 0,40, влияние 0,35, блокировка других 0,25. Веса настраиваются; конфликт прав или конфиденциальности блокирует задачу, а не снижает балл.</p>
      <label className="row small" style={{ marginBottom: 12 }}><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Только мои</label>
      <Loadable s={s}>{(rows) => <TaskList rows={rows} reload={s.reload} />}</Loadable>
    </>
  );
}

/* ---------- журнал, отчёт, интеграции ---------- */
export function Audit() {
  const s = useApi<any[]>("/api/audit");
  return (
    <>
      <h1>Журнал аудита</h1>
      <p className="lede">Чувствительные операции агентства. Журнал хранит метаданные действий, а не тексты клиентов.</p>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <div className="empty">Событий нет.</div> : (
        <table><thead><tr><th>Время</th><th>Кто</th><th>Действие</th><th>Объект</th><th>Детали</th></tr></thead><tbody>
          {rows.map((e) => <tr key={e.id}><td className="num small">{fmt(e.created_at)}</td><td>{e.actor_name ?? "система"}</td><td>{e.action}</td><td className="small">{e.entity_type}</td><td className="small muted">{JSON.stringify(e.details)}</td></tr>)}
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
        <h1>Еженедельный отчёт</h1>
        <p className="lede">{b.account}, {b.period.period_start} – {b.period.period_end}</p>
        <h2>Опубликованные материалы</h2>
        {b.published.length ? <div className="list">{b.published.map((p: any, i: number) => <div key={i} className={`item ev ${p.evidence_type}`}><b>{p.title}</b> <span className={`evlabel ${p.evidence_type}`}>{EV_RU[p.evidence_type]}</span>{p.url && <div className="small"><a href={p.url}>{p.url}</a></div>}</div>)}</div> : <p className="muted">За период публикаций нет.</p>}
        <h2>Выполненные работы</h2>
        {b.work_done.length ? <ul>{b.work_done.map((t: any, i: number) => <li key={i}>{t.title}</li>)}</ul> : <p className="muted">Закрытых задач нет.</p>}
        <h2>Доступные результаты</h2>
        {b.metrics.length ? <ul>{b.metrics.map((m: any) => <li key={m.content_item_id}>Показы {m.impressions ?? "нет данных"}, interaction rate {m.interaction_rate}</li>)}</ul> : <p className="muted">Показателей за период нет.</p>}
        {b.opportunities.length > 0 && <><h2>Подтверждённые возможности</h2><ul>{b.opportunities.map((o: any, i: number) => <li key={i}>{o.title} ({o.stage}, атрибуция: {o.attribution})</li>)}</ul></>}
        <h2>Ограничения данных</h2>
        <ul>{b.data_limitations.map((x: string) => <li key={x}>{x}</li>)}</ul>
        <h2>Следующий план</h2>
        {b.next_plan.length ? <ul>{b.next_plan.map((n: any, i: number) => <li key={i}>{n.title}, {fmt(n.scheduled_at, n.scheduled_tz)}</li>)}</ul> : <p className="muted">Запланированных публикаций нет.</p>}
        <h2>Что требуется от клиента</h2>
        {b.client_action_required.length ? <ul>{b.client_action_required.map((x: string) => <li key={x}>{x}</li>)}</ul> : <p className="muted">Ничего.</p>}
      </>); }}</Loadable>
  );
}

export function Integrations() {
  const s = useApi<any>("/api/meta");
  return (
    <>
      <h1>Интеграции</h1>
      <p className="lede">Что LinkedIn предлагает в принципе и что реально одобрено нашему приложению. Операция работает через API только если продукт одобрен, аккаунт подключён и владелец выдал нужное разрешение.</p>
      <Loadable s={s}>{(m) => (
        <>
          <div className="notice info" style={{ marginBottom: 14 }}>Одобренные продукты приложения: {m.approved_products.length ? m.approved_products.join(", ") : "нет. Все операции идут через людей и ручной импорт."}</div>
          <table><thead><tr><th>Операция</th><th>Продукт LinkedIn</th><th>Разрешение</th><th>Нужно одобрение LinkedIn</th><th>Альтернатива</th></tr></thead><tbody>
            {m.capability_catalog.map((c: any) => <tr key={c.operation}><td>{c.label}</td><td className="small">{c.product ?? "нет публичного API"}</td><td className="small">{c.permission ?? "—"}</td><td>{c.needsLinkedInApproval ? "да" : "нет"}</td><td className="small">{c.fallbackText}</td></tr>)}
          </tbody></table>
          <h2>Бюджет запросов в сутки</h2>
          <p className="muted small">4 синхронизации в сутки × 3 запроса с пагинацией, 0,4 публикации на аккаунт по 2 запроса, 1 взаимодействие на аккаунт, резерв 30%. Фактические квоты смотрите в Developer Portal.</p>
          <table><thead><tr><th>Аккаунтов</th><th>Синхронизация</th><th>Публикации</th><th>Взаимодействия</th><th>Итого с резервом</th></tr></thead><tbody>
            {m.request_budget.map((b: any) => <tr key={b.accounts}><td className="num">{b.accounts}</td><td className="num">{b.sync}</td><td className="num">{b.pub}</td><td className="num">{b.interactions}</td><td className="num"><b>{b.total}</b></td></tr>)}
          </tbody></table>
        </>)}</Loadable>
    </>
  );
}

