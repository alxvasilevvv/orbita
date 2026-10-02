import { useMemo, useState } from "react";
import { useApi, Loadable, fmtTime, t, State } from "../lib";
import { intlLocale } from "../i18n";

const pad = (n: number) => String(n).padStart(2, "0");

/** Месячная сетка. Даты показываются в часовом поясе зрителя, время у материала: в поясе аккаунта. */
export function MonthGrid({ items, month }: { items: any[]; month: string }) {
  const [y, m] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (first.getUTCDay() + 6) % 7;
  const byDay = useMemo(() => {
    const map = new Map<number, any[]>();
    for (const it of items) {
      const d = new Date(it.at);
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1) continue;
      const key = Number(new Intl.DateTimeFormat("en-GB", { day: "numeric", timeZone: it.timezone }).format(d));
      map.set(key, [...(map.get(key) ?? []), it]);
    }
    return map;
  }, [items, month]);
  const weekdays = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(intlLocale(), { weekday: "short" }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const cells = Array.from({ length: offset + days }, (_, i) => (i < offset ? null : i - offset + 1));
  const today = new Date();
  return (
    <div className="cal" role="grid" aria-label={t("Календарь")}>
      {weekdays.map((w) => <div key={w} className="cal-h" role="columnheader">{w}</div>)}
      {cells.map((d, i) => d == null ? <div key={`e${i}`} className="cal-c empty" /> : (
        <div key={d} className={`cal-c ${today.getFullYear() === y && today.getMonth() === m - 1 && today.getDate() === d ? "today" : ""}`} role="gridcell">
          <div className="cal-d num">{d}</div>
          {(byDay.get(d) ?? []).slice(0, 6).map((it) => (
            <a key={it.id} href={`#/content/${it.id}`} className={`cal-i ${it.kind} ${it.evidence_type ?? ""}`} title={`${it.account_name}: ${it.title}`}>
              <span className="num">{fmtTime(it.at, it.timezone)}</span> {it.account_name ? <b>{it.account_name.split(" ")[0]}</b> : null} {it.title}
            </a>))}
          {(byDay.get(d)?.length ?? 0) > 6 && <div className="muted small">+{byDay.get(d)!.length - 6}</div>}
        </div>))}
    </div>
  );
}

export function CalendarLegend() {
  return (
    <div className="row small legend">
      <span className="cal-i planned">{t("План")}</span>
      <span className="cal-i scheduled">{t("Запланировано")}</span>
      <span className="cal-i published api_confirmed">{t("Опубликовано, подтверждено API")}</span>
      <span className="cal-i published manual_mark">{t("Опубликовано, ручная отметка")}</span>
    </div>
  );
}

export function CalendarPage() {
  const now = new Date();
  const [month, setMonth] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}`);
  const [mine, setMine] = useState(true);
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`, to = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const s = useApi<any[]>(`/api/calendar?from=${from}&to=${to}${mine ? "&mine=1" : ""}`);
  const shift = (k: number) => { const d = new Date(Date.UTC(y, m - 1 + k, 1)); setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`); };
  const label = new Intl.DateTimeFormat(intlLocale(), { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
  return (
    <>
      <h1>{t("Календарь")}</h1>
      <p className="lede">{t("Планы, запланированные и опубликованные материалы. Время каждого материала показано в часовом поясе его аккаунта.")}</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => shift(-1)} aria-label={t("Предыдущий месяц")}>‹</button>
        <b style={{ minWidth: 160, textAlign: "center" }}>{label}</b>
        <button className="btn" onClick={() => shift(1)} aria-label={t("Следующий месяц")}>›</button>
        <label className="row small"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> {t("Только мои аккаунты")}</label>
      </div>
      <CalendarLegend />
      <Loadable s={s}>{(items) => items.length === 0
        ? <div className="empty">{mine ? t("В этом месяце у ваших аккаунтов нет материалов. Снимите фильтр «Только мои аккаунты» или постройте план месяца в аккаунте.") : t("В этом месяце нет материалов.")}</div>
        : <MonthGrid items={items} month={month} />}</Loadable>
      <ListUnder items={s.data ?? []} />
    </>
  );
}

function ListUnder({ items }: { items: any[] }) {
  const problems = items.filter((i) => ["failed", "publication_unknown"].includes(i.state));
  if (!problems.length) return null;
  return (
    <div className="notice error" style={{ marginTop: 14 }}>
      <b>{t("Требуют разбора")}:</b>
      <ul style={{ margin: "4px 0 0" }}>{problems.map((p) => <li key={p.id}><a href={`#/content/${p.id}`}>{p.account_name}: {p.title}</a> <State s={p.state} /></li>)}</ul>
    </div>
  );
}
