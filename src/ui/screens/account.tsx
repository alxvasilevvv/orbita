import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, useApi, useAction, useToast, Loadable, go, fmt, State, STATE_RU, EV_RU, MODE_RU, KIND_RU, type LoadState } from "../lib";
import { TaskList } from "./core";

/* ---------- рабочее пространство аккаунта ---------- */
export const TABS = ["Обзор", "Стратегия", "База знаний", "Контент", "Задачи", "Аналитика", "Отчёты", "История действий", "Настройки и доступы"];
export function AccountPage({ id }: { id: string }) {
  const s = useApi<any>(`/api/accounts/${id}`);
  const [tab, setTab] = useState(TABS[0]);
  return (
    <Loadable s={s}>{(d) => (
      <>
        <a href="#/accounts" className="small">Все аккаунты</a>
        <h1>{d.account.display_name}</h1>
        <p className="lede">{d.account.client_name}, {KIND_RU[d.account.kind]}. Часовой пояс {d.account.timezone}, язык {d.account.primary_language}{d.account.confidential_job_search ? ". Конфиденциальный поиск работы" : ""}.</p>
        <div className="tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t}</button>)}</div>
        {tab === "Обзор" && <AccOverview d={d} />}
        {tab === "Стратегия" && <AccStrategy d={d} reload={s.reload} />}
        {tab === "База знаний" && <AccKnowledge d={d} reload={s.reload} />}
        {tab === "Контент" && <AccContent d={d} reload={s.reload} />}
        {tab === "Задачи" && <TaskList rows={d.tasks} reload={s.reload} />}
        {tab === "Аналитика" && <AccAnalytics d={d} reload={s.reload} />}
        {tab === "Отчёты" && <AccReports d={d} reload={s.reload} />}
        {tab === "История действий" && <AccHistory d={d} />}
        {tab === "Настройки и доступы" && <AccSettings d={d} reload={s.reload} />}
      </>
    )}</Loadable>
  );
}

export function AccOverview({ d }: { d: any }) {
  const st = d.strategies.find((s: any) => s.status === "approved");
  const pub = d.capabilities.find((c: any) => c.operation.startsWith("publish_post"));
  const next = d.content.filter((c: any) => c.state === "scheduled").sort((a: any, b: any) => +new Date(a.scheduled_at) - +new Date(b.scheduled_at))[0];
  const waiting = d.content.filter((c: any) => ["editorial_review", "client_review"].includes(c.state)).length;
  return (
    <div className="grid cols-2">
      <div className="panel">
        <h3>Стратегия</h3>
        {st ? <dl className="kv"><dt>Цель</dt><dd>{st.playbook.goal}</dd><dt>Аудитория</dt><dd>{st.playbook.audience}</dd><dt>Частота</dt><dd>{st.playbook.posts_per_week} в неделю (гипотеза)</dd><dt>Основной KPI</dt><dd>{st.playbook.primary_kpi}</dd><dt>Версия</dt><dd>v{st.version}</dd></dl> : <p className="muted">Стратегия не утверждена. Публикации можно готовить, но план и отчёты будут без цели.</p>}
      </div>
      <div className="panel">
        <h3>Публикация</h3>
        {pub && <p><span className={`mode ${pub.mode}`}>{MODE_RU[pub.mode]}</span> {pub.mode !== "api" && <span className="small">{pub.unavailable_reason}. {pub.alternative}.</span>}</p>}
        <dl className="kv"><dt>Следующая</dt><dd>{next ? `${next.title}, ${fmt(next.scheduled_at, d.account.timezone)}` : "не запланирована"}</dd><dt>Ждут согласования</dt><dd className="num">{waiting}</dd><dt>Открытых задач</dt><dd className="num">{d.tasks.filter((t: any) => !["done", "cancelled"].includes(t.status)).length}</dd></dl>
      </div>
    </div>
  );
}

export function AccStrategy({ d, reload }: { d: any; reload: () => void }) {
  const meta = useApi<any>("/api/meta");
  const { busy, run } = useAction();
  const can = (op: string) => d.permissions.includes(op);
  const [f, setF] = useState({ template: d.account.kind === "company_page" ? "company_page" : d.account.kind === "job_seeker" ? "job_seeker" : d.account.kind === "founder" ? "founder" : d.account.kind === "expert" ? "expert" : "executive", goal: "", audience: "", pillars: "", ppw: "2", kpi: "qualified_inquiries", forbidden: "", reason: "" });
  const tpl = meta.data?.strategy_templates?.[f.template];
  return (
    <div className="grid cols-2">
      <div className="list">
        {d.strategies.length === 0 && <div className="empty">Стратегии ещё нет. Создайте первую версию по шаблону справа.</div>}
        {d.strategies.map((s: any) => (
          <div key={s.id} className="item">
            <div className="spread"><h3>Версия {s.version}, шаблон «{s.template}»</h3><span className="state">{s.status === "approved" ? "утверждена" : s.status === "draft" ? "черновик" : "заменена"}</span></div>
            <dl className="kv small"><dt>Цель</dt><dd>{s.playbook.goal}</dd><dt>Направления</dt><dd>{s.playbook.pillars.join(", ")}</dd><dt>Частота</dt><dd>{s.playbook.posts_per_week} в неделю, стартовая гипотеза</dd><dt>Запрещённые темы</dt><dd>{s.restrictions.forbidden_topics?.join(", ") || "нет"}</dd><dt>Самосогласование</dt><dd>{s.restrictions.allow_self_approval ? "разрешено политикой" : "запрещено"}</dd>{s.change_reason && <><dt>Причина изменения</dt><dd>{s.change_reason}</dd></>}</dl>
            {s.status === "draft" && can("approve_strategy") && <button className="btn primary" disabled={busy} style={{ marginTop: 8 }} onClick={() => run(() => api(`/api/accounts/${d.account.id}/strategies/${s.id}/approve`, { body: {} }), "Стратегия утверждена", reload)}>Утвердить стратегию</button>}
          </div>))}
      </div>
      {can("edit_strategy") ? (
        <div className="panel">
          <h3>Новая версия стратегии</h3>
          <div className="grid">
            <label className="field">Шаблон<select value={f.template} onChange={(e) => setF({ ...f, template: e.target.value })}>{meta.data && Object.entries(meta.data.strategy_templates).map(([k, t]: any) => <option key={k} value={k}>{t.label}</option>)}</select></label>
            {tpl && <p className="small muted">Цель шаблона: {tpl.goal}. Направления: {tpl.pillars.join(", ")}. Стартовая частота {tpl.posts_per_week_hypothesis} в неделю согласуется с клиентом.{tpl.guardrails ? ` ${tpl.guardrails.join(" ")}` : ""}</p>}
            <label className="field">Основная цель<input type="text" value={f.goal} placeholder={tpl?.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} /></label>
            <label className="field">Целевая аудитория<input type="text" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })} /></label>
            <label className="field">Контентные направления через запятую<input type="text" value={f.pillars} placeholder={tpl?.pillars.join(", ")} onChange={(e) => setF({ ...f, pillars: e.target.value })} /></label>
            <label className="field">Публикаций в неделю<input type="text" inputMode="decimal" value={f.ppw} onChange={(e) => setF({ ...f, ppw: e.target.value })} /></label>
            <label className="field">Запрещённые темы через запятую<input type="text" value={f.forbidden} onChange={(e) => setF({ ...f, forbidden: e.target.value })} /></label>
            <label className="field">Причина изменения<input type="text" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/accounts/${d.account.id}/strategies`, { body: { template: f.template, change_reason: f.reason || undefined, playbook: { goal: f.goal || tpl.goal, audience: f.audience || "не указана", pillars: (f.pillars || tpl.pillars.join(",")).split(",").map((x: string) => x.trim()).filter(Boolean), posts_per_week: Number(f.ppw) || tpl.posts_per_week_hypothesis, primary_kpi: tpl.primary_kpi, secondary_kpis: tpl.secondary_kpis }, restrictions: { forbidden_topics: f.forbidden.split(",").map((x) => x.trim()).filter(Boolean) } } }), "Версия стратегии создана", reload)}>Создать версию</button>
          </div>
        </div>) : <div className="notice info">Редактировать стратегию могут стратег и аккаунт-менеджер.</div>}
    </div>
  );
}

export function AccKnowledge({ d, reload }: { d: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: "", body: "", claim: "", by: "" });
  return (
    <div className="grid cols-2">
      <div>
        <h3>Подтверждённые факты</h3>
        <p className="muted small">AI и авторы используют только эти факты. Каждый имеет подтверждающего и дату актуальности.</p>
        {d.claims.length === 0 ? <div className="empty">Подтверждённых фактов нет. Без них AI-черновик будет заблокирован вопросом клиенту.</div> :
          <div className="list">{d.claims.map((c: any) => <div key={c.id} className="item"><div>{c.statement}</div><div className="muted small">Подтвердил {c.confirmed_by}, актуально на {c.valid_as_of?.slice?.(0, 10) ?? String(c.valid_as_of)}</div></div>)}</div>}
        <h3 style={{ marginTop: 18 }}>Источники</h3>
        <ul>{d.knowledge.map((k: any) => <li key={k.id}>{k.title} <span className="muted small">({k.kind}, {k.usage_rights === "internal_only" ? "без AI" : "доступно AI"})</span></li>)}</ul>
      </div>
      {d.permissions.includes("edit_strategy") && <div className="panel grid">
        <h3>Добавить источник и факт</h3>
        <label className="field">Название<input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
        <label className="field">Содержание<textarea value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></label>
        <label className="field">Подтверждённый факт (необязательно)<input type="text" value={f.claim} onChange={(e) => setF({ ...f, claim: e.target.value })} /></label>
        <label className="field">Кто подтвердил<input type="text" value={f.by} onChange={(e) => setF({ ...f, by: e.target.value })} /></label>
        <button className="btn primary" disabled={busy || !f.title || !f.body || (!!f.claim && !f.by)} onClick={() => run(() => api(`/api/accounts/${d.account.id}/knowledge`, { body: { title: f.title, body: f.body, claims: f.claim ? [{ statement: f.claim, confirmed_by: f.by, valid_as_of: new Date().toISOString().slice(0, 10) }] : [] } }), "Источник добавлен", () => { setF({ title: "", body: "", claim: "", by: "" }); reload(); })}>Добавить источник</button>
      </div>}
    </div>
  );
}

export function AccContent({ d, reload }: { d: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState("");
  return (
    <>
      {d.permissions.includes("create_content") && <div className="row" style={{ marginBottom: 14 }}>
        <input type="text" placeholder="Тема нового материала" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 320 }} />
        <button className="btn primary" disabled={!title || busy} onClick={() => run(async () => { const it = await api(`/api/accounts/${d.account.id}/content`, { body: { title } }); go(`/content/${it.id}`); }, "Материал создан")}>Создать материал</button>
      </div>}
      {d.content.length === 0 ? <div className="empty">Материалов пока нет. Начните с темы из контентных направлений стратегии.</div> : (
        <table><thead><tr><th>Материал</th><th>Состояние</th><th>Время публикации</th><th>Подтверждение</th></tr></thead><tbody>
          {d.content.map((c: any) => (
            <tr key={c.id} className="click" tabIndex={0} onClick={() => go(`/content/${c.id}`)} onKeyDown={(e) => e.key === "Enter" && go(`/content/${c.id}`)}>
              <td><div className={`ev ${c.evidence_type ?? (c.state === "publication_unknown" ? "unknown" : c.state === "failed" ? "failed" : "")}`}><b>{c.title}</b><div className="muted small">v{c.version ?? 0}{c.pillar ? `, ${c.pillar}` : ""}</div></div></td>
              <td><State s={c.state} /></td>
              <td className="num">{fmt(c.scheduled_at, c.scheduled_tz ?? d.account.timezone)}</td>
              <td>{c.evidence_type ? <span className={`evlabel ${c.evidence_type}`}>{EV_RU[c.evidence_type]}</span> : <span className="muted">—</span>}</td>
            </tr>))}
        </tbody></table>)}
    </>
  );
}

export function AccAnalytics({ d, reload }: { d: any; reload: () => void }) {
  const pm = useApi<any[]>(`/api/accounts/${d.account.id}/post-metrics`);
  const pa = d.capabilities.find((c: any) => c.operation === "post_analytics");
  const { busy, run } = useAction();
  const [f, setF] = useState({ key: "followers", value: "", source: "" });
  return (
    <>
      {pa && pa.mode !== "api" && <div className="notice" style={{ marginBottom: 14 }}>Аналитика LinkedIn не подключена: {pa.unavailable_reason}. Вносите показатели вручную с указанием источника. Пустое значение означает «нет данных», а не ноль.</div>}
      <h3>Показатели публикаций</h3>
      <Loadable s={pm}>{(rows) => rows.length === 0 ? <div className="empty">Показателей публикаций нет. Внесите выгрузку или подключите разрешённый источник.</div> : (
        <table><thead><tr><th>Материал</th><th>Показы</th><th>Реакции</th><th>Комментарии</th><th>Репосты</th><th>Interaction rate*</th><th>Источник</th></tr></thead><tbody>
          {rows.map((r) => <tr key={r.content_item_id}><td>{d.content.find((c: any) => c.id === r.content_item_id)?.title ?? r.content_item_id}</td>{["impressions", "reactions", "comments", "reposts"].map((k) => <td key={k} className="num">{r[k] ?? <span className="muted">нет данных</span>}</td>)}<td className="num">{r.interaction_rate.status === "ok" ? `${r.interaction_rate.value.toFixed(2)}%` : <span className="muted small">не рассчитывается</span>}</td><td className="small">{r.sources.join(", ")}</td></tr>)}
        </tbody></table>)}</Loadable>
      <p className="muted small">* Определение платформы: (реакции + комментарии + репосты) / показы × 100%. Не является метрикой LinkedIn.</p>
      <h3 style={{ marginTop: 18 }}>Снимки аккаунта</h3>
      {d.metrics.filter((m: any) => !m.content_item_id).length === 0 ? <p className="muted">Снимков нет.</p> :
        <table><thead><tr><th>Метрика</th><th>Значение</th><th>Наблюдение</th><th>Источник</th></tr></thead><tbody>{d.metrics.filter((m: any) => !m.content_item_id).map((m: any) => <tr key={m.id}><td>{m.name}</td><td className="num">{m.value ?? <span className="muted">нет данных</span>}</td><td className="num">{fmt(m.observed_at)}</td><td className="small">{m.source}: {m.source_detail}</td></tr>)}</tbody></table>}
      {d.permissions.includes("enter_metrics") && <div className="panel row" style={{ marginTop: 14 }}>
        <select value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} aria-label="Метрика"><option value="followers">Подписчики</option><option value="profile_views">Просмотры профиля</option><option value="qualified_inquiries">Квалифицированные обращения</option></select>
        <input type="text" inputMode="numeric" placeholder="Значение, пусто = нет данных" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        <input type="text" placeholder="Источник, например «скриншот аналитики 30.09»" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} style={{ minWidth: 280 }} />
        <button className="btn primary" disabled={busy || !f.source} onClick={() => run(() => api(`/api/accounts/${d.account.id}/metrics`, { body: { source: "manual_entry", source_detail: f.source, rows: [{ metric_key: f.key, value: f.value === "" ? null : Number(f.value), observed_at: new Date().toISOString() }] } }), "Показатель сохранён", () => { reload(); pm.reload(); })}>Сохранить показатель</button>
      </div>}
    </>
  );
}

export function AccReports({ d, reload }: { d: any; reload: () => void }) {
  const { busy, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  return (
    <>
      {d.permissions.includes("export") && <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/accounts/${d.account.id}/reports/weekly`, { body: { period_start: weekAgo, period_end: today } }); go(`/reports/${r.id}`); }, "Отчёт сформирован", reload)}>Сформировать отчёт за неделю</button>}
      <div className="list" style={{ marginTop: 14 }}>{d.reports.length === 0 ? <div className="empty">Отчётов ещё нет.</div> : d.reports.map((r: any) => <a key={r.id} className="item" href={`#/reports/${r.id}`}>Еженедельный отчёт {String(r.period_start).slice(0, 10)} – {String(r.period_end).slice(0, 10)}</a>)}</div>
    </>
  );
}

export function AccHistory({ d }: { d: any }) {
  return (
    <>
      <div className="notice info" style={{ marginBottom: 14 }}>Это журнал действий, прошедших через платформу или отмеченных вручную. Он не является полной историей активности аккаунта в LinkedIn: внешние действия, сделанные мимо платформы, здесь не видны.</div>
      {d.actions.length === 0 ? <div className="empty">Действий пока нет.</div> : <div className="list">{d.actions.map((a: any) => (
        <div key={a.id} className={`item ev ${a.status === "unknown" ? "unknown" : a.status === "failed" ? "failed" : a.evidence_type}`}>
          <div className="spread"><b>{a.action_type === "publish_post" ? "Публикация поста" : a.action_type}</b><span className={`evlabel ${a.status === "unknown" ? "unknown" : a.evidence_type}`}>{a.status === "unknown" ? EV_RU.unknown : a.status === "failed" ? `Ошибка ${a.error_code ?? ""}` : EV_RU[a.evidence_type]}</span></div>
          <div className="small muted">{a.origin === "platform_api" ? "Через API платформы" : a.origin === "manual_mark" ? `Отметил ${a.actor_name ?? "пользователь"}` : a.origin}, {fmt(a.executed_at ?? a.requested_at)}{a.external_id ? `, ${a.external_id}` : ""}</div>
        </div>))}</div>}
    </>
  );
}

export function AccSettings({ d, reload }: { d: any; reload: () => void }) {
  const { busy, run } = useAction();
  const can = (op: string) => d.permissions.includes(op);
  const SCOPE_RU: Record<string, string> = { publish_post: "Публикация", comment: "Комментарии", react: "Реакции", analytics_read: "Чтение аналитики", profile_edit_tasks: "Задачи по профилю", ai_processing: "Обработка AI" };
  return (
    <div className="grid">
      <div className="panel">
        <div className="spread"><h3>Подключение LinkedIn</h3><div className="row">
          {can("manage_connection") && <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/accounts/${d.account.id}/oauth/start`); location.href = r.authorize_url; }, "Переход в LinkedIn")}>Подключить через LinkedIn</button>}
          <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/accounts/${d.account.id}/capabilities/refresh`, { body: {} }), "Возможности проверены", reload)}>Проверить возможности</button>
          {can("manage_connection") && d.connection && d.connection.status !== "revoked" && <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/accounts/${d.account.id}/connection/revoke`, { body: {} }), "Подключение отмечено отозванным", reload)}>Отметить отзыв доступа</button>}
        </div></div>
        <p className="small">{d.connection ? `Статус: ${d.connection.status}. Разрешения: ${d.connection.granted_scopes.join(" ") || "нет"}.` : "Аккаунт не подключён. Платформа работает через assisted-процессы: готовит материал, человек выполняет действие и вносит результат."}</p>
        <table><thead><tr><th>Операция</th><th>Режим</th><th>Почему</th><th>Альтернатива</th><th>Проверено</th></tr></thead><tbody>
          {d.capabilities.map((c: any) => <tr key={c.operation}><td>{c.label}</td><td><span className={`mode ${c.mode}`}>{MODE_RU[c.mode]}</span></td><td className="small">{c.unavailable_reason ?? c.access_basis}</td><td className="small">{c.mode === "api" ? "—" : c.alternative}</td><td className="small num">{fmt(c.checked_at)}<div className="muted">{c.source}</div></td></tr>)}
        </tbody></table>
      </div>
      <div className="panel">
        <h3>Согласия владельца</h3>
        <p className="muted small">Договор с компанией не даёт согласия за сотрудника. Отзыв согласия на публикацию отменяет все ещё не отправленные публикации.</p>
        <table><thead><tr><th>Вид действий</th><th>Кто дал</th><th>Основание</th><th>Статус</th><th /></tr></thead><tbody>
          {d.consents.map((c: any) => <tr key={c.id}><td>{SCOPE_RU[c.action_scope] ?? c.action_scope}</td><td>{c.granted_by_name}</td><td className="small">{c.evidence_ref}</td><td>{c.revoked_at ? `отозвано ${fmt(c.revoked_at)}` : "действует"}</td><td>{!c.revoked_at && can("manage_consent") && <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/accounts/${d.account.id}/consents/${c.action_scope}/revoke`, { body: {} }), "Согласие отозвано", reload)}>Отозвать</button>}</td></tr>)}
        </tbody></table>
      </div>
      {can("publish") && <div className="panel row">
        <span>Публикация для аккаунта {d.account.publishing_paused ? "приостановлена" : "активна"}.</span>
        <button className="btn" disabled={busy} onClick={() => run(() => api("/api/publishing/pause", { body: { scope: "account", id: d.account.id, paused: !d.account.publishing_paused } }), d.account.publishing_paused ? "Публикация возобновлена" : "Публикация приостановлена", reload)}>{d.account.publishing_paused ? "Возобновить публикацию" : "Приостановить публикацию"}</button>
      </div>}
    </div>
  );
}

