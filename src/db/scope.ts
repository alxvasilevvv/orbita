import type { Db, Queryable } from "./db";

/** Границы видимости пользователя, передаваемые в PostgreSQL для политик RLS. */
export interface DbScope {
  agencyId: string;
  allClients: boolean;
  clientIds: string[];
  audit: boolean;
}

async function enter(q: Queryable, s: DbScope) {
  await q.query(
    "SELECT set_config('app.agency_id', $1, true), set_config('app.all_clients', $2, true), set_config('app.client_ids', $3, true), set_config('app.audit', $4, true)",
    [s.agencyId, s.allClients ? "on" : "off", s.clientIds.join(","), s.audit ? "on" : "off"],
  );
  await q.query("SET LOCAL ROLE app_user");
}

/**
 * Обёртка над БД: каждый запрос и каждая транзакция выполняются под ролью app_user
 * с параметрами области. Даже ошибка в сервисном слое не откроет данные чужого клиента.
 */
export function scopedDb(base: Db, scope: DbScope): Db {
  return {
    query: (sql, params) => base.tx(async (q) => { await enter(q, scope); return q.query(sql, params); }),
    tx: (fn) => base.tx(async (q) => { await enter(q, scope); return fn(q); }),
    close: () => base.close(),
  };
}
