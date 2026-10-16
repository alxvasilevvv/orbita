import { useEffect, useState } from "react";
import { api, fmt, go, Loadable, money, num, t, uploadFile, useAction, useApi, useRoute } from "../lib";

/**
 * Кабинет сотрудника: онбординг-мастер (компания → должность и фото → LinkedIn → интервью → паспорт голоса →
 * стратегия и автопилот → оплата → готово) и рабочий экран личного агента. Кабинет руководителя: вкладка «Автопилот».
 */
const STATUS_RU: Record<string, string> = { planned: "запланирован", needs_owner: "нужна ваша правка", review: "проверяет компания", veto_window: "выйдет автоматически", scheduled: "публикуется", published: "опубликован", vetoed: "отменён вами", blocked: "остановлен", expired: "истёк", failed: "ошибка" };
const STEPS = ["Компания", "Должность и фото", "LinkedIn", "Интервью", "Паспорт голоса", "Стратегия", "Оплата"];
const STAGE_RU: Record<string, string> = { profile: "Оформление профиля", first_posts: "Первые посты", rhythm: "Набор ритма", steady: "Штатный ритм" };

export function MediaImg({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const s = useApi<{ url: string }>(`/api/media/${id}/url`, [id]);
  return s.data ? <img src={s.data.url} alt={alt} className={className} /> : <div className={`img-ph ${className ?? ""}`} aria-label={alt} />;
}

function AddX({ reload, onAdded }: { reload: () => void; onAdded: () => void }) {
  const { busy, run } = useAction();
  return <button className="btn ghost small add-x" disabled={busy} onClick={() => run(async () => { await api("/api/me/agent/add-network", { body: { network: "x" } }); }, "Аккаунт X добавлен", onAdded)}>
    <span className="net-badge x" style={{ width: 16, height: 16, fontSize: 9 }}>X</span> {t("Добавить аккаунт X")}
  </button>;
}

function Stepper({ step }: { step: number }) {
  return (
    <ol className="stepper" aria-label={t("Шаги подключения")}>
      {STEPS.map((s, i) => <li key={s} className={i < step ? "done" : i === step ? "on" : ""} aria-current={i === step ? "step" : undefined}><span className="num">{i < step ? "✓" : i + 1}</span>{t(s)}</li>)}
    </ol>
  );
}

export function MyAgentPage() {
  const s = useApi<any>("/api/me/agent");
  const [local, setLocal] = useState<number | null>(null);
  const [acc, setAcc] = useState(0);
  return (
    <Loadable s={s}>{(d) => {
      const x = d.accounts[Math.min(acc, d.accounts.length - 1)] ?? d.accounts[0];
      if (!x) return <div className="notice info">{t("Личный агент работает для личных аккаунтов сотрудников.")}</div>;
      const hasX = d.accounts.some((a: any) => a.network === "x");
      const switcher = (d.accounts.length > 1 || !hasX) ? (
        <div className="net-switch">
          <div className="tabs" role="tablist">{d.accounts.map((a: any, i: number) => (
            <button key={a.account.id} role="tab" aria-selected={i === acc} className={i === acc ? "on" : ""} onClick={() => setAcc(i)}>
              <span className={`net-badge ${a.network === "x" ? "x" : "li"}`} style={{ width: 18, height: 18, fontSize: 10 }}>{a.network === "x" ? "X" : "in"}</span> {a.account.display_name}
            </button>))}</div>
          {!hasX && <AddX reload={s.reload} onAdded={() => { setAcc(d.accounts.length); s.reload(); }} />}
        </div>) : null;
      const server: Record<string, number> = { role: 1, interview: x.linkedin.connected ? 3 : 2, passport: 4, photos: 5, autopilot: 5, payment: 6, done: 7 };
      const step = local ?? server[x.agent.onboarding_step] ?? 0;
      if (x.agent.onboarding_step === "done" && local == null) return <>{switcher}<AgentHome x={x} cat={d.catalog} reload={s.reload} /></>;
      const next = (n?: number) => { setLocal(n ?? null); s.reload(); };
      return (
        <div className="onboard">
          <h1>{t("Ваш личный агент LinkedIn")}</h1>
          <p className="lede">{t("Десять минут один раз. Дальше агент ведёт ваш профиль сам: пишет посты в вашем стиле, присылает их заранее и публикует через официальный API LinkedIn.")}</p>
          <Stepper step={Math.min(step, 6)} />
          <div className="panel step-body">
            {step === 0 && <StepCompany x={x} next={() => next(1)} />}
            {step === 1 && <StepRole x={x} cat={d.catalog} next={() => next(x.linkedin.connected ? 3 : 2)} />}
            {step === 2 && <StepConnect x={x} next={() => next(3)} />}
            {step === 3 && <StepInterview x={x} cat={d.catalog} next={() => next(4)} />}
            {step === 4 && <StepPassport x={x} next={() => next(5)} />}
            {step === 5 && <StepStrategy x={x} cat={d.catalog} next={() => next(6)} />}
            {step === 6 && <StepPayment x={x} cat={d.catalog} next={() => { setLocal(null); s.reload(); }} />}
            {step >= 7 && <Architecture x={x} />}
          </div>
          {step > 0 && step < 7 && <button className="btn ghost small" onClick={() => setLocal(step - 1)}>{t("← Назад")}</button>}
        </div>);
    }}</Loadable>
  );
}

function StepCompany({ x, next }: { x: any; next: () => void }) {
  return (<>
    <h2>{t("Вы в команде")} {x.account.company}</h2>
    <p>{t("Ваш аккаунт LinkedIn остаётся вашим. Компания задаёт темы и стратегию, агент работает только в их рамках и только по вашему согласию.")}</p>
    <div className="grid cols-3">
      <div className="mini"><b>1</b><span>{t("Вы рассказываете о своей работе и подтверждаете паспорт голоса")}</span></div>
      <div className="mini"><b>2</b><span>{t("Агент готовит посты и присылает их заранее: можно отменить или поправить")}</span></div>
      <div className="mini"><b>3</b><span>{t("Посты выходят сами, комментарии и сообщения вы подтверждаете одним касанием")}</span></div>
    </div>
    <div className="actions"><button className="btn primary" onClick={next}>{t("Начать")}</button></div>
  </>);
}

function StepRole({ x, cat, next }: { x: any; cat: any; next: () => void }) {
  const { busy, run } = useAction();
  const [role, setRole] = useState<string>(x.agent.role_key ?? "");
  const [title, setTitle] = useState<string>(x.agent.title ?? "");
  const [consent, setConsent] = useState(x.consents.includes("likeness_processing"));
  const [photos, setPhotos] = useState<number>(x.portrait?.status === "collecting" ? x.portrait.sources : 0);
  const upload = async (files: FileList | null) => {
    if (!files) return;
    if (!x.consents.includes("likeness_processing")) await api(`/api/me/agent/${x.account.id}/likeness`, { method: "POST" });
    let n = photos;
    for (const f of Array.from(files).slice(0, 10)) { const r = await uploadFile(`/api/me/agent/${x.account.id}/photos`, f); n = r.photos; }
    setPhotos(n);
  };
  return (<>
    <h2>{t("Должность и фото")}</h2>
    <p className="muted">{t("Роль определяет темы и вопросы интервью. Фото нужны для профессионального портрета и обложки профиля.")}</p>
    <div className="role-grid" role="radiogroup" aria-label={t("Роль")}>
      {cat.roles.map((r: any) => <button key={r.key} role="radio" aria-checked={role === r.key} className={`role ${role === r.key ? "on" : ""}`} onClick={() => setRole(r.key)}><b>{t(r.label)}</b><span className="small muted">{r.topics.join(" · ")}</span></button>)}
    </div>
    <label className="form-row">{t("Должность, как в LinkedIn")}<input type="text" value={title} placeholder="Senior Backend Engineer" onChange={(e) => setTitle(e.target.value)} /></label>
    <fieldset className="photos">
      <legend>{t("Ваши фотографии (3–10, лицо хорошо видно)")}</legend>
      <label className="row"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> {t("Разрешаю обработать мои фото, чтобы сделать мой портрет. Исходники удаляются сразу после генерации.")}</label>
      <input type="file" accept="image/jpeg,image/png" multiple disabled={!consent || busy} onChange={(e) => run(() => upload(e.target.files), "Фото загружены")} />
      <p className="small muted">{t("Загружено")}: <b className="num">{photos}</b>{photos >= 3 ? ` · ${t("портреты будут готовы через пару минут")}` : ""}</p>
    </fieldset>
    <div className="actions">
      <button className="btn primary" disabled={busy || !role} onClick={() => run(async () => {
        await api(`/api/me/agent/${x.account.id}/role`, { body: { role_key: role, title: title || undefined } });
        if (photos >= 3) await api(`/api/me/agent/${x.account.id}/portraits`, { body: { style: "office" } }).catch(() => null);
      }, "Сохранено", next)}>{t("Дальше")}</button>
    </div>
  </>);
}

function StepConnect({ x, next }: { x: any; next: () => void }) {
  const { busy, run } = useAction();
  return (<>
    <h2>{t("Подключите LinkedIn")}</h2>
    <p>{t("Официальный вход LinkedIn: платформа не видит ваш пароль и получает только право публиковать от вашего имени. Отключить можно в любой момент в настройках LinkedIn.")}</p>
    {x.linkedin.connected ? <div className="notice info">{t("Профиль подключён")}</div> : (
      <div className="actions">
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await api(`/api/accounts/${x.account.id}/oauth/start`); location.href = r.authorize_url; }, "Переходим в LinkedIn")}>{t("Войти через LinkedIn")}</button>
        <button className="btn ghost" onClick={next}>{t("Подключу позже")}</button>
      </div>)}
    {x.linkedin.connected && <div className="actions"><button className="btn primary" onClick={next}>{t("Дальше")}</button></div>}
  </>);
}

function StepInterview({ x, cat, next }: { x: any; cat: any; next: () => void }) {
  const { busy, run } = useAction();
  const role = cat.roles.find((r: any) => r.key === x.agent.role_key);
  const prev = x.agent.interview ?? {};
  const [a, setA] = useState<Record<string, string>>({ now: prev.now ?? "", win: prev.win ?? "", lesson: prev.lesson ?? "", stack: prev.stack ?? "", extra: prev.extra ?? "" });
  const pool = [...new Set([...(role?.topics ?? []), ...x.brief_topics])] as string[];
  const [topics, setTopics] = useState<string[]>(x.agent.passport?.topics ?? (role?.topics ?? []).slice(0, 3));
  const [o, setO] = useState({ language: x.agent.passport?.language ?? "en", length: x.agent.passport?.tone?.length ?? "medium", register: x.agent.passport?.tone?.register ?? "conversational", never: (x.agent.passport?.never_topics ?? []).join(", ") });
  const toggle = (tg: string) => setTopics(topics.includes(tg) ? topics.filter((z) => z !== tg) : topics.length < 5 ? [...topics, tg] : topics);
  return (<>
    <h2>{t("Интервью для агента")}</h2>
    <p className="muted">{t("Агент пишет только из того, что вы расскажете. Конкретика лучше общих слов: что сделали, какой результат, чему научились.")}</p>
    {cat.interview.map((q: any) => (
      <label key={q.key} className="form-row">{q.key === "extra" ? t(role?.extra ?? q.q) : t(q.q)}
        <textarea rows={3} value={a[q.key]} onChange={(e) => setA({ ...a, [q.key]: e.target.value })} /></label>))}
    <div className="form-row"><span>{t("Темы (до 5)")}</span>
      <div className="chips">{pool.map((tg) => <button key={tg} className={`chip-btn ${topics.includes(tg) ? "on" : ""}`} aria-pressed={topics.includes(tg)} onClick={() => toggle(tg)}>{tg}</button>)}</div></div>
    <div className="grid cols-3">
      <label className="form-row">{t("Язык постов")}<select value={o.language} onChange={(e) => setO({ ...o, language: e.target.value })}><option value="en">English</option><option value="ru">Русский</option></select></label>
      <label className="form-row">{t("Длина")}<select value={o.length} onChange={(e) => setO({ ...o, length: e.target.value })}><option value="short">{t("коротко")}</option><option value="medium">{t("средне")}</option><option value="long">{t("развёрнуто")}</option></select></label>
      <label className="form-row">{t("Тон")}<select value={o.register} onChange={(e) => setO({ ...o, register: e.target.value })}><option value="conversational">{t("живой")}</option><option value="formal">{t("деловой")}</option></select></label>
    </div>
    <label className="form-row">{t("О чём не писать никогда (через запятую)")}<input type="text" value={o.never} onChange={(e) => setO({ ...o, never: e.target.value })} /></label>
    <div className="actions"><button className="btn primary" disabled={busy || a.now.length < 20 || a.win.length < 20 || !topics.length} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/interview`, { body: { answers: a, topics, language: o.language, length: o.length, register: o.register, never_topics: o.never.split(",").map((z: string) => z.trim()).filter(Boolean) } }), "Агент собрал паспорт голоса", next)}>{t("Собрать паспорт")}</button></div>
  </>);
}

function StepPassport({ x, next }: { x: any; next: () => void }) {
  const { busy, run } = useAction();
  const p = x.agent.passport;
  const [edit, setEdit] = useState({ headline: p?.headline ?? "", about: p?.about ?? "" });
  const [samples, setSamples] = useState<any[] | null>(null);
  if (!p) return <p className="muted">{t("Сначала пройдите интервью.")}</p>;
  return (<>
    <h2>{t("Паспорт голоса")}</h2>
    <p className="muted">{t("По этой карточке агент пишет так, чтобы посты звучали как вы. Проверьте и нажмите «Да, это я».")}</p>
    <div className="passport">
      <label className="form-row">{t("Заголовок профиля")}<input type="text" value={edit.headline} onChange={(e) => setEdit({ ...edit, headline: e.target.value })} /></label>
      <label className="form-row">{t("О себе")}<textarea rows={3} value={edit.about} onChange={(e) => setEdit({ ...edit, about: e.target.value })} /></label>
      <dl className="kv">
        <dt>{t("Роль")}</dt><dd>{t(p.role_label)}</dd>
        <dt>{t("Темы")}</dt><dd>{p.topics.join(" · ")}</dd>
        <dt>{t("Тон")}</dt><dd>{p.tone.length}, {p.tone.register}, {p.language.toUpperCase()}</dd>
        <dt>{t("Никогда")}</dt><dd>{p.never_topics.join(", ") || "–"}</dd>
      </dl>
    </div>
    <div className="actions">
      <button className="btn" disabled={busy} onClick={() => run(async () => setSamples((await api(`/api/me/agent/${x.account.id}/samples`, { method: "POST" })).samples), "Примеры готовы")}>{t("Показать, как будет звучать")}</button>
    </div>
    {samples && <div className="grid cols-2">{samples.map((sm, i) => <article key={i} className="post-preview"><span className="small muted">#{sm.topic}</span><p>{sm.text ?? t("Агенту не хватает фактов по этой теме: дополните интервью.")}</p></article>)}</div>}
    <div className="actions"><button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/passport/confirm`, { body: { expected_hash: x.agent.passport_hash, headline: edit.headline, about: edit.about } }), "Паспорт подтверждён", next)}>{t("Да, это я")}</button></div>
  </>);
}

function StrategyCards({ presets, value, max, onPick }: { presets: any[]; value: string; max: string; onPick: (k: string) => void }) {
  const maxIdx = presets.findIndex((p) => p.key === max);
  return (
    <div className="strategy-grid" role="radiogroup" aria-label={t("Стратегия")}>
      {presets.map((p, i) => (
        <button key={p.key} role="radio" aria-checked={value === p.key} disabled={i > maxIdx} className={`strategy s${i} ${value === p.key ? "on" : ""}`} onClick={() => onPick(p.key)}>
          <b>{t(p.label)}</b>
          <span className="small">{t(p.summary)}</span>
          <span className="meter" aria-hidden="true">{[0, 1, 2, 3, 4].map((k) => <i key={k} className={k <= i ? "f" : ""} />)}</span>
          <span className="small muted num">{p.postsPerWeek} {t("пост/нед")} · {p.commentsPerWeek} {t("комм./нед")}{p.messagesPerWeek ? ` · ${p.messagesPerWeek} ${t("сообщ./нед")}` : ""}{p.salesNavigator ? " · Sales Navigator" : ""}</span>
          {p.unlockAfterDays ? <span className="small muted">{t("открывается с дня")} {p.unlockAfterDays}</span> : null}
        </button>))}
    </div>
  );
}

function StepStrategy({ x, cat, next }: { x: any; cat: any; next: () => void }) {
  const { busy, run } = useAction();
  const [level, setLevel] = useState<string>(x.strategy.employee ?? x.strategy.company);
  const [veto, setVeto] = useState<number>(x.agent.veto_hours);
  const [agree, setAgree] = useState(false);
  return (<>
    <h2>{t("Стратегия и автопилот")}</h2>
    <p className="muted">{t("Компания разрешила уровень до")} «{t(cat.strategies.find((p: any) => p.key === x.strategy.company)?.label ?? "")}». {t("Можно выбрать спокойнее. Первые 30 дней идёт прогрев: темп растёт постепенно.")}</p>
    <StrategyCards presets={cat.strategies} value={level} max={x.strategy.company} onPick={setLevel} />
    <label className="form-row">{t("Сколько часов до публикации вы видите пост и можете его отменить")}
      <select value={veto} onChange={(e) => setVeto(Number(e.target.value))}>{[4, 12, 24, 48, 72].map((h) => <option key={h} value={h}>{h} {t("ч")}</option>)}</select></label>
    <div className="terms">
      <b>{t("Условия автопилота")}</b>
      <ul>{cat.terms.map((z: string) => <li key={z}>{t(z)}</li>)}{x.review_by_company && <li>{t(cat.terms_review)}</li>}</ul>
      <label className="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> {t("Согласен, агент может публиковать посты от моего имени на этих условиях")}</label>
    </div>
    <div className="actions"><button className="btn primary" disabled={busy || !agree} onClick={() => run(async () => {
      await api(`/api/me/agent/${x.account.id}/strategy`, { body: { level: level === x.strategy.company ? null : level } });
      await api(`/api/me/agent/${x.account.id}/autopilot`, { body: { mode: "on", veto_hours: veto } });
    }, "Автопилот включён", next)}>{t("Включить автопилот")}</button></div>
  </>);
}

function StepPayment({ x, cat, next }: { x: any; cat: any; next: () => void }) {
  const { busy, run } = useAction();
  const [code, setCode] = useState("");
  if (x.subscription.active) return (<><h2>{t("Подписка активна")}</h2><p>{t("Оплачено до")} {fmt(x.subscription.period_end)}.</p><div className="actions"><button className="btn primary" onClick={next}>{t("Готово")}</button></div></>);
  return (<>
    <h2>{t("Оплата")}</h2>
    <div className="plan">
      <div><b className="price num">{money(cat.plan.priceUsd)}</b><span className="muted"> / {t("месяц за аккаунт")}</span></div>
      <ul>{cat.plan.includes.map((z: string) => <li key={z}>{t(z)}</li>)}</ul>
    </div>
    <div className="pay-row">
      <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await api("/api/billing/checkout", { body: { account_id: x.account.id } }); if (r.url.startsWith("#")) go(r.url.slice(1)); else location.href = r.url; }, "Переходим к оплате")}>{t("Оплатить картой")}</button>
      <span className="muted">{t("или")}</span>
      <input type="text" placeholder={t("Промокод")} value={code} onChange={(e) => setCode(e.target.value)} aria-label={t("Промокод")} />
      <button className="btn" disabled={busy || code.length < 3} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/promo`, { body: { code } }), "Промокод применён", next)}>{t("Применить")}</button>
    </div>
    <p className="small muted">{t("Если компания оплачивает подписки за команду, этот шаг закроется сам после оплаты руководителем.")}</p>
  </>);
}

function Architecture({ x }: { x: any }) {
  const nodes = [
    ["Паспорт голоса", `${x.agent.passport?.topics?.length ?? 0} ${t("тем")}`],
    ["Планировщик", t(STAGE_RU[x.warmup.stage] ?? x.warmup.stage)],
    ["Автор (Opus)", t("пишет из ваших фактов")],
    ["Офицер безопасности", t("лимиты, риск, тексты")],
    ["Окно отмены", `${x.agent.veto_hours} ${t("ч")}`],
    [x.network === "x" ? "X API" : "LinkedIn API", x.linkedin.api ? t("подключено") : t("подключите профиль")],
  ];
  return (
    <div className="arch" aria-label={t("Как работает ваш агент")}>
      {nodes.map(([a, b], i) => <div key={a} className="arch-node"><b>{t(a)}</b><span className="small muted">{b}</span>{i < nodes.length - 1 && <i className="arch-arrow" aria-hidden="true">→</i>}</div>)}
    </div>
  );
}

/* ---------- Рабочий экран агента ---------- */
function AgentHome({ x, cat, reload }: { x: any; cat: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const act = (id: string, action: string, text?: string) => run(() => api(`/api/autopilot-posts/${id}/action`, { body: { action, text } }), action === "veto" ? "Пост отменён" : action === "publish_now" ? "Пост выйдет в ближайшие минуты" : "Сохранено", () => { setEditing(null); reload(); });
  const open = x.posts.filter((p: any) => ["needs_owner", "review", "veto_window", "planned", "scheduled"].includes(p.status));
  const past = x.posts.filter((p: any) => !["needs_owner", "review", "veto_window", "planned", "scheduled"].includes(p.status));
  const level = cat.strategies.find((p: any) => p.key === x.strategy.effective);
  const isX = x.network === "x";
  const connect = () => run(async () => { if (isX) { const r = await api(`/api/me/agent/${x.account.id}/x/connect`, { method: "POST" }); if (r.authorize_url) location.href = r.authorize_url; else reload(); } else { const r = await api(`/api/accounts/${x.account.id}/oauth/start`); location.href = r.authorize_url; } }, isX ? "Подключаем X" : "Переходим в LinkedIn");
  return (<>
    <h1>{t("Мой агент")} <span className={`net-badge ${isX ? "x" : "li"}`}>{isX ? "X" : "in"}</span></h1>
    <div className="vitals">
      <div className={`vital ${x.agent.autopilot === "on" ? "" : "alert"}`}><b>{x.agent.autopilot === "on" ? t("Включён") : x.agent.autopilot === "paused" ? t("Пауза") : t("Выключен")}</b><span>{t("автопилот")}</span></div>
      <div className="vital"><b>{t(level?.label ?? "")}</b><span>{t("стратегия")}{x.strategy.capped_by ? ` (${x.strategy.capped_by === "warmup" ? t("ограничено прогревом") : t("ограничено риском")})` : ""}</span></div>
      <div className="vital"><b className="num">{Math.min(x.warmup.day, 30)}/30</b><span>{t(STAGE_RU[x.warmup.stage])}</span></div>
      <div className={`vital ${x.subscription.active ? "" : "alert"}`}><b>{x.subscription.active ? fmt(x.subscription.period_end).split(",")[0] : t("не активна")}</b><span>{t("подписка")}</span></div>
      <div className="vital"><b className="num">{money(x.agent.spent_usd)}</b><span>{t("из")} {money(x.agent.budget_usd_month)} {t("бюджета агента")}</span></div>
    </div>
    {!x.subscription.active && <div className="notice warn">{t("Подписка не активна: агент на паузе.")} <button className="btn small" onClick={() => go("/me/pay")}>{t("Продлить")}</button></div>}
    {!x.linkedin.api && <div className="notice warn">{isX ? t("Аккаунт X не подключён: твиты не смогут выйти.") : t("Профиль LinkedIn не подключён: посты не смогут выйти.")} <button className="btn small" disabled={busy} onClick={connect}>{t("Подключить")}</button></div>}
    {x.pack > 0 && <div className="notice info">{t("Агент предлагает поддержать компанию")}: <b className="num">{x.pack}</b>. <button className="btn small primary" disabled={busy} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/pack/approve`, { method: "POST" }), "Одобрено", reload)}>{t("Одобрить все")}</button> <a href="#/me/actions">{t("посмотреть")}</a></div>}
    <h2>{t("Ближайшие посты")}</h2>
    {!open.length && <p className="muted">{t("Агент готовит посты за сутки до выхода. Новые появятся здесь и в Telegram.")}</p>}
    <div className="post-list">
      {open.map((p: any) => (
        <article key={p.id} className={`post-card st-${p.status}`}>
          <header><span className={`pill st-${p.status}`}>{t(STATUS_RU[p.status] ?? p.status)}</span><span className="muted small">{fmt(p.publish_at, x.account.timezone)}</span>{p.kind === "company_news" && <span className="pill">{t("новость компании")}</span>}{p.topic_tag && <span className="muted small">#{p.topic_tag}</span>}</header>
          {p.media_id && <MediaImg id={p.media_id} alt={t("Иллюстрация к посту")} className="post-img" />}
          {editing?.id === p.id ? <textarea rows={7} value={editing!.text} onChange={(e) => setEditing({ id: p.id, text: e.target.value })} /> : <p className="post-text">{p.body ?? t("Текст появится за сутки до публикации.")}</p>}
          {p.veto_ru?.length > 0 && <p className="small warn-text">{p.veto_ru.join("; ")}</p>}
          {p.review_comment && <p className="small warn-text">{t("Комментарий компании")}: {p.review_comment}</p>}
          <footer>
            {editing?.id === p.id ? (<><button className="btn primary small" disabled={busy} onClick={() => act(p.id, "edit", editing!.text)}>{t("Сохранить")}</button><button className="btn ghost small" onClick={() => setEditing(null)}>{t("Отмена")}</button></>) : (<>
              {p.status === "needs_owner" && p.body && <button className="btn primary small" disabled={busy} onClick={() => act(p.id, "approve")}>{t("Подходит")}</button>}
              {p.status === "veto_window" && <button className="btn small" disabled={busy} onClick={() => act(p.id, "publish_now")}>{t("Опубликовать сейчас")}</button>}
              {["needs_owner", "review", "veto_window"].includes(p.status) && p.body && <button className="btn small" onClick={() => setEditing({ id: p.id, text: p.body })}>{t("Править")}</button>}
              <button className="btn danger small" disabled={busy || p.status === "scheduled"} onClick={() => act(p.id, "veto")}>{t("Отменить")}</button>
            </>)}
          </footer>
        </article>))}
    </div>
    <div className="grid cols-2">
      <section className="panel"><h3>{t("Стратегия")}</h3>
        <StrategyCards presets={cat.strategies} value={x.strategy.employee ?? x.strategy.company} max={x.strategy.company} onPick={(k) => run(() => api(`/api/me/agent/${x.account.id}/strategy`, { body: { level: k === x.strategy.company ? null : k } }), "Стратегия изменена", reload)} />
      </section>
      <section className="panel"><h3>{t("Управление")}</h3>
        <div className="actions wrap">
          {x.agent.autopilot === "on" ? (<>
            <button className="btn" disabled={busy} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/autopilot`, { body: { mode: "pause", pause_days: 7 } }), "Пауза на неделю", reload)}>{t("Пауза на неделю")}</button>
            <button className="btn danger" disabled={busy} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/autopilot`, { body: { mode: "off" } }), "Автопилот выключен", reload)}>{t("Выключить автопилот")}</button>
          </>) : <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/me/agent/${x.account.id}/autopilot`, { body: { mode: "on" } }), "Автопилот включён", reload)}>{t("Включить автопилот")}</button>}
        </div>
        <TelegramBox x={x} reload={reload} />
        <p className="small muted">{t("LinkedIn предупредил о подозрительной активности? Сообщите: агент сразу остановится.")} <button className="btn link" onClick={() => run(() => api(`/api/accounts/${x.account.id}/signals`, { body: { kind: "warning" } }), "Агент остановлен на сутки", reload)}>{t("LinkedIn предупредил")}</button></p>
      </section>
    </div>
    <AgentChat accountId={x.account.id} reload={reload} />
    <Portraits x={x} reload={reload} />
    <h2>{t("Как работает ваш агент")}</h2>
    <Architecture x={x} />
    {past.length > 0 && <><h2>{t("История")}</h2>
      <table className="table"><tbody>{past.map((p: any) => <tr key={p.id}><td>{fmt(p.publish_at, x.account.timezone)}</td><td><span className={`pill st-${p.status}`}>{t(STATUS_RU[p.status] ?? p.status)}</span></td><td className="small">{(p.body ?? "").slice(0, 90)}</td><td>{p.external_url && <a href={p.external_url} target="_blank" rel="noreferrer">LinkedIn</a>}</td></tr>)}</tbody></table></>}
  </>);
}

function TelegramBox({ x, reload }: { x: any; reload: () => void }) {
  const { busy, run } = useAction();
  const [link, setLink] = useState<any>(null);
  if (x.agent.telegram_linked) return <p className="small">{t("Telegram подключён: посты до публикации и предложения приходят туда.")} <button className="btn link" onClick={() => run(() => api(`/api/me/agent/${x.account.id}/telegram/unlink`, { method: "POST" }), "Telegram отключён", reload)}>{t("Отключить")}</button></p>;
  return (<div className="small">
    <button className="btn small" disabled={busy} onClick={() => run(async () => setLink(await api(`/api/me/agent/${x.account.id}/telegram/link`, { method: "POST" })), "Ссылка готова")}>{t("Подключить Telegram")}</button>
    {link && (link.url ? <p><a href={link.url} target="_blank" rel="noreferrer">{t("Открыть бота")}</a> {t("и нажать Start. Ссылка действует 30 минут.")}</p> : <p>{t("Отправьте боту команду")} <code>/start {link.token}</code></p>)}
  </div>);
}

function Portraits({ x, reload }: { x: any; reload: () => void }) {
  const { busy, run } = useAction();
  const p = x.portrait;
  if (!p || !["ready", "chosen", "queued", "generating"].includes(p.status)) return null;
  return (<section className="panel"><h3>{t("Портрет и обложка профиля")}</h3>
    {["queued", "generating"].includes(p.status) ? <p className="muted">{t("Портреты готовятся…")}</p> : (<>
      <div className="portraits">{p.result_media_ids.map((id: string) => (
        <button key={id} className={`portrait ${p.chosen_media_id === id ? "on" : ""}`} aria-pressed={p.chosen_media_id === id} disabled={busy} onClick={() => run(() => api(`/api/portrait-jobs/${p.id}/choose`, { body: { media_id: id } }), "Портрет выбран: помощник оформит профиль вместе с вами", reload)}>
          <MediaImg id={id} alt={t("Вариант портрета")} /></button>))}</div>
      {p.banner_media_id && <MediaImg id={p.banner_media_id} alt={t("Обложка профиля")} className="banner" />}
      <p className="small muted">{t("Портрет сохраняет ваше лицо. Исходные фото уже удалены.")} <button className="btn link" onClick={() => run(() => api(`/api/me/agent/${x.account.id}/likeness/revoke`, { method: "POST" }), "Фото и портреты удалены", reload)}>{t("Удалить портреты и отозвать согласие")}</button></p>
    </>)}
  </section>);
}

/* ---------- Оплата (демо) и продление ---------- */
export function DemoPayPage({ id }: { id: string }) {
  const { busy, run } = useAction();
  return (<div className="panel" style={{ maxWidth: 520 }}>
    <h1>{t("Оплата подписки")}</h1>
    <p>{t("Демо-режим: в рабочей версии здесь страница оплаты Stripe.")}</p>
    <button className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/billing/demo/${id}/confirm`, { method: "POST" }), "Оплачено", () => go("/"))}>{t("Оплатить")}</button>
  </div>);
}
export function RenewPage() {
  const s = useApi<any>("/api/me/agent");
  return <Loadable s={s}>{(d) => <div className="panel" style={{ maxWidth: 640 }}><StepPayment x={d.accounts[0]} cat={d.catalog} next={() => go("/")} /></div>}</Loadable>;
}

/* ---------- Лиды ---------- */
export function OutreachPage() {
  const me = useApi<any>("/api/me/agent");
  const accountId = me.data?.accounts?.[0]?.account?.id;
  const s = useApi<any>(accountId ? `/api/me/outreach/${accountId}` : null, [accountId]);
  const { busy, run } = useAction();
  const [csv, setCsv] = useState("");
  return (<Loadable s={s}>{(d) => (<>
    <h1>{t("Лиды и сообщения")}</h1>
    <p className="lede">{t("Агент готовит приглашения и сообщения по вашему списку лидов. Вы открываете профиль, вставляете текст и отправляете сами: так LinkedIn видит живого человека.")}</p>
    <div className="vitals">
      <div className="vital"><b className="num">{d.sent_this_week.invite ?? 0}/{d.limits.invite}</b><span>{t("приглашений за неделю")}</span></div>
      <div className="vital"><b className="num">{d.sent_this_week.message ?? 0}/{d.limits.message}</b><span>{t("сообщений за неделю")}</span></div>
      <div className="vital"><b>{d.sales_navigator ? t("доступен") : t("с уровня «Активный»")}</b><span>Sales Navigator</span></div>
    </div>
    {d.limits.invite === 0 && d.limits.message === 0 && <div className="notice info">{t("На вашей стратегии агент не ведёт переписку. Её открывают уровни «Спокойный рост» и выше.")}</div>}
    <div className="post-list">{d.items.filter((i: any) => i.status === "drafted").map((i: any) => (
      <article key={i.id} className="post-card">
        <header><b>{i.lead_name}</b><span className="muted small">{[i.lead_title, i.lead_company].filter(Boolean).join(", ")}</span><span className="pill">{i.kind === "invite" ? t("приглашение") : t("сообщение")}</span></header>
        <p className="post-text">{i.draft}</p>
        <footer>
          <button className="btn small" onClick={() => { navigator.clipboard?.writeText(i.draft).catch(() => null); window.open(i.lead_url, "_blank", "noopener"); }}>{t("Скопировать и открыть профиль")}</button>
          <button className="btn primary small" disabled={busy} onClick={() => run(() => api(`/api/outreach/${i.id}/mark`, { body: { action: "sent" } }), "Отмечено", s.reload)}>{t("Отправил")}</button>
          <button className="btn ghost small" disabled={busy} onClick={() => run(() => api(`/api/outreach/${i.id}/mark`, { body: { action: "skip" } }), "Пропущено", s.reload)}>{t("Пропустить")}</button>
        </footer>
      </article>))}</div>
    <section className="panel"><h3>{t("Загрузить лидов")}</h3>
      <p className="small muted">{t("CSV из Sales Navigator или таблицы: имя, должность, компания, ссылка на профиль LinkedIn.")}</p>
      <textarea rows={5} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder="First Name,Last Name,Title,Company,LinkedIn URL" />
      <div className="actions"><button className="btn" disabled={busy || csv.length < 10} onClick={() => run(() => api(`/api/me/outreach/${accountId}/import`, { body: { csv, kind: "invite", source: "sales_navigator_export" } }), "Лиды загружены", () => { setCsv(""); s.reload(); })}>{t("Загрузить")}</button></div>
    </section>
  </>)}</Loadable>);
}

/* ---------- Руководитель: вкладка «Автопилот» ---------- */
export function CompanyAutopilot({ id }: { id: string }) {
  const s = useApi<any>(`/api/companies/${id}/autopilot`);
  const b = useApi<any>(`/api/companies/${id}/billing`);
  const { busy, run } = useAction();
  const [sel, setSel] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  useEffect(() => setSel([]), [s.data]);
  return (<Loadable s={s}>{(d) => {
    const pending = d.calendar.filter((c: any) => c.review_required && !c.reviewed_at && ["review", "veto_window"].includes(c.status));
    const others = d.calendar.filter((c: any) => !pending.includes(c));
    return (<div className="grid">
      <div className="vitals">
        <div className="vital"><b className="num">{d.coverage.autopilot_on}/{d.coverage.employees}</b><span>{t("сотрудников на автопилоте")}</span></div>
        <div className="vital"><b className="num">{d.published_30d}</b><span>{t("постов сотрудников за 30 дней")}</span></div>
        <div className={`vital ${pending.length ? "alert" : ""}`}><b className="num">{pending.length}</b><span>{t("ждут проверки компании")}</span></div>
        <div className="vital"><b className="num">{money(d.coverage.spent)}</b><span>{t("расход агентов в этом месяце")}</span></div>
      </div>
      <section className="panel"><h3>{t("Стратегия компании")}</h3>
        <p className="small muted">{t("Уровень по умолчанию и потолок для всех сотрудников. Сотрудник может выбрать спокойнее. Новые аккаунты сначала проходят прогрев.")}</p>
        <StrategyCards presets={d.strategy.presets} value={d.strategy.level} max="aggressive" onPick={(k) => run(() => api(`/api/companies/${id}/strategy`, { body: { level: k } }), "Стратегия компании изменена", s.reload)} />
      </section>
      {d.can_review && <section className="panel"><h3>{t("Проверка постов (compliance)")}</h3>
        {!pending.length ? <p className="muted">{t("Все посты проверены.")}</p> : (<>
          <div className="actions wrap">
            <button className="btn small" onClick={() => setSel(sel.length === pending.length ? [] : pending.map((p: any) => p.id))}>{sel.length === pending.length ? t("Снять выбор") : t("Выбрать все")}</button>
            <button className="btn primary small" disabled={busy || !sel.length} onClick={() => run(() => api(`/api/companies/${id}/autopilot/review`, { body: { post_ids: sel, decision: "approve" } }), "Утверждено", s.reload)}>{t("Утвердить выбранные")} ({sel.length})</button>
            <input type="text" placeholder={t("Причина отклонения")} value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn danger small" disabled={busy || !sel.length || reason.length < 3} onClick={() => run(() => api(`/api/companies/${id}/autopilot/review`, { body: { post_ids: sel, decision: "reject", comment: reason } }), "Отклонено", s.reload)}>{t("Отклонить")}</button>
          </div>
          <div className="post-list">{pending.map((p: any) => (
            <label key={p.id} className="post-card selectable">
              <header><input type="checkbox" checked={sel.includes(p.id)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((z) => z !== p.id))} /><b>{p.author}</b><span className="muted small">{fmt(p.publish_at)}</span>{p.topic_tag && <span className="muted small">#{p.topic_tag}</span>}</header>
              <p className="post-text">{p.body}</p>
            </label>))}</div>
        </>)}
      </section>}
      <section className="panel"><h3>{t("Календарь")}</h3>
        {!others.length ? <p className="muted">{t("Пока пусто: агенты планируют посты на неделю вперёд.")}</p> : (
          <table className="table"><thead><tr><th>{t("Когда")}</th><th>{t("Автор")}</th><th>{t("Тема")}</th><th>{t("Статус")}</th><th></th></tr></thead>
            <tbody>{others.map((p: any) => <tr key={p.id}><td>{fmt(p.publish_at)}</td><td>{p.author}</td><td>{p.topic_tag ? `#${p.topic_tag}` : "–"}</td><td><span className={`pill st-${p.status}`}>{t(STATUS_RU[p.status] ?? p.status)}</span></td><td>{p.external_url && <a href={p.external_url} target="_blank" rel="noreferrer">LinkedIn</a>}</td></tr>)}</tbody></table>)}
        {d.topics.length > 0 && <p className="small muted">{t("Темы за 30 дней")}: {d.topics.map((x: any) => `#${x.tag ?? "–"} ${x.n}`).join(" · ")}</p>}
      </section>
      <section className="panel"><h3>{t("Прогрев команды")}</h3>
        <div className="vitals">{Object.entries(d.stages).map(([k, v]) => <div key={k} className="vital"><b className="num">{String(v)}</b><span>{t(STAGE_RU[k] ?? k)}</span></div>)}</div>
        <ul className="small">{d.warmup_plan.map((w: any) => <li key={w.days}><b>{t("Дни")} {w.days}.</b> {t(w.what)}</li>)}</ul>
      </section>
      <Loadable s={b}>{(bd) => (
        <section className="panel"><h3>{t("Подписки команды")}</h3>
          <p>{t("Активных")}: <b className="num">{bd.active}</b> · {t("в месяц")}: <b className="num">{money(bd.monthly_usd)}</b> · {t("без подписки")}: <b className="num">{bd.unpaid}</b></p>
          {bd.unpaid > 0 && <button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = await api("/api/billing/checkout", { body: { client_id: id } }); if (r.url.startsWith("#")) go(r.url.slice(1)); else location.href = r.url; }, "Переходим к оплате")}>{t("Оплатить за всех")} ({money(bd.unpaid * bd.plan.priceUsd)})</button>}
          <table className="table"><tbody>{bd.seats.map((x: any) => <tr key={x.account_id}><td>{x.display_name}</td><td>{x.active ? t("активна") : t("нет")}</td><td>{x.period_end ? fmt(x.period_end) : "–"}</td></tr>)}</tbody></table>
        </section>)}</Loadable>
    </div>);
  }}</Loadable>);
}

export function useEmployeeRoute() { return useRoute(); }
export { num };

function AgentChat({ accountId, reload }: { accountId: string; reload: () => void }) {
  const s = useApi<any>(`/api/me/agent/${accountId}/chat`, [accountId]);
  const { busy, run } = useAction();
  const [text, setText] = useState("");
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const send = (body: any) => run(() => api(`/api/me/agent/${accountId}/chat`, { body }), "Отправлено", () => { setText(""); setFile(null); s.reload(); reload(); });
  const readFile = (f: File | undefined) => { if (!f) return; const r = new FileReader(); r.onload = () => setFile({ name: f.name, text: String(r.result).slice(0, 100000) }); r.readAsText(f); };
  return (<section className="panel chat"><h3>{t("Чат с агентом")}</h3>
    <p className="small muted">{t("Напишите: «сделай контент-план», «пост про безопасность», «давай активнее», «добавь тему про данные». Можно приложить файл с вашими фактами.")}</p>
    <Loadable s={s}>{(d) => (
      <div className="chat-log">
        {!d.messages.length && <p className="muted small">{t("Пока пусто. Задайте агенту первый вопрос.")}</p>}
        {d.messages.map((m: any) => (
          <div key={m.id} className={`bubble ${m.role}`}>
            {m.attachment_name && <span className="small muted">📎 {m.attachment_name}</span>}
            <p>{m.body}</p>
            {m.role === "agent" && m.action && !m.action.applied && ["set_strategy", "add_topic", "content_plan", "draft_post", "file_facts"].includes(m.action.type) && (
              <button className="btn primary small" disabled={busy} onClick={() => send({ text: d.messages.filter((u: any) => u.role === "user").slice(-1)[0]?.body ?? "", apply: true })}>{t("Применить")}</button>)}
            {m.action?.type === "content_plan" && <ul className="small plan-list">{(m.action.items ?? []).map((i: any, k: number) => <li key={k}>{t("Неделя")} {i.week}: #{i.topic} — {i.angle}</li>)}</ul>}
          </div>))}
      </div>)}</Loadable>
    <div className="chat-input">
      <input type="file" accept=".txt,.md,.csv" onChange={(e) => readFile(e.target.files?.[0])} aria-label={t("Файл")} />
      {file && <span className="small">📎 {file.name}</span>}
      <textarea rows={2} value={text} placeholder={t("Сообщение агенту…")} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) send({ text, attachment: file ?? undefined }); }} />
      <button className="btn primary" disabled={busy || !text.trim()} onClick={() => send({ text, attachment: file ?? undefined })}>{t("Отправить")}</button>
    </div>
  </section>);
}