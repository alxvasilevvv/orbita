import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ToastCtx, useApi, useRoute, currentUser, setCurrentUser } from "./lib";
import { Overview, Accounts, Approvals, Tasks, Audit, ReportPage, Integrations } from "./screens/core";
import { AccountPage } from "./screens/account";
import { ContentPage } from "./screens/content";

/* ---------- каркас ---------- */
function App() {
  const route = useRoute();
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [uid, setUid] = useState(currentUser);
  const users = useApi<any[]>("/api/dev/users");
  const approvals = useApi<any[]>(uid ? "/api/approvals" : null, [uid]);
  const show = useCallback((msg: string, err?: boolean) => { setToast({ msg, err }); setTimeout(() => setToast(null), 4500); }, []);
  const switchUser = (id: string) => { setCurrentUser(id); setUid(id); };
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


createRoot(document.getElementById("root")!).render(<App />);
