import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ToastCtx, MeCtx, useApi, useRoute, currentUser, setCurrentUser, api, fmt, t, type Me } from "./lib";
import { getLocale, setLocale, type Locale } from "./i18n";
import { Overview, Accounts, Approvals, Tasks, Audit, ReportPage, Integrations } from "./screens/core";
import { AccountPage } from "./screens/account";
import { ContentPage } from "./screens/content";
import { CalendarPage } from "./screens/calendar";
import { EngagementPage } from "./screens/engagement";
import { WorkflowsPage } from "./screens/workflows";
import { TeamPage, IncidentsPage } from "./screens/team";
import { AgencyReportPage, ExportsPage } from "./screens/agency";
import { PortalPage } from "./screens/portal";

function Bell() {
  const [open, setOpen] = useState(false);
  const s = useApi<any[]>("/api/notifications");
  useEffect(() => { const i = setInterval(s.reload, 30_000); return () => clearInterval(i); }, []);
  const unread = (s.data ?? []).filter((n) => !n.read_at);
  return (
    <div className="bell">
      <button className="btn ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{t("Уведомления")}{unread.length ? <span className="count num">{unread.length}</span> : null}</button>
      {open && (
        <div className="bell-pop" role="dialog" aria-label={t("Уведомления")}>
          <div className="spread"><b>{t("Уведомления")}</b>{unread.length > 0 && <button className="btn link" onClick={async () => { await api("/api/notifications/read", { body: { ids: "all" } }); s.reload(); }}>{t("Отметить все прочитанными")}</button>}</div>
          {(s.data ?? []).length === 0 ? <p className="muted small">{t("Новых событий нет.")}</p> :
            <ul className="bell-list">{s.data!.slice(0, 30).map((n) => (
              <li key={n.id} className={n.read_at ? "read" : ""}>
                <a href={n.link ?? "#/"} onClick={async () => { setOpen(false); if (!n.read_at) { await api("/api/notifications/read", { body: { ids: [n.id] } }); s.reload(); } }}>{t(n.title)}</a>
                <div className="muted small">{fmt(n.created_at)}</div>
              </li>))}</ul>}
        </div>)}
    </div>
  );
}

function App() {
  const route = useRoute();
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [uid, setUid] = useState(currentUser);
  const [locale, setLoc] = useState<Locale>(getLocale());
  const users = useApi<any[]>("/api/dev/users");
  const me = useApi<Me>(uid ? "/api/me" : null, [uid]);
  const approvals = useApi<any[]>(uid && me.data && !me.data.client_only ? "/api/approvals" : null, [uid, me.data?.id]);
  const show = useCallback((msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 5000); }, []);
  const switchUser = (id: string) => { setCurrentUser(id); setUid(id); location.hash = "/"; };
  const switchLocale = (l: Locale) => { setLocale(l); setLoc(l); if (uid) api("/api/me", { method: "PATCH", body: { locale: l } }).catch(() => {}); };
  useEffect(() => { if (!uid && users.data?.length) switchUser(users.data.find((u) => u.roles.includes("account_manager"))?.id ?? users.data[0].id); }, [users.data]);
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const m = me.data;
  const ops = new Set(m?.agency_ops ?? []);
  const nav: [string, string, number?][] = m?.client_only
    ? [["/", "Кабинет клиента"]]
    : [
        ["/", "Обзор"], ["/accounts", "Аккаунты"], ["/calendar", "Календарь"], ["/approvals", "Согласования", approvals.data?.length],
        ["/engagement", "Взаимодействия"], ["/tasks", "Задачи"],
        ...(ops.has("view_finance") ? [["/agency-report", "Экономика агентства"] as [string, string]] : []),
        ...(ops.has("manage_team") ? [["/team", "Команда"] as [string, string]] : []),
        ...(ops.has("manage_tasks") ? [["/workflows", "Сценарии"] as [string, string], ["/incidents", "Инциденты"] as [string, string]] : []),
        ["/exports", "Экспорты"],
        ...(ops.has("view_audit") ? [["/audit", "Журнал аудита"] as [string, string]] : []),
        ["/integrations", "Интеграции"],
      ];
  const active = (p: string) => (p === "/" ? route === "/" : route.startsWith(p));
  let page: ReactNode;
  const acc = route.match(/^\/accounts\/([^/]+)$/), c = route.match(/^\/content\/([^/]+)$/), rep = route.match(/^\/reports\/([^/]+)$/);
  if (!m) page = me.error ? <div className="notice info">{t("Выберите пользователя внизу слева, чтобы войти.")}</div> : <p className="muted">{t("Загрузка…")}</p>;
  else if (m.client_only) page = c ? <ContentPage id={c[1]} /> : rep ? <ReportPage id={rep[1]} /> : <PortalPage />;
  else if (acc) page = <AccountPage id={acc[1]} />;
  else if (c) page = <ContentPage id={c[1]} />;
  else if (rep) page = <ReportPage id={rep[1]} />;
  else if (route.startsWith("/accounts")) page = <Accounts />;
  else if (route.startsWith("/calendar")) page = <CalendarPage />;
  else if (route.startsWith("/approvals")) page = <Approvals onChange={approvals.reload} />;
  else if (route.startsWith("/engagement")) page = <EngagementPage />;
  else if (route.startsWith("/tasks")) page = <Tasks />;
  else if (route.startsWith("/agency-report")) page = <AgencyReportPage />;
  else if (route.startsWith("/team")) page = <TeamPage />;
  else if (route.startsWith("/workflows")) page = <WorkflowsPage />;
  else if (route.startsWith("/incidents")) page = <IncidentsPage />;
  else if (route.startsWith("/exports")) page = <ExportsPage />;
  else if (route.startsWith("/audit")) page = <Audit />;
  else if (route.startsWith("/integrations")) page = <Integrations />;
  else page = <Overview />;
  return (
    <ToastCtx.Provider value={show}>
      <MeCtx.Provider value={m ?? null}>
        <div className="shell" key={locale}>
          <nav className="side" aria-label={t("Разделы")}>
            <div className="brand">Agency LinkedIn OS<small>{t("операционная система агентства")}</small></div>
            {nav.map(([p, l, n]) => <a key={p} href={`#${p}`} aria-current={active(p) ? "page" : undefined}>{t(l)}{n ? <span className="count num">{n}</span> : null}</a>)}
            <div className="who">
              <label htmlFor="who" className="muted small">{t("Вы вошли как (демо-вход)")}</label>
              <select id="who" value={uid ?? ""} onChange={(e) => switchUser(e.target.value)}>
                {users.data?.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
              </select>
              <div className="lang" role="group" aria-label={t("Язык интерфейса")}>
                {(["ru", "en"] as Locale[]).map((l) => <button key={l} className={`btn ghost small ${locale === l ? "on" : ""}`} aria-pressed={locale === l} onClick={() => switchLocale(l)}>{l.toUpperCase()}</button>)}
              </div>
            </div>
          </nav>
          <div className="main-col">
            {m && <header className="top"><span className="muted small">{m.display_name}</span><Bell /></header>}
            <main key={uid ?? "anon"}>{page}</main>
          </div>
        </div>
        {toast && <div className={`toast ${toast.err ? "err" : ""}`} role="status">{toast.msg}</div>}
      </MeCtx.Provider>
    </ToastCtx.Provider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
