import { useState } from "react";
import { api, useApi, useAction, Loadable, fmt, t, num, uploadFile, useMe, EV_RU } from "../lib";
import { tx } from "../i18n";
import { MonthGrid, CalendarLegend } from "./calendar";
import { EngagementQueue, EngagementForm } from "./engagement";
import { intlLocale } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/* ---------- онбординг и аудит профиля ---------- */
export function Onboarding({ d, reload }: { d: any; reload: () => void }) {
  const s = useApi<any>(`/api/accounts/${d.account.id}/onboarding`);
  const meta = useApi<any>("/api/meta");
  const audits = useApi<any[]>(`/api/accounts/${d.account.id}/profile-audits`);
  const { busy, run } = useAction();
  const [crit, setCrit] = useState<Record<string, { status: string; finding: string; proposed_text: string }>>({});
  const can = (op: string) => d.permissions.includes(op);
  return (
    <div className="grid cols-2" style={{ marginTop: 14 }}>
      <div className="panel">
        <Loadable s={s}>{(o) => (<>
          <div className="spread"><h3>{t("Подключение клиента")}</h3><span className="small num">{o.done} / {o.total}</span></div>
          <div className="bar" aria-hidden><i style={{ width: `${(o.done / o.total) * 100}%` }} /></div>
          <ol className="steps">{o.steps.map((st: any) => (
            <li key={st.key} className={st.status}><span>{t(st.label)}</span>{st.note && <span className="small muted"> · {tx(st.note)}</span>}</li>))}</ol>
        </>)}</Loadable>
      </div>
      {d.account.kind !== "company_page" && <div className="panel grid">
        <h3>{t("Аудит профиля")}</h3>
        <p className="small muted">{t("API изменения профиля нет: по каждому пункту «улучшить» или «нет» создаётся задача владельцу с готовым текстом.")}</p>
        {audits.data?.[0] && <p className="small">{t("Последний аудит")}: {fmt(audits.data[0].created_at)}, {t("задач")}: {audits.data[0].tasks_created}</p>}
        {can("edit_strategy") && <>
          {meta.data?.audit_criteria.map((c: any) => {
            const v = crit[c.key] ?? { status: "ok", finding: "", proposed_text: "" };
            return (
              <details key={c.key} className="audit-row">
                <summary><b>{t(c.label)}</b> <select value={v.status} onClick={(e) => e.stopPropagation()} onChange={(e) => setCrit({ ...crit, [c.key]: { ...v, status: e.target.value } })}><option value="ok">{t("в порядке")}</option><option value="improve">{t("улучшить")}</option><option value="missing">{t("нет")}</option></select></summary>
                {v.status !== "ok" && <div className="grid" style={{ marginTop: 6 }}>
                  <input type="text" placeholder={t("Что не так")} value={v.finding} onChange={(e) => setCrit({ ...crit, [c.key]: { ...v, finding: e.target.value } })} />
                  <textarea style={{ minHeight: 60 }} placeholder={t("Предлагаемый текст для владельца")} value={v.proposed_text} onChange={(e) => setCrit({ ...crit, [c.key]: { ...v, proposed_text: e.target.value } })} />
                </div>}
              </details>);
          })}
          <button className="btn primary" disabled={busy || !meta.data} onClick={() => run(() => api(`/api/accounts/${d.account.id}/profile-audits`, { body: { criteria: meta.data.audit_criteria.map((c: any) => ({ key: c.key, ...(crit[c.key] ?? { status: "ok", finding: "", proposed_text: "" }) })) } }), "Аудит сохранён, задачи созданы", () => { setCrit({}); audits.reload(); s.reload(); reload(); })}>{t("Сохранить аудит")}</button>
        </>}
      </div>}
    </div>
  );
}

/* ---------- улучшение стратегии ---------- */
export function Insights({ d }: { d: any }) {
  const s = useApi<any>(`/api/accounts/${d.account.id}/insights`);
  const { busy, run } = useAction();
  const [concl, setConcl] = useState<Record<string, { status: string; text: string }>>({});
  const can = (op: string) => d.permissions.includes(op);
  return (
    <div style={{ marginTop: 18 }}>
      <div className="spread"><h2 style={{ margin: 0 }}>{t("Рекомендации и эксперименты")}</h2>
        {can("edit_strategy") && <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/accounts/${d.account.id}/insights/run`, { body: {} }), "Анализ выполнен", s.reload)}>{t("Запустить анализ сейчас")}</button>}</div>
      <p className="small muted">{t("Анализ раз в неделю по сопоставимым публикациям старше 7 дней. Не больше трёх изменений, малые выборки не используются. Для органических публикаций это последовательный эксперимент, а не A/B-тест. Стратегия не меняется по одному посту.")}</p>
      <Loadable s={s}>{(x) => (<>
        {x.recommendations.length === 0 ? <div className="empty">{t("Рекомендаций пока нет: нужно не меньше 5 сопоставимых публикаций с показателями в группе.")}</div> :
          <div className="list">{x.recommendations.map((r: any) => (
            <div key={r.id} className="item">
              <div className="spread"><b>{r.proposed_change}</b><span className={`state ${r.status === "accepted" ? "approved" : r.status === "rejected" ? "cancelled" : "editorial_review"}`}>{r.status === "proposed" ? t("на рассмотрении") : r.status === "accepted" ? t("принята") : t("отклонена")}</span></div>
              <dl className="kv small">
                <dt>{t("Наблюдение")}</dt><dd>{r.observation}</dd>
                <dt>{t("Гипотеза")}</dt><dd>{r.hypothesis}</dd>
                <dt>{t("Ожидаемый сигнал")}</dt><dd>{r.expected_signal}</dd>
                <dt>{t("Пересмотр")}</dt><dd>{String(r.review_at).slice(0, 10)}</dd>
                <dt>{t("Ограничения")}</dt><dd>{r.limitations.map(tx).join("; ")}</dd>
              </dl>
              {r.status === "proposed" && can("approve_strategy") && <div className="row" style={{ marginTop: 6 }}>
                <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/strategy-recommendations/${r.id}/decision`, { body: { decision: "accepted" } }), "Рекомендация принята, эксперимент начат", s.reload)}>{t("Принять и начать эксперимент")}</button>
                <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/strategy-recommendations/${r.id}/decision`, { body: { decision: "rejected" } }), "Рекомендация отклонена", s.reload)}>{t("Отклонить")}</button>
              </div>}
            </div>))}</div>}
        {x.experiments.length > 0 && <>
          <h3 style={{ marginTop: 14 }}>{t("Последовательные эксперименты")}</h3>
          <table><thead><tr><th>{t("Изменение")}</th><th>{t("Сигнал")}</th><th>{t("Период")}</th><th>{t("Статус")}</th><th /></tr></thead><tbody>
            {x.experiments.map((e: any) => (
              <tr key={e.id}><td>{e.change}<div className="small muted">{e.hypothesis}</div></td><td className="small">{e.expected_signal}</td><td className="num small">{String(e.start_date).slice(0, 10)} – {String(e.review_date).slice(0, 10)}</td><td>{e.status}{e.conclusion ? <div className="small">{e.conclusion}</div> : null}</td>
                <td>{e.status === "running" && can("edit_strategy") && <div className="grid">
                  <select value={concl[e.id]?.status ?? "inconclusive"} onChange={(ev) => setConcl({ ...concl, [e.id]: { ...(concl[e.id] ?? { text: "" }), status: ev.target.value } })}><option value="supported">{t("гипотеза подтвердилась")}</option><option value="not_supported">{t("не подтвердилась")}</option><option value="inconclusive">{t("данных недостаточно")}</option><option value="stopped">{t("остановлен")}</option></select>
                  <input type="text" placeholder={t("Вывод")} value={concl[e.id]?.text ?? ""} onChange={(ev) => setConcl({ ...concl, [e.id]: { ...(concl[e.id] ?? { status: "inconclusive" }), text: ev.target.value } })} />
                  <button className="btn small" disabled={busy || (concl[e.id]?.text ?? "").length < 5} onClick={() => run(() => api(`/api/experiments/${e.id}/conclude`, { body: { status: concl[e.id]?.status ?? "inconclusive", conclusion: concl[e.id]?.text } }), "Эксперимент завершён", s.reload)}>{t("Завершить")}</button>
                </div>}</td></tr>))}
          </tbody></table></>}
      </>)}</Loadable>
    </div>
  );
}

/* ---------- календарь аккаунта и план месяца ---------- */
export function AccCalendar({ d, reload }: { d: any; reload: () => void }) {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [planMonthV, setPlanMonth] = useState(`${next.getFullYear()}-${pad(next.getMonth() + 1)}`);
  const [events, setEvents] = useState("");
  const [plan, setPlan] = useState<any | null>(null);
  const [y, m] = month.split("-").map(Number);
  const cal = useApi<any[]>(`/api/calendar?account_id=${d.account.id}&from=${month}-01&to=${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}`);
  const stats = useApi<any>(`/api/accounts/${d.account.id}/window-stats`);
  const { busy, run } = useAction();
  const shift = (k: number) => { const x = new Date(Date.UTC(y, m - 1 + k, 1)); setMonth(`${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`); };
  const parsedEvents = events.split("\n").map((l) => /^(\d{4}-\d{2}-\d{2})\s+(.+)$/.exec(l.trim())).filter(Boolean).map((x) => ({ date: x![1], title: x![2] }));
  const body = (dry: boolean) => ({ month: planMonthV, events: parsedEvents, dry_run: dry });
  return (
    <div className="grid cols-2-1">
      <div>
        <div className="row" style={{ marginBottom: 10 }}>
          <button className="btn" onClick={() => shift(-1)} aria-label={t("Предыдущий месяц")}>‹</button>
          <b style={{ minWidth: 150, textAlign: "center" }}>{new Intl.DateTimeFormat(intlLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)))}</b>
          <button className="btn" onClick={() => shift(1)} aria-label={t("Следующий месяц")}>›</button>
          <span className="small muted">{t("Время в поясе аккаунта")}: {d.account.timezone}</span>
        </div>
        <CalendarLegend />
        <Loadable s={cal}>{(items) => <MonthGrid items={items} month={month} />}</Loadable>
      </div>
      <div className="grid" style={{ alignContent: "start" }}>
        {d.permissions.includes("create_content") && <div className="panel grid">
          <h3>{t("План месяца")}</h3>
          <p className="small muted">{t("Сначала обязательные события, затем направления по долям стратегии, разнообразие форматов, запас на согласование и окна публикации. Время: согласованная с клиентом гипотеза.")}</p>
          <label className="field">{t("Месяц")}<input type="month" value={planMonthV} onChange={(e) => setPlanMonth(e.target.value)} /></label>
          <label className="field">{t("Обязательные события: строка «ГГГГ-ММ-ДД Название»")}<textarea style={{ minHeight: 60 }} value={events} onChange={(e) => setEvents(e.target.value)} placeholder="2026-11-12 Выступление на конференции" /></label>
          <div className="row">
            <button className="btn" disabled={busy} onClick={() => run(async () => setPlan(await api(`/api/accounts/${d.account.id}/plan-month`, { body: body(true) })), "Предпросмотр плана готов")}>{t("Показать план")}</button>
            <button className="btn primary" disabled={busy || !plan || plan.slots.length === 0} onClick={() => run(async () => { await api(`/api/accounts/${d.account.id}/plan-month`, { body: body(false) }); setPlan(null); cal.reload(); reload(); }, "Идеи созданы в календаре")}>{t("Создать идеи по плану")}</button>
          </div>
          {plan && <div className="small">
            {plan.notes.map((n: string) => <p key={n} className="muted">{tx(n)}</p>)}
            <ul className="plain">{plan.slots.map((s: any) => <li key={s.local}><span className="num">{s.local.replace("T", " ")}</span> · {s.campaign ?? s.pillar} · {s.format}</li>)}</ul>
          </div>}
        </div>}
        <div className="panel">
          <h3>{t("Сравнение временных окон")}</h3>
          <Loadable s={stats}>{(w) => (<>
            <p className="small muted">{tx(w.note)}</p>
            {w.windows.length === 0 ? <p className="small muted">{t("Публикаций с показами старше 7 дней пока нет.")}</p> :
              <table className="small"><thead><tr><th>{t("Окно")}</th><th>n</th><th>{t("Медиана показов")}</th></tr></thead><tbody>{w.windows.map((x: any) => <tr key={x.window}><td>{x.window}</td><td className="num">{x.n}</td><td className="num">{num(x.median_impressions)}{x.small_sample ? <span className="muted"> ({t("малая выборка")})</span> : null}</td></tr>)}</tbody></table>}
          </>)}</Loadable>
        </div>
      </div>
    </div>
  );
}

/* ---------- взаимодействия аккаунта ---------- */
export function AccEngagement({ d }: { d: any }) {
  const [k, setK] = useState(0);
  const sources = useApi<any[]>(`/api/accounts/${d.account.id}/engagement-sources`);
  const { busy, run } = useAction();
  const [src, setSrc] = useState({ label: "", url: "", approved_by_name: "" });
  return (
    <div className="grid cols-2-1">
      <EngagementQueue accountId={d.account.id} reloadKey={k} />
      <div className="grid" style={{ alignContent: "start" }}>
        {d.permissions.includes("record_manual_action") && <EngagementForm accountId={d.account.id} onCreated={() => setK(k + 1)} />}
        <div className="panel grid">
          <h3>{t("Утверждённые клиентом источники")}</h3>
          {(sources.data ?? []).length === 0 ? <p className="small muted">{t("Список пуст.")}</p> : <ul className="plain small">{sources.data!.map((x) => <li key={x.id}><a href={x.url} target="_blank" rel="noreferrer">{x.label}</a> <span className="muted">· {t("утвердил")} {x.approved_by_name}</span></li>)}</ul>}
          {d.permissions.includes("edit_strategy") && <>
            <input type="text" placeholder={t("Название")} value={src.label} onChange={(e) => setSrc({ ...src, label: e.target.value })} />
            <input type="url" placeholder="https://www.linkedin.com/…" value={src.url} onChange={(e) => setSrc({ ...src, url: e.target.value })} />
            <input type="text" placeholder={t("Кто утвердил")} value={src.approved_by_name} onChange={(e) => setSrc({ ...src, approved_by_name: e.target.value })} />
            <button className="btn" disabled={busy || !src.label || !src.url || !src.approved_by_name} onClick={() => run(() => api(`/api/accounts/${d.account.id}/engagement-sources`, { body: src }), "Источник добавлен", () => { setSrc({ label: "", url: "", approved_by_name: "" }); sources.reload(); })}>{t("Добавить источник")}</button>
          </>}
        </div>
      </div>
    </div>
  );
}

/* ---------- результаты и возможности ---------- */
const ATTR_RU: Record<string, string> = { confirmed_click: "подтверждённый переход", client_mark: "отметка клиента", crm_event: "событие CRM", manager_assumption: "предположение менеджера" };
export function AccOpportunities({ d }: { d: any }) {
  const meta = useApi<any>("/api/meta");
  const s = useApi<any[]>(`/api/accounts/${d.account.id}/opportunities`);
  const { busy, run } = useAction();
  const pipeline = d.account.kind === "job_seeker" ? "job_search" : "business";
  const [f, setF] = useState({ title: "", stage: "", attribution: "client_mark" });
  if (!meta.data) return null;
  const stages: string[] = meta.data.pipelines[pipeline];
  return (
    <>
      <p className="small muted">{t("Источники: ручной ввод уполномоченным сотрудником, формы клиента, разрешённая CRM. Авторы реакций и комментариев автоматически в базу лидов не превращаются. У каждого результата указан способ атрибуции.")}</p>
      <Loadable s={s}>{(rows) => (
        <div className="kanban">{stages.map((st) => (
          <div key={st} className="kan-col">
            <h3>{t(meta.data.stages[st])} <span className="muted num">{rows.filter((r) => r.stage === st).length}</span></h3>
            {rows.filter((r) => r.stage === st).map((r) => (
              <div key={r.id} className="item small">
                <b>{r.title}</b>
                <div className="muted">{t(ATTR_RU[r.attribution])} · {fmt(r.updated_at)}</div>
                {d.permissions.includes("enter_metrics") && <select value={r.stage} disabled={busy} onChange={(e) => run(() => api(`/api/opportunities/${r.id}/move`, { body: { stage: e.target.value } }), "Этап изменён", s.reload)}>{stages.map((x) => <option key={x} value={x}>{t(meta.data.stages[x])}</option>)}</select>}
              </div>))}
          </div>))}</div>)}</Loadable>
      {d.permissions.includes("enter_metrics") && <div className="panel row" style={{ marginTop: 12 }}>
        <input type="text" placeholder={t("Что произошло")} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} style={{ minWidth: 260 }} />
        <select value={f.stage || stages[0]} onChange={(e) => setF({ ...f, stage: e.target.value })}>{stages.map((x) => <option key={x} value={x}>{t(meta.data.stages[x])}</option>)}</select>
        <select value={f.attribution} onChange={(e) => setF({ ...f, attribution: e.target.value })}>{Object.entries(ATTR_RU).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</select>
        <button className="btn primary" disabled={busy || !f.title} onClick={() => run(() => api(`/api/accounts/${d.account.id}/opportunities`, { body: { pipeline, stage: f.stage || stages[0], title: f.title, attribution: f.attribution } }), "Результат добавлен", () => { setF({ ...f, title: "" }); s.reload(); })}>{t("Добавить результат")}</button>
      </div>}
    </>
  );
}

/* ---------- медиатека ---------- */
export function MediaLibrary({ accountId, selectable, selected, onToggle }: { accountId: string; selectable?: boolean; selected?: string[]; onToggle?: (id: string) => void }) {
  const s = useApi<any[]>(`/api/accounts/${accountId}/media`);
  const { busy, run } = useAction();
  const [urls, setUrls] = useState<Record<string, string>>({});
  return (
    <div className="panel grid">
      <div className="spread"><h3>{t("Медиа")}</h3>
        <label className="btn small">{t("Загрузить файл")}<input type="file" hidden accept="image/png,image/jpeg,image/gif,application/pdf,video/mp4" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) run(() => uploadFile(`/api/accounts/${accountId}/media`, f), "Файл загружен и проверен", s.reload); e.target.value = ""; }} /></label></div>
      <p className="small muted">{t("Тип определяется по содержимому, файл проверяется антивирусом. Через API публикуются изображения JPG, PNG, GIF; видео и PDF публикуются через человека.")}</p>
      <Loadable s={s}>{(rows) => rows.length === 0 ? <p className="small muted">{t("Файлов нет.")}</p> : (
        <ul className="plain media-list">{rows.map((m) => (
          <li key={m.id} className="row">
            {selectable && <input type="checkbox" checked={selected?.includes(m.id) ?? false} onChange={() => onToggle?.(m.id)} aria-label={m.original_name} />}
            {urls[m.id] && m.mime_type.startsWith("image/") ? <img src={urls[m.id]} alt={m.original_name} className="thumb" /> : <span className="file-kind">{m.mime_type.split("/")[1]}</span>}
            <span className="small">{m.original_name}<span className="muted"> · {num(m.bytes / 1024)} KB{m.width ? ` · ${m.width}×${m.height}` : ""}</span></span>
            {!urls[m.id] && <button className="btn link small" onClick={async () => { const r = await api(`/api/media/${m.id}/url`); setUrls({ ...urls, [m.id]: r.url }); }}>{t("Открыть")}</button>}
            {urls[m.id] && !m.mime_type.startsWith("image/") && <a className="small" href={urls[m.id]} target="_blank" rel="noreferrer">{t("Скачать")}</a>}
          </li>))}</ul>)}</Loadable>
    </div>
  );
}

/* ---------- жизненный цикл клиента ---------- */
export function ClientLifecycle({ d }: { d: any }) {
  const me = useMe();
  const { busy, run } = useAction();
  const [confirm, setConfirm] = useState("");
  const isOwner = me?.roles.includes("owner");
  if (!d.permissions.includes("manage_clients")) return null;
  return (
    <div className="panel grid danger-zone">
      <h3>{t("Завершение обслуживания клиента")}</h3>
      <p className="small">{t("Шаг 1: публикация останавливается, подключения и согласия отзываются, токены удаляются. Шаг 2 (только владелец): удаление всех данных клиента из базы, файлового хранилища и секретов с проверкой остатков. Резервные копии очищаются по циклу ротации.")}</p>
      <div className="row">
        <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/clients/${d.account.client_id}/offboarding`, { body: {} }), "Завершение обслуживания начато")}>{t("Начать завершение обслуживания")}</button>
      </div>
      {isOwner && <div className="row">
        <input type="text" placeholder={`${t("Введите название клиента")}: ${d.account.client_name}`} value={confirm} onChange={(e) => setConfirm(e.target.value)} style={{ minWidth: 280 }} />
        <button className="btn danger" disabled={busy || confirm !== d.account.client_name} onClick={() => run(() => api(`/api/clients/${d.account.client_id}/delete-data`, { body: { confirm_name: confirm } }), "Данные клиента удалены", () => { location.hash = "/accounts"; })}>{t("Удалить все данные клиента")}</button>
      </div>}
    </div>
  );
}

/* ---------- отчёты: месячный, публикация клиенту, AI-резюме ---------- */
export function ReportActions({ d, reload }: { d: any; reload: () => void }) {
  const { busy, run } = useAction();
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  if (!d.permissions.includes("export")) return null;
  return (
    <div className="row" style={{ marginTop: 10 }}>
      <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label={t("Месяц")} />
      <button className="btn" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/accounts/${d.account.id}/reports/monthly`, { body: { month } }); location.hash = `/reports/${r.id}`; }, "Месячный отчёт сформирован", reload)}>{t("Сформировать отчёт за месяц")}</button>
    </div>
  );
}
void EV_RU;
