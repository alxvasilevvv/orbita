import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, num, useMe, ApiError } from "../lib";
import { tx } from "../i18n";

export const MISSION_RU: Record<string, string> = {
  amplify_post: "Поддержать пост компании", company_news: "Новость компании", discussion: "Обсуждение по существу",
  tech_breakdown: "Технический разбор", engineering_blog: "Инженерный блог", open_source: "Open source релиз", event_talk: "Выступление или митап", hiring: "Вакансия",
};
const MSTATUS_RU: Record<string, string> = { planned: "планируется", active: "идёт", completed: "завершена", cancelled: "отменена", blocked: "остановлена проверками" };
const ASTATUS_RU: Record<string, string> = { awaiting_owner: "ждёт решения", approved: "одобрено", executing: "выполняется", done: "сделано", skipped: "пропущено", rejected: "отклонено", blocked: "заблокировано", expired: "истекло", unknown: "исход неизвестен" };
const KIND_ACT_RU: Record<string, string> = { react: "Реакция", comment: "Комментарий", repost_note: "Репост с личной заметкой", post: "Собственный пост" };
const LEVEL_RU: Record<string, string> = { low: "низкий", medium: "средний", high: "высокий", blocked: "заблокирован" };
const MODE_LIM_RU: Record<string, string> = { normal: "штатный", ramp: "разгон", half: "половинные лимиты", blocked: "остановлен" };
const AGENT_RU: Record<string, string> = { planner: "Стратег и планировщик", director: "Директор", reporter: "Отчётчик" };
function describeDecisions(d: any, labels: Record<string, string>) {
  if (!d) return "–";
  const parts: string[] = [];
  if (d.planned != null) parts.push(`${t("запланировано действий")}: ${d.planned}`);
  if (d.tags?.length) parts.push(`${t("темы поста")}: ${d.tags.join(", ")}`);
  const v = Object.entries(d.vetoed ?? {}).filter(([, n]) => n);
  if (v.length) parts.push(`${t("отсеяно")}: ${v.map(([k, n]) => `${t(labels[k] ?? k)} (${n})`).join("; ")}`);
  if (d.blocked?.length) parts.push(d.blocked.map(tx).join("; "));
  return parts.join(" · ") || "–";
}
const SIGNAL_RU: Record<string, string> = { warning: "Предупреждение", captcha: "Капча", restriction: "Временное ограничение", identity_check: "Подтверждение личности", comment_hidden: "Комментарии скрыты", token_revoked: "Доступ отозван" };

/** Портфель агентства: все компании, день онбординга, подключение, риски. */
export function CompaniesPage() {
  const s = useApi<any[]>("/api/companies/portfolio");
  return (
    <>
      <h1>{t("Компании")}</h1>
      <p className="lede">{t("Компании-клиенты с командами сотрудников: онбординг, подключение, риски аккаунтов, миссии агентов.")}</p>
      <Loadable s={s} empty={(d) => !d.length}>{(d) => (
        <table>
          <thead><tr><th>{t("Компания")}</th><th>{t("Онбординг")}</th><th>{t("Подключено")}</th><th>{t("Подтверждено")}</th><th>{t("Миссии")}</th><th>{t("Сигналы LinkedIn, 7 дней")}</th><th>{t("Аккаунты на паузе")}</th><th>{t("Ждут ответа > 24 ч")}</th><th>{t("Статус")}</th></tr></thead>
          <tbody>{d.map((c) => (
            <tr key={c.id}>
              <td><a href={`#/companies/${c.id}`}><b>{c.name}</b></a></td>
              <td className="num">{c.onboarding_day ? `${t("день")} ${c.onboarding_day} ${t("из")} 14` : t("бриф не начат")}</td>
              <td className="num">{c.connected}</td><td className="num">{c.verified}</td><td className="num">{c.missions_active}</td>
              <td className={`num ${c.signals_7d ? "bad" : ""}`}>{c.signals_7d}</td><td className="num">{c.accounts_paused}</td><td className="num">{c.waiting_over_24h}</td>
              <td>{c.engagement_paused_at ? <span className="state failed">{t("остановлена")}</span> : c.brief_status === "approved" ? <span className="state approved">{t("работает")}</span> : <span className="state draft">{t("нужен бриф")}</span>}</td>
            </tr>))}</tbody>
        </table>)}</Loadable>
    </>
  );
}

/** Кабинет компании: руководитель видит агрегаты, агентство дополнительно персональную таблицу аккаунтов. */
export function CompanyPage({ id }: { id: string }) {
  const s = useApi<any>(`/api/companies/${id}`);
  const [tab, setTab] = useState<"overview" | "missions" | "team" | "brief">("overview");
  return (
    <Loadable s={s}>{(d) => (
      <>
        <h1>{d.company.name}</h1>
        <p className="lede">{t("Как компания выглядит снаружи, что делает команда и где нужны ваши решения. Агенты предлагают, сотрудники решают сами, офицер безопасности держит аккаунты в безопасной зоне.")}</p>
        {d.company.engagement_paused_at && <div className="notice warn">{t("Активность компании остановлена")}: {d.company.engagement_paused_reason}. {t("Снять остановку может команда агентства.")}</div>}
        <div className="tabs" role="tablist">
          {([["overview", "Обзор"], ["missions", "Миссии агентов"], ["team", "Команда"], ["brief", "Бриф компании"]] as const).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{t(l)}</button>))}
        </div>
        {tab === "overview" && <CompanyOverview d={d} reload={s.reload} onTab={setTab} />}
        {tab === "missions" && <Missions d={d} reload={s.reload} />}
        {tab === "team" && <Team d={d} reload={s.reload} />}
        {tab === "brief" && <Brief d={d} reload={s.reload} />}
      </>)}</Loadable>
  );
}

function CompanyOverview({ d, reload, onTab }: { d: any; reload: () => void; onTab: (x: any) => void }) {
  const o = d.seen_from_outside;
  const { busy, run } = useAction();
  const [reason, setReason] = useState("");
  return (
    <div className="grid">
      <section className="panel">
        <h3>{t("Как нас видят")}</h3>
        {!o ? <p className="muted">{t("Страница компании ещё не подключена к платформе.")}</p> : (
          <div className="vitals">
            <div className="vital"><b className="num">{num(o.followers)}</b><span>{t("подписчиков страницы")}{o.followers_delta_30d != null ? ` (${o.followers_delta_30d >= 0 ? "+" : ""}${num(o.followers_delta_30d)} ${t("за 30 дней")})` : ""}</span></div>
            <div className="vital"><b className="num">{o.posts_30d}</b><span>{t("постов страницы за 30 дней")}</span></div>
            <div className={`vital ${o.days_since_post != null && o.days_since_post > 7 ? "bad" : ""}`}><b className="num">{o.days_since_post ?? "–"}</b><span>{t("дней с последнего поста")}</span></div>
            <div className="vital"><b className="num">{o.open_roles}</b><span>{t("вакансий в работе")}</span></div>
          </div>)}
        <p className="small muted">{t("Подписчики вносятся из выгрузки страницы или через API после одобрения LinkedIn. Действия команды не считаются результатом.")}</p>
      </section>
      <div className="grid cols-2">
        <section className="panel">
          <h3>{t("Команда")}</h3>
          <p><b className="num">{d.team.connected}</b> {t("подключено")}, <b className="num">{d.team.verified}</b> {t("с подтверждённым трудоустройством")}, <b className="num">{d.team.invites_pending}</b> {t("приглашений ждут ответа")}.</p>
          <p>{d.team.active_30d == null ? <span className="muted small">{t("Участие показывается от 5 подключённых сотрудников, чтобы цифры не указывали на конкретных людей.")}</span> : <>{t("Участвовали за 30 дней")}: <b className="num">{d.team.active_30d}</b></>}</p>
          <button className="btn" onClick={() => onTab("team")}>{t("Пригласить сотрудников")}</button>
        </section>
        <section className="panel">
          <h3>{t("Безопасность аккаунтов")}</h3>
          {d.internal ? <p>{t("Сигналов LinkedIn за 7 дней")}: <b className={`num ${d.risk.signals_7d ? "bad" : ""}`}>{d.risk.signals_7d}</b> · {t("аккаунтов на паузе")}: <b className="num">{d.risk.accounts_paused}</b></p>
            : <p>{d.risk.status === "ok" ? t("Ограничений LinkedIn нет, все аккаунты в штатном режиме.") : <span className="bad">{t("У части аккаунтов временные ограничения: агентство разбирается, активность по ним остановлена.")}</span>}</p>}
          {d.risk.distribution ? <p className="small">{Object.entries(d.risk.distribution).map(([k, v]) => `${t(LEVEL_RU[k] ?? k)}: ${v}`).join(" · ")}</p> : <p className="small muted">{t("Распределение риска показывается от 5 сотрудников.")}</p>}
          <details><summary className="small">{t("Остановить всю активность компании")}</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <input type="text" placeholder={t("Причина")} value={reason} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} />
              <button className="btn danger" disabled={busy || reason.trim().length < 3 || !!d.company.engagement_paused_at} onClick={() => run(() => api(`/api/companies/${d.company.id}/pause`, { body: { paused: true, reason } }), "Активность остановлена", reload)}>{t("Остановить")}</button>
              {d.internal && d.company.engagement_paused_at && <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/companies/${d.company.id}/pause`, { body: { paused: false } }), "Активность возобновлена", reload)}>{t("Возобновить")}</button>}
            </div></details>
        </section>
      </div>
      <section className="panel">
        <h3>{t("Нужны ваши решения")}</h3>
        {d.decisions.length === 0 ? <p className="muted">{t("Сейчас ничего не ждёт вашего решения.")}</p> :
          <ul>{d.decisions.map((x: any, i: number) => <li key={i}>{x.link ? <a href={x.link}>{tx(x.title)}</a> : tx(x.title)}</li>)}</ul>}
      </section>
      <section className="panel">
        <div className="spread"><h3>{t("Миссии агентов")}</h3><button className="btn primary" onClick={() => onTab("missions")}>{t("Новая миссия")}</button></div>
        <MissionTable rows={d.missions.slice(0, 5)} />
      </section>
    </div>
  );
}

function MissionTable({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="muted">{t("Миссий пока нет. Начните с поддержки свежего поста страницы.")}</p>;
  return (
    <table><thead><tr><th>{t("Миссия")}</th><th>{t("Тип")}</th><th>{t("Окно")}</th><th>{t("Сделано")}</th><th>{t("Статус")}</th></tr></thead>
      <tbody>{rows.map((m) => (
        <tr key={m.id}><td><a href={`#/missions/${m.id}`}>{m.title}</a>{m.blocked_reasons?.length ? <div className="small bad">{m.blocked_reasons.map(tx).join("; ")}</div> : null}</td>
          <td>{t(MISSION_RU[m.type] ?? m.type)}</td><td className="small">{fmt(m.window_start)} – {fmt(m.window_end)}</td>
          <td className="num">{m.total == null ? <span className="muted small" title={t("Счётчики показываются от 5 участников")}>{t("скрыто")}</span> : `${m.done ?? "–"} / ${m.total}`}</td><td><span className={`state ${m.status === "active" ? "scheduled" : m.status === "completed" ? "published" : m.status === "blocked" ? "failed" : "draft"}`}>{t(MSTATUS_RU[m.status] ?? m.status)}</span></td></tr>))}</tbody></table>
  );
}

function Missions({ d, reload }: { d: any; reload: () => void }) {
  const brief = d.briefs.find((b: any) => b.status === "approved");
  const { busy, run } = useAction();
  const [f, setF] = useState({ type: "amplify_post", title: "", objective: "", target_url: "", target_excerpt: "", is_company: true, tags: [] as string[], window_hours: 48 });
  const [res, setRes] = useState<any>(null);
  const own = ["tech_breakdown", "engineering_blog", "open_source", "event_talk"].includes(f.type);
  return (
    <div className="grid cols-2-1">
      <section className="panel"><h3>{t("Все миссии")}</h3><MissionTable rows={d.missions} /></section>
      <section className="panel form">
        <h3>{t("Новая миссия")}</h3>
        {!brief ? <p className="muted">{t("Агенты работают только по утверждённому брифу компании.")}</p> : <>
          <label>{t("Тип")}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{Object.keys(MISSION_RU).map((k) => <option key={k} value={k}>{t(MISSION_RU[k])}</option>)}</select></label>
          <label>{t("Тема")}<input type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label>{t("Что важно донести")}<textarea rows={2} value={f.objective} onChange={(e) => setF({ ...f, objective: e.target.value })} /></label>
          {!own && <>
            <label>{t("Ссылка на пост в LinkedIn")}<input type="url" placeholder="https://www.linkedin.com/feed/update/urn:li:activity:…" value={f.target_url} onChange={(e) => setF({ ...f, target_url: e.target.value })} /></label>
            <label className="row small"><input type="checkbox" checked={f.is_company} onChange={(e) => setF({ ...f, is_company: e.target.checked })} /> {t("Это пост нашей страницы компании (агент может подготовить черновики комментариев)")}</label>
            <label>{t("Текст поста (для подбора участников)")}<textarea rows={3} value={f.target_excerpt} onChange={(e) => setF({ ...f, target_excerpt: e.target.value })} /></label>
          </>}
          <fieldset><legend className="small">{t("Темы из брифа")}</legend><div className="row">{(brief.topics ?? []).map((tp: any) => (
            <label key={tp.tag} className="chip"><input type="checkbox" checked={f.tags.includes(tp.tag)} onChange={(e) => setF({ ...f, tags: e.target.checked ? [...f.tags, tp.tag] : f.tags.filter((x) => x !== tp.tag) })} /> {tp.tag}</label>))}</div></fieldset>
          <label>{t("Окно, часов")} <input type="number" min={2} max={72} value={f.window_hours} onChange={(e) => setF({ ...f, window_hours: Number(e.target.value) })} /></label>
          <p className="small muted">{t("Агенты выберут не больше 25% подключённых сотрудников (до 5), чья экспертиза относится к теме, разнесут действия по времени и спросят каждого. Первый час после публикации действий нет.")}</p>
          <button className="btn primary" disabled={busy || f.title.trim().length < 3 || (!own && !f.target_url)} onClick={() => run(async () => {
            const r = await api(`/api/companies/${d.company.id}/missions`, { body: { type: f.type, title: f.title, objective: f.objective, target_url: own ? undefined : f.target_url, target_excerpt: f.target_excerpt || undefined, target_is_company_post: f.is_company, topic_tags: f.tags, window_hours: f.window_hours } });
            setRes(r); return r;
          }, "Миссия создана", reload)}>{t("Запустить агентов")}</button>
          {res && <div className="notice info small" style={{ marginTop: 10 }}>
            {t("Запланировано действий")}: <b>{res.plan?.planned ?? 0}</b>{res.plan?.participants != null ? `, ${t("участников")}: ${res.plan.participants}` : ""}. {res.plan?.reasons?.length ? res.plan.reasons.map(tx).join("; ") : ""}
            {res.plan?.vetoed && Object.keys(res.plan.vetoed).length ? <div>{t("Офицер безопасности отсеял")}: {Object.entries(res.plan.vetoed).filter(([, v]) => v).map(([k, v]) => `${t(res.veto_labels?.[k] ?? k)}: ${v}`).join("; ")}</div> : null}
          </div>}
        </>}
      </section>
    </div>
  );
}

export function MissionPage({ id }: { id: string }) {
  const s = useApi<any>(`/api/missions/${id}`);
  const me = useMe();
  const { busy, run } = useAction();
  return (
    <Loadable s={s}>{(d) => (
      <>
        <a href={`#/companies/${d.mission.client_id}`} className="small">{t("К компании")}</a>
        <h1>{d.mission.title}</h1>
        <p className="lede">{t(MISSION_RU[d.mission.type])} · {t(MSTATUS_RU[d.mission.status])} · {fmt(d.mission.window_start)} – {fmt(d.mission.window_end)}</p>
        {d.mission.target_url && <p className="small"><a href={d.mission.target_url} target="_blank" rel="noreferrer">{t("Открыть пост")}</a></p>}
        <div className="grid cols-2">
          <section className="panel">
            <h3>{t("Что сделала команда")}</h3>
            {!d.output ? <p className="muted">{t("Счётчики по миссии показываются от 5 участников, чтобы не указывать на конкретных людей.")}</p> : <div className="vitals">
              <div className="vital"><b className="num">{d.output.total}</b><span>{t("предложено")}</span></div>
              <div className="vital"><b className="num">{d.output.done}</b><span>{t("сделано")}</span></div>
              <div className="vital"><b className="num">{d.output.in_progress}</b><span>{t("в работе")}</span></div>
              <div className="vital"><b className="num">{d.output.not_done}</b><span>{t("не сделано")}</span></div>
            </div>}
            <p className="small muted">{t("Это работа команды, а не результат. Кто именно пропустил предложение, не показывается.")}</p>
          </section>
          <section className="panel">
            <h3>{t("Результат")}</h3>
            <p className="muted">{d.outcome.status === "not_computable" ? t("Не рассчитывается") : ""}: {tx(d.outcome.reason)}</p>
          </section>
        </div>
        {d.agents && <section className="panel">
          <h3>{t("Решения агентов")}</h3>
          <table><thead><tr><th>{t("Агент")}</th><th>{t("Статус")}</th><th>{t("Решения")}</th><th>{t("Время")}</th></tr></thead>
            <tbody>{d.agents.map((r: any, i: number) => <tr key={i}><td>{t(AGENT_RU[r.agent] ?? r.agent)}</td><td>{r.status === "ok" ? t("выполнено") : r.status}</td><td className="small">{describeDecisions(r.decisions, d.veto_labels)}</td><td className="small">{fmt(r.started_at)}</td></tr>)}</tbody></table>
        </section>}
        {d.actions && <section className="panel">
          <h3>{t("Действия по аккаунтам (видит только агентство)")}</h3>
          <table><thead><tr><th>{t("Аккаунт")}</th><th>{t("Действие")}</th><th>{t("Когда")}</th><th>{t("Режим")}</th><th>{t("Статус")}</th><th>{t("Проверки")}</th></tr></thead>
            <tbody>{d.actions.map((a: any) => <tr key={a.id}><td>{a.display_name}</td><td>{t(KIND_ACT_RU[a.kind])}{a.ai_drafted ? <span className="small muted"> · AI</span> : null}</td><td className="small">{fmt(a.scheduled_at)}</td><td>{a.exec_mode === "api" ? "API" : t("Через человека")}</td><td>{t(ASTATUS_RU[a.status] ?? a.status)}</td>
              <td className="small">{[...(a.veto_codes ?? []), ...(a.warnings ?? [])].map((x: string) => t(d.veto_labels[x] ?? x)).join("; ") || "–"}</td></tr>)}</tbody></table>
        </section>}
        {["planned", "active", "blocked"].includes(d.mission.status) && (me?.internal || me?.company_admin) &&
          <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/missions/${id}/cancel`, { body: { reason: "Отменено руководителем" } }), "Миссия отменена", s.reload)}>{t("Отменить миссию")}</button>}
      </>)}</Loadable>
  );
}

function Team({ d, reload }: { d: any; reload: () => void }) {
  const inv = useApi<any[]>(`/api/companies/${d.company.id}/invites`);
  const { busy, run } = useAction();
  const [f, setF] = useState({ email: "", display_name: "", title: "", timezone: "" });
  const [link, setLink] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  return (
    <div className="grid cols-2-1">
      <section className="panel">
        {d.accounts ? <>
          <h3>{t("Аккаунты сотрудников (видит только агентство)")}</h3>
          <table><thead><tr><th>{t("Сотрудник")}</th><th>{t("Экспертиза")}</th><th>{t("Трудоустройство")}</th><th>{t("Риск")}</th><th>{t("Режим лимитов")}</th><th /></tr></thead>
            <tbody>{d.accounts.map((a: any) => <tr key={a.account_id}><td><a href={`#/accounts/${a.account_id}`}>{a.display_name}</a></td><td className="small">{a.expertise.join(", ") || "–"}</td>
              <td>{a.verified ? t("подтверждено") : <button className="btn small" disabled={busy} onClick={() => run(() => api(`/api/accounts/${a.account_id}/confirm-employment`, { body: {} }), "Трудоустройство подтверждено", reload)}>{t("Подтвердить")}</button>}</td>
              <td><span className={`state ${a.level === "low" ? "approved" : a.level === "medium" ? "client_review" : "failed"}`}>{t(LEVEL_RU[a.level])}{a.score != null ? ` ${num(a.score)}` : ""}</span></td>
              <td>{t(MODE_LIM_RU[a.mode] ?? a.mode)}</td>
              <td>{a.level === "blocked" && <button className="btn small" disabled={busy} onClick={() => run(() => api(`/api/accounts/${a.account_id}/safety/restore`, { body: {} }), "Аккаунт возвращён на половинные лимиты", reload)}>{t("Вернуть после разбора")}</button>}</td></tr>)}</tbody></table>
        </> : <>
          <h3>{t("Команда")}</h3>
          <p>{t("Подключено")}: <b>{d.team.connected}</b>, {t("подтверждено")}: <b>{d.team.verified}</b>.</p>
          <p className="small muted">{t("Руководитель видит только общие цифры. Пропуски, отказы, риск и черновики конкретного сотрудника видит только он сам и команда агентства.")}</p>
        </>}
      </section>
      <section className="panel form">
        <h3>{t("Пригласить сотрудника")}</h3>
        <p className="small muted">{t("Сотрудник сам подключает свой аккаунт LinkedIn и сам решает, в чём участвовать. Подключайте только тех, кто действительно работает в компании.")}</p>
        <label>{t("Рабочая почта")}<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
        <label>{t("Имя и роль")}<input type="text" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></label>
        <label>{t("Часовой пояс")}<input type="text" placeholder="Europe/Berlin" value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></label>
        <button className="btn primary" disabled={busy || !f.email || f.display_name.length < 2} onClick={() => run(async () => { const r = await api(`/api/companies/${d.company.id}/invites`, { body: { ...f, timezone: f.timezone || undefined, title: f.title || undefined } }); setLink(r.invite_link ? `${location.origin}/${r.invite_link}` : null); setSent(r.sent_to); setF({ email: "", display_name: "", title: "", timezone: "" }); inv.reload(); return r; }, "Приглашение создано")}>{t("Создать приглашение")}</button>
        {sent && <div className="notice info small" style={{ marginTop: 10 }}>{t("Приглашение отправлено на")} {sent}. {t("Ссылка действует 72 часа и открывается один раз.")}
          {link && <div>{t("Демо-режим, ссылка для проверки")}: <code style={{ wordBreak: "break-all" }}>{link}</code></div>}</div>}
        <Loadable s={inv} empty={(x) => !x.length}>{(rows) => (
          <ul className="plain" style={{ marginTop: 12 }}>{rows.map((r) => <li key={r.id} className="spread small"><span>{r.display_name} · {r.email}</span><span>{t({ pending: "ждёт", accepted: "принято", expired: "истекло", revoked: "отозвано" }[r.status as string] ?? r.status)}{r.status === "pending" && <button className="btn link" onClick={() => run(() => api(`/api/invites/${r.id}/revoke`, { body: {} }), "Приглашение отозвано", inv.reload)}>{t("Отозвать")}</button>}</span></li>)}</ul>)}</Loadable>
      </section>
    </div>
  );
}

function Brief({ d, reload }: { d: any; reload: () => void }) {
  const cur = d.briefs.find((b: any) => b.status === "approved") ?? d.briefs[0];
  const draft = d.briefs.find((b: any) => b.status === "draft");
  const { busy, run } = useAction();
  const [f, setF] = useState({
    industry: cur?.industry ?? "general", positioning: cur?.positioning ?? "",
    topics: (cur?.topics ?? []).map((x: any) => `${x.tag}: ${(x.keywords ?? []).join(", ")}`).join("\n"),
    forbidden: (cur?.forbidden_topics ?? []).join(", "), domains: (cur?.email_domains ?? []).join(", "), intensity: cur?.intensity ?? "low",
  });
  const parseTopics = () => f.topics.split("\n").map((l: string) => l.trim()).filter(Boolean).map((l: string) => { const [tag, kw] = l.split(":"); return { tag: tag.trim().toLowerCase(), weight: 1, keywords: (kw ?? "").split(",").map((x) => x.trim()).filter((x) => x.length >= 2) }; });
  return (
    <div className="grid cols-2">
      <section className="panel form">
        <h3>{t("Бриф компании")}{cur ? ` v${cur.version}` : ""}</h3>
        {draft && <div className="notice info small">{t("Черновик")} v{draft.version} {t("ждёт утверждения агентства")}. {d.internal && <><button className="btn small" disabled={busy} onClick={() => run(() => api(`/api/briefs/${draft.id}/approve`, { body: {} }), "Бриф утверждён", reload)}>{t("Утвердить")}</button></>}</div>}
        <label>{t("Отрасль")}<select value={f.industry} onChange={(e) => setF({ ...f, industry: e.target.value })}>
          {[["general", "Общая"], ["crypto", "Криптоактивы"], ["fin", "Финансовые услуги"], ["health", "Здравоохранение"]].map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select></label>
        {(f.industry === "crypto" || f.industry === "fin") && <p className="small notice warn">{t("Регулируемая отрасль: связь с работодателем указывается в каждом тексте, обещания доходности и призывы к депозиту блокируются, новости и собственные посты требуют утверждения compliance клиента.")}</p>}
        <label>{t("Позиционирование")}<textarea rows={3} value={f.positioning} onChange={(e) => setF({ ...f, positioning: e.target.value })} /></label>
        <label>{t("Темы экспертизы (тема: ключевые слова)")}<textarea rows={5} value={f.topics} onChange={(e) => setF({ ...f, topics: e.target.value })} /></label>
        <label>{t("Запрещённые темы")}<input type="text" value={f.forbidden} onChange={(e) => setF({ ...f, forbidden: e.target.value })} /></label>
        <label>{t("Домены рабочей почты (подтверждение трудоустройства)")}<input type="text" value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} /></label>
        <label>{t("Интенсивность")}<select value={f.intensity} onChange={(e) => setF({ ...f, intensity: e.target.value })}><option value="low">{t("Низкая: 1 запрос сотруднику в неделю")}</option><option value="normal">{t("Обычная")}</option></select></label>
        <button className="btn primary" disabled={busy || f.positioning.length < 10} onClick={() => run(() => api(`/api/companies/${d.company.id}/brief`, { body: { industry: f.industry, positioning: f.positioning, topics: parseTopics(), forbidden_topics: f.forbidden.split(",").map((x: string) => x.trim()).filter((x: string) => x.length >= 2), email_domains: f.domains.split(",").map((x: string) => x.trim()).filter(Boolean), intensity: f.intensity } }), "Новая версия брифа отправлена на утверждение", reload)}>{t("Предложить новую версию")}</button>
      </section>
      <section className="panel">
        <h3>{t("Правила, которые агенты не нарушают")}</h3>
        <ul className="small">
          <li>{t("Каждое действие одобряет владелец аккаунта в момент выполнения; постоянных разрешений нет.")}</li>
          <li>{t("Действия выполняет сам сотрудник или официальный API LinkedIn; браузерной автоматизации нет.")}</li>
          <li>{t("На один пост не больше 25% подключённых сотрудников и не больше 5, первый час тишина, между действиями от 45 минут.")}</li>
          <li>{t("Комментарии только от тех, чья экспертиза относится к теме; тексты уникальны и проверяются на похожесть.")}</li>
          <li>{t("Лимиты сотрудника: 2 комментария и 5 реакций в сутки, 1 запрос в неделю; первые 14 дней вдвое меньше.")}</li>
          <li>{t("Любой сигнал LinkedIn останавливает аккаунт на 24 часа, затем 7 дней половинных лимитов; три сигнала за 30 дней исключают аккаунт.")}</li>
          <li>{t("Черновики AI готовятся только к постам компании и только из подтверждённых фактов сотрудника.")}</li>
        </ul>
      </section>
    </div>
  );
}

/** Сотрудник: предложения агентов, свои лимиты, риск, пауза, «LinkedIn предупредил». */
export function MyActions() {
  const s = useApi<any[]>("/api/me/actions");
  const p = useApi<any>("/api/me/participation");
  const { busy, run } = useAction();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Record<string, string[]>>({});
  const decide = (a: any, decision: "approve" | "skip") => run(async () => {
    try { setErr({ ...err, [a.id]: [] }); return await api(`/api/mission-actions/${a.id}/decision`, { body: { decision, text: texts[a.id] ?? a.final_text ?? a.proposed_text ?? undefined } }); }
    catch (e) { if (e instanceof ApiError && Array.isArray(e.details)) setErr({ ...err, [a.id]: e.details }); throw e; }
  }, decision === "skip" ? "Пропущено" : "Одобрено", s.reload);
  return (
    <section className="portal-acc">
      <h2>{t("Предложения от команды компании")}</h2>
      <p className="small muted">{t("Только по вашим темам и не чаще раза в неделю. Пропуск ни на что не влияет и не виден руководителю.")}</p>
      <Loadable s={s} empty={(d) => !d.length}>{(rows) => (
        <div className="list">{rows.map((a) => (
          <div key={a.id} className="item">
            <div className="spread"><b>{t(KIND_ACT_RU[a.kind])}: {a.mission_title}</b><span className="small muted">{t(ASTATUS_RU[a.status] ?? a.status)} · {t("не раньше")} {fmt(a.scheduled_at, a.timezone)}</span></div>
            {a.target_url && <a className="small" href={a.target_url} target="_blank" rel="noreferrer">{t("Открыть пост")}</a>}
            <p className="small muted">{tx(a.rationale)}</p>
            {a.status === "awaiting_owner" && a.kind !== "react" && <>
              {a.ai_drafted && <p className="small">{t("Черновик AI: перепишите своими словами, служебные пометки нужно убрать.")}</p>}
              {a.warnings?.includes("ai_not_allowed_external_post") && <p className="small muted">{t("К чужим постам AI черновики не готовит: напишите комментарий сами.")}</p>}
              <textarea rows={3} value={texts[a.id] ?? a.proposed_text ?? ""} onChange={(e) => setTexts({ ...texts, [a.id]: e.target.value })} aria-label={t("Текст")} />
            </>}
            {err[a.id]?.length ? <ul className="reasons">{err[a.id].map((x) => <li key={x}>{tx(x)}</li>)}</ul> : null}
            <div className="row" style={{ marginTop: 6 }}>
              {a.status === "awaiting_owner" && <>
                <button className="btn primary" disabled={busy} onClick={() => decide(a, "approve")}>{a.kind === "react" ? t("Поставлю реакцию") : t("Одобрить текст")}</button>
                <button className="btn" disabled={busy} onClick={() => decide(a, "skip")}>{t("Пропустить")}</button></>}
              {a.status === "approved" && a.exec_mode === "assisted" && <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/mission-actions/${a.id}/done`, { body: {} }), "Отмечено как сделанное", s.reload)}>{t("Сделал")}</button>}
              {a.status === "approved" && a.exec_mode === "api" && <span className="small muted">{t("Выполнится через API в назначенное время")}</span>}
            </div>
          </div>))}</div>)}</Loadable>
      <Loadable s={p}>{(d) => d.accounts.map((x: any) => (
        <div key={x.account.id} className="panel" style={{ marginTop: 14 }}>
          <div className="spread"><h3>{t("Мой аккаунт")}: {x.account.display_name}</h3><span className={`state ${x.risk.level === "low" ? "approved" : x.risk.level === "medium" ? "client_review" : "failed"}`}>{t("риск")} {t(LEVEL_RU[x.risk.level])}</span></div>
          <p className="small">{t("Режим")}: {t(MODE_LIM_RU[(x.limits.comment as any).mode])}. {t("Комментарии за сутки, включая предложенные")}: {(x.limits.comment as any).used.day} {t("из")} {(x.limits.comment as any).day}, {t("реакции")}: {(x.limits.react as any).used.day} {t("из")} {(x.limits.react as any).day}.
            {x.cooldown_until && new Date(x.cooldown_until) > new Date() ? ` ${t("Пауза до")} ${fmt(x.cooldown_until)}.` : ""}</p>
          <p className="small">{t("Темы")}: {(x.profile?.expertise_tags ?? []).join(", ") || "–"} · {t("Частота")}: {t(x.profile?.frequency === "biweekly" ? "раз в 2 недели" : x.profile?.frequency === "paused" ? "пауза" : "раз в неделю")}</p>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/me/participation/${x.account.id}`, { method: "PATCH", body: { pause_days: 14 } }), "Пауза на 2 недели", p.reload)}>{t("Пауза на 2 недели")}</button>
            <select aria-label={t("LinkedIn предупредил")} defaultValue="" onChange={(e) => { const k = e.target.value; if (k) run(() => api(`/api/accounts/${x.account.id}/signals`, { body: { kind: k } }), "Действия остановлены, менеджер в курсе", () => { p.reload(); s.reload(); }); e.target.value = ""; }}>
              <option value="">{t("LinkedIn предупредил…")}</option>{Object.entries(SIGNAL_RU).map(([k, l]) => <option key={k} value={k}>{t(l)}</option>)}</select>
          </div>
        </div>))}</Loadable>
    </section>
  );
}

/** Принятие приглашения: что увидит руководитель, темы, частота, согласия. */
export function InvitePage({ token, onAccepted }: { token: string; onAccepted: (userId: string) => void }) {
  const s = useApi<any>(`/api/invites/preview?token=${encodeURIComponent(token)}`);
  const { busy, run } = useAction();
  const [f, setF] = useState({ tags: "", frequency: "weekly", activity: "weekly", react: true, comment: true, ai: false, url: "" });
  return (
    <Loadable s={s}>{(d) => (
      <div className="panel form" style={{ maxWidth: 640 }}>
        <h1>{t("Приглашение")}: {d.company}</h1>
        <p>{d.display_name}{d.title ? `, ${d.title}` : ""}. {t("Ваш аккаунт LinkedIn остаётся вашим: вы сами решаете, в чём участвовать.")}</p>
        <div className="grid cols-2 small">
          <div><b>{t("Руководитель видит")}</b><ul>{d.leader_sees.map((x: string) => <li key={x}>{tx(x)}</li>)}</ul></div>
          <div><b>{t("Руководитель не видит")}</b><ul>{d.leader_does_not_see.map((x: string) => <li key={x}>{tx(x)}</li>)}</ul></div>
        </div>
        <label>{t("Ваши темы (через запятую, до 5)")}<input type="text" placeholder="kubernetes, security" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></label>
        <label>{t("Ссылка на ваш профиль LinkedIn")}<input type="url" placeholder="https://www.linkedin.com/in/…" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
        <label>{t("Как часто можно предлагать")}<select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}><option value="weekly">{t("раз в неделю")}</option><option value="biweekly">{t("раз в 2 недели")}</option></select></label>
        <label>{t("Как часто вы сами активны в LinkedIn")}<select value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value })}><option value="rare">{t("редко")}</option><option value="weekly">{t("раз в неделю")}</option><option value="daily">{t("каждый день")}</option></select></label>
        <fieldset><legend>{t("Согласия (можно отозвать в любой момент)")}</legend>
          <label className="row"><input type="checkbox" checked={f.react} onChange={(e) => setF({ ...f, react: e.target.checked })} /> {t("Предлагать реакции на посты компании")}</label>
          <label className="row"><input type="checkbox" checked={f.comment} onChange={(e) => setF({ ...f, comment: e.target.checked })} /> {t("Предлагать комментарии (каждый текст я одобряю сам)")}</label>
          <label className="row"><input type="checkbox" checked={f.ai} onChange={(e) => setF({ ...f, ai: e.target.checked })} /> {t("Готовить черновики с помощью AI по моим подтверждённым фактам")}</label>
        </fieldset>
        <button className="btn primary" disabled={busy || !f.tags.trim()} onClick={() => run(async () => {
          const r = await api("/api/invites/accept", { body: { token, expertise_tags: f.tags.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 5), frequency: f.frequency, self_reported_activity: f.activity, consents: { react: f.react, comment: f.comment, ai_processing: f.ai }, linkedin_profile_url: f.url || undefined } });
          onAccepted(r.user_id); return r;
        }, "Готово: вы в команде")}>{t("Принять приглашение")}</button>
      </div>)}</Loadable>
  );
}
