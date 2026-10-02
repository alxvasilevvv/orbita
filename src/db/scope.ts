import type { Db, Queryable } from "./db";

/**
 * Границы видимости пользователя, передаваемые в PostgreSQL для политик RLS.
 * clientIds: клиенты, доступные целиком; accountIds: аккаунты по роли на аккаунт;
 * partialClientIds: клиенты этих аккаунтов (видны только строки уровня клиента);
 * internal: есть роль агентства, открывающая внутренние таблицы (задачи, время, процессы).
 */
export interface DbScope {
  agencyId: string;
  allClients: boolean;
  clientIds: string[];
  accountIds: string[];
  partialClientIds: string[];
  internal: boolean;
  audit: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuids = (xs: string[]) => xs.every((c) => UUID.test(c));

/**
 * Преамбула транзакции: параметры области и переключение на роль app_user одним оператором.
 * Значения: только проверенные UUID и флаги, поэтому безопасно подставляются литералами.
 */
export function scopePrelude(s: DbScope): string {
  if (!UUID.test(s.agencyId) || !uuids(s.clientIds) || !uuids(s.accountIds ?? []) || !uuids(s.partialClientIds ?? [])) throw new Error("Некорректная область доступа");
  const on = (b: boolean) => (b ? "on" : "off");
  return `SELECT set_config('app.agency_id', '${s.agencyId}', true), set_config('app.all_clients', '${on(s.allClients)}', true), ` +
    `set_config('app.client_ids', '${s.clientIds.join(",")}', true), set_config('app.account_ids', '${(s.accountIds ?? []).join(",")}', true), ` +
    `set_config('app.partial_client_ids', '${(s.partialClientIds ?? []).join(",")}', true), set_config('app.internal', '${on(s.internal)}', true), ` +
    `set_config('app.audit', '${on(s.audit)}', true), set_config('role', 'app_user', true)`;
}

async function enter(q: Queryable, s: DbScope) {
  await q.query(scopePrelude(s));
}

/**
 * Обёртка над БД: каждый запрос и каждая транзакция выполняются под ролью app_user
 * с параметрами области. Даже ошибка в сервисном слое не откроет данные чужого клиента.
 */
export function scopedDb(base: Db, scope: DbScope): Db {
  const prelude = scopePrelude(scope);
  const tx = <T>(fn: (q: Queryable) => Promise<T>) => base.txWith ? base.txWith(prelude, fn) : base.tx(async (q) => { await enter(q, scope); return fn(q); });
  return {
    query: (sql, params) => tx((q) => q.query(sql, params)),
    tx,
    close: () => base.close(),
  };
}
