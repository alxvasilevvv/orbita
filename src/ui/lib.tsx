import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

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
export function useAction() {
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

export const fmt = (d?: string | null, tz?: string) => d ? new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz, ...(tz ? { timeZoneName: "short" as const } : {}) }).format(new Date(d)) : "—";
export const STATE_RU: Record<string, string> = { idea: "идея", brief: "бриф", draft: "черновик", editorial_review: "у редактора", client_review: "у клиента", approved: "согласован", scheduled: "запланирован", publishing: "публикуется", published: "опубликован", changes_requested: "нужны правки", cancelled: "отменён", failed: "ошибка", publication_unknown: "исход неизвестен", archived: "архив" };
export const EV_RU: Record<string, string> = { api_confirmed: "Подтверждено API", manual_mark: "Ручная отметка", unconfirmed: "Не подтверждено", unknown: "Исход неизвестен" };
export const MODE_RU: Record<string, string> = { api: "API", assisted: "Через человека", manual_import: "Ручной импорт", unavailable: "Недоступно" };
export const KIND_RU: Record<string, string> = { executive: "Руководитель", founder: "Основатель", expert: "Эксперт", employee: "Сотрудник", job_seeker: "Поиск работы", company_page: "Страница компании" };
export const State = ({ s }: { s: string }) => <span className={`state ${s}`}>{STATE_RU[s] ?? s}</span>;
