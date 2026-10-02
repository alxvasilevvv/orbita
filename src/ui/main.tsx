import { createRoot } from "react-dom/client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

/* ---------- инфраструктура ---------- */
let currentUser = localStorageGet("uid");
function localStorageGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } }

class ApiError extends Error { constructor(public status: number, msg: string, public details?: any) { super(msg); } }
async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "content-type": "application/json", ...(currentUser ? { "x-user-id": currentUser } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.message ?? `Ошибка ${r.status}`, data.details);
  return data;
}

type LoadState<T> = { data?: T; error?: ApiError; loading: boolean; reload: () => void };
function useApi<T = any>(path: string | null, deps: unknown[] = []): LoadState<T> {
  const [s, set] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    set((p) => ({ ...p, loading: true }));
    api<T>(path).then((data) => live && set({ data, loading: false }), (error) => live && set({ error, loading: false }));
    return () => { live = false; };
  }, [path, n, ...deps]);
  return { ...s, reload: () => setN((x) => x + 1) };
}

const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => {});
function useToast() { return useContext(ToastCtx); }

function useRoute() {
  const [h, setH] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => setH(location.hash.slice(1) || "/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
const go = (p: string) => { location.hash = p; };

function Loadable<T>({ s, empty, children }: { s: LoadState<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (s.error) {
    if (s.error.status === 401) return <div className="notice info">Выберите пользователя внизу слева, чтобы войти.</div>;
    if (s.error.status === 403) return <div className="notice error">{s.error.message}. Доступ выдаёт владелец агентства или операционный директор.</div>;
    if (s.error.status === 404) return <div className="notice error">Объект не найден или у вас нет к нему доступа.</div>;
    return <div className="notice error">{s.error.message}. <button className="btn" onClick={s.reload}>Повторить</button></div>;
  }
  if (s.loading && !s.data) return <p className="muted">Загрузка…</p>;
  if (s.data && empty?.(s.data)) return null;
  return <>{s.data && children(s.data)}</>;
}

/** Выполняет действие, показывает итог тем же глаголом, что и кнопка. */
function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try { await fn(); toast(done); after?.(); }
    catch (e: any) { toast(`${e.message}${Array.isArray(e.details) ? ": " + e.details.map((d: any) => d.message ?? d).join("; ") : ""}`, true); }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

const fmt = (d?: string | null, tz?: string) => d ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz, ...(tz ? { timeZoneName: "short" as const } : {}) }).format(new Date(d)) : "—";
const STATE_RU: Record<string, string> = { idea: "идея", brief: "бриф", draft: "черновик", editorial_review: "у редактора", client_review: "у клиента", approved: "согласован", scheduled: "запланирован", publishing: "публикуется", published: "опубликован", changes_requested: "нужны правки", cancelled: "отменён", failed: "ошибка", publication_unknown: "исход неизвестен", archived: "архив" };
const EV_RU: Record<string, string> = { api_confirmed: "Подтверждено API", manual_mark: "Ручная отметка", unconfirmed: "Не подтверждено", unknown: "Исход неизвестен" };
const MODE_RU: Record<string, string> = { api: "API", assisted: "Через человека", manual_import: "Ручной импорт", unavailable: "Недоступно" };
const KIND_RU: Record<string, string> = { executive: "Руководитель", founder: "Основатель", expert: "Эксперт", employee: "Сотрудник", job_seeker: "Поиск работы", company_page: "Страница компании" };
const State = ({ s }: { s: string }) => <span className={`state ${s}`}>{STATE_RU[s] ?? s}</span>;

/* ---------- каркас ---------- */
function App() {
  const route = useRoute();
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [uid, setUid] = useState(currentUser);
  const users = useApi<any[]>("/api/dev/users");
  const approvals = useApi<any[]>(uid ? "/api/approvals" : null, [uid]);
  const show = useCallback((msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4500); }, []);
  const switchUser = (id: string) => { currentUser = id; localStorageSet("uid", id); setUid(id); };
  useEffect(() => { if (!uid && users.data?.length) switchUser(users.data.find((u) => u.roles.includes("account_manager"))?.id ?? users.data[0].id); }, [users.data]);
  const nav = [["/", "Обзор"], ["/accounts", "Аккаунты"], ["/approvals", "Согласования", approvals.data?.length], ["/tasks", "Задачи"], ["/audit", "Журнал"], ["/integrations", "Интеграции"]] as const;
  const active = (p: string) => (p === "/" ? route === "/" : route.startsWith(p));
  let page: ReactNode;
  const m = route.match(/^\/accounts\/([^/]+)$/), c = route.match(/^\/content\/([^/]+)$/), rep = route.match(/^\/reports\/([^/]+)$/);
  if (m) page = <AccountPage id={m[1]} />;
  else if (c) page = <ContentPage id={c[1]} />;
  else if (rep) page = <ReportPage id={rep[1]} />;
  else if (route.startsWith("/accounts")) page = <Accounts />;
  else if (route.startsWith("/approvals")) page = <Approvals onChange={approvals.reload} />;
  else if (route.startsWith("/tasks")) page = <Tasks />;
  else if (route.startsWith("/audit")) page = <Audit />;
  else if (route.startsWith("/integrations")) page = <Integrations />;
  else page = <Overview />;
  return (
    <ToastCtx.Provider value={show}>
      <div className="shell">
        <nav className="side" aria-label="Разделы">
          <div className="brand">Agency LinkedIn OS<small>операционная система агентства</small></div>
          {nav.map(([p, l, n]) => <a key={p} href={`#${p}`} aria-current={active(p) ? "page" : undefined}>{l}{n ? <span className="count num">{n}</span> : null}</a>)}
          <div className="who">
            <label htmlFor="who" className="muted small">Вы вошли как (демо-вход)</label>
            <select id="who" value={uid ?? ""} onChange={(e) => switchUser(e.target.value)}>
              {users.data?.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
          </div>
        </nav>
        <main key={uid ?? "anon"}>{page}</main>
      </div>
      {toast && <div className={`toast ${toast.err ? "err" : ""}`} role="status">{toast.msg}</div>}
    </ToastCtx.Provider>
  );
}

/* ---------- обзор агентства ---------- */
function Overview() {
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
function AccountTable({ rows }: { rows: any[] }) {
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

function Accounts() {
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

/* ---------- рабочее пространство аккаунта ---------- */
const TABS = ["Обзор", "Стратегия", "База знаний", "Контент", "Задачи", "Аналитика", "Отчёты", "История действий", "Настройки и доступы"];
function AccountPage({ id }: { id: string }) {
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

function AccOverview({ d }: { d: any }) {
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

function AccStrategy({ d, reload }: { d: any; reload: () => void }) {
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

function AccKnowledge({ d, reload }: { d: any; reload: () => void }) {
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

function AccContent({ d, reload }: { d: any; reload: () => void }) {
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

function AccAnalytics({ d, reload }: { d: any; reload: () => void }) {
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

function AccReports({ d, reload }: { d: any; reload: () => void }) {
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

function AccHistory({ d }: { d: any }) {
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

function AccSettings({ d, reload }: { d: any; reload: () => void }) {
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

/* ---------- редактор материала ---------- */
function ContentPage({ id }: { id: string }) {
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
const accCache = new Map<string, any>();
function useApiAccount(accountId?: string) {
  const [a, setA] = useState<any>(accountId ? accCache.get(accountId) : undefined);
  useEffect(() => { if (accountId) api(`/api/accounts/${accountId}`).then((d) => { accCache.set(accountId, d); setA(d); }).catch(() => {}); }, [accountId]);
  return a;
}

/* ---------- центр согласований ---------- */
function Approvals({ onChange }: { onChange: () => void }) {
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
function TaskList({ rows, reload }: { rows: any[]; reload: () => void }) {
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
function Tasks() {
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
function Audit() {
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

function ReportPage({ id }: { id: string }) {
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

function Integrations() {
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

createRoot(document.getElementById("root")!).render(<App />);
