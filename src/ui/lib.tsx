import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { t, intlLocale } from "./i18n";
export { t };

/* ---------- инфраструктура ---------- */
export let currentUser = localStorageGet("uid");
export function setCurrentUser(id: string) { currentUser = id; localStorageSet("uid", id); }
export function localStorageGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
export function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } }

export class ApiError extends Error { constructor(public status: number, msg: string, public details?: any) { super(msg); } }
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const r = await fetch(path, { method: opts.method ?? (opts.body ? "POST" : "GET"), headers: { "content-type": "application/json", ...(currentUser ? { "x-user-id": currentUser } : {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.message ?? `Ошибка ${r.status}`, data.details);
  return data;
}

export type LoadState<T> = { data?: T; error?: ApiError; loading: boolean; reload: () => void };
export function useApi<T = any>(path: string | null, deps: unknown[] = []): LoadState<T> {
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

export const ToastCtx = createContext<(msg: string, err?: boolean) => void>(() => {});
export function useToast() { return useContext(ToastCtx); }

export function useRoute() {
  const [h, setH] = useState(location.hash.slice(1) || "/");
  useEffect(() => { const f = () => setH(location.hash.slice(1) || "/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
export const go = (p: string) => { location.hash = p; };

export function Loadable<T>({ s, empty, children }: { s: LoadState<T>; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (s.error) {
    if (s.error.status === 401) return <div className="notice info">{t("Выберите пользователя внизу слева, чтобы войти.")}</div>;
    if (s.error.status === 403) return <div className="notice error">{s.error.message}. {t("Доступ выдаёт владелец агентства или операционный директор.")}</div>;
    if (s.error.status === 404) return <div className="notice error">{t("Объект не найден или у вас нет к нему доступа.")}</div>;
    return <div className="notice error">{s.error.message}. <button className="btn" onClick={s.reload}>{t("Повторить")}</button></div>;
  }
  if (s.loading && !s.data) return <p className="muted">{t("Загрузка…")}</p>;
  if (s.data && empty?.(s.data)) return null;
  return <>{s.data && children(s.data)}</>;
}

/** Выполняет действие, показывает итог тем же глаголом, что и кнопка. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async (fn: () => Promise<unknown>, done: string, after?: () => void) => {
    setBusy(true);
    try { await fn(); toast(t(done)); after?.(); }
    catch (e: any) { toast(`${e.message}${Array.isArray(e.details) ? ": " + e.details.map((d: any) => d.message ?? d).join("; ") : ""}`, true); }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

export const fmt = (d?: string | null, tz?: string) => d ? new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz, ...(tz ? { timeZoneName: "short" as const } : {}) }).format(new Date(d)) : "–";
export const STATE_RU: Record<string, string> = { idea: "идея", brief: "бриф", draft: "черновик", editorial_review: "у редактора", client_review: "у клиента", approved: "согласован", scheduled: "запланирован", publishing: "публикуется", published: "опубликован", changes_requested: "нужны правки", cancelled: "отменён", failed: "ошибка", publication_unknown: "исход неизвестен", archived: "архив" };
export const EV_RU: Record<string, string> = { api_confirmed: "Подтверждено API", manual_mark: "Ручная отметка", unconfirmed: "Не подтверждено", unknown: "Исход неизвестен" };
export const MODE_RU: Record<string, string> = { api: "API", assisted: "Через человека", manual_import: "Ручной импорт", unavailable: "Недоступно" };
export const KIND_RU: Record<string, string> = { executive: "Руководитель", founder: "Основатель", expert: "Эксперт", employee: "Сотрудник", job_seeker: "Поиск работы", company_page: "Страница компании" };
export const State = ({ s }: { s: string }) => <span className={`state ${s}`}>{t(STATE_RU[s] ?? s)}</span>;
export const fmtDay = (d: string | Date, tz?: string) => new Intl.DateTimeFormat(intlLocale(), { day: "numeric", month: "short", timeZone: tz }).format(new Date(d));
export const fmtTime = (d: string | Date, tz?: string) => new Intl.DateTimeFormat(intlLocale(), { hour: "2-digit", minute: "2-digit", timeZone: tz }).format(new Date(d));
export const money = (v: number | null | undefined) => v == null ? "–" : new Intl.NumberFormat(intlLocale(), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(v);
export const num = (v: number | null | undefined, digits = 0) => v == null ? "–" : new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: digits }).format(v);

/** Текущий пользователь и его агентские права для показа кнопок. Проверки всё равно выполняет сервер. */
export type Me = { id: string; display_name: string; roles: string[]; agency_wide: boolean; client_only: boolean; auditor_only?: boolean; internal?: boolean; company_admin?: boolean; employee?: boolean; personal_agent?: boolean; company_ids?: string[]; locale: "ru" | "en"; agency_ops: string[] };
export const MeCtx = createContext<Me | null>(null);
export function useMe() { return useContext(MeCtx); }

export const ROLE_RU: Record<string, string> = { owner: "Владелец", ops_director: "Операционный директор", strategist: "Стратег", account_manager: "Аккаунт-менеджер", author: "Автор", designer: "Дизайнер", editor: "Редактор", community_manager: "Community manager", analyst: "Аналитик", client: "Клиент", auditor: "Аудитор", client_admin: "Руководитель компании" };

/** Загрузка файла как application/octet-stream (без multipart). */
export async function uploadFile(path: string, file: File) {
  const r = await fetch(path, { method: "POST", headers: { "content-type": "application/octet-stream", "x-filename": encodeURIComponent(file.name), ...(currentUser ? { "x-user-id": currentUser } : {}) }, body: file });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, data.message ?? `Ошибка ${r.status}`, data.details);
  return data;
}
