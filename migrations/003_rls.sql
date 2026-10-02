-- Второй рубеж изоляции: Row Level Security.
-- Запросы пользователей выполняются под ролью app_user с параметрами сессии:
--   app.agency_id, app.all_clients ('on' для ролей уровня агентства), app.client_ids (через запятую), app.audit ('on' для аудитора).
-- Системные процессы (worker, миграции) работают под владельцем схемы и политики не применяются к ним.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
  IF NOT pg_has_role(current_user, 'app_user', 'MEMBER') THEN
    BEGIN
      EXECUTE format('GRANT app_user TO %I', current_user);
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'Роль app_user уже существует в кластере, а у пользователя % нет права её выдать. Администратор БД должен выполнить: GRANT app_user TO %;', current_user, current_user;
    END;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION app_agency() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.agency_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_client_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_to_array(nullif(current_setting('app.client_ids', true), ''), ',')::uuid[], '{}'::uuid[])
$$;

-- SECURITY DEFINER: читает clients без применения политик, чтобы избежать рекурсии.
CREATE OR REPLACE FUNCTION app_can_client(c uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT c = ANY(app_client_ids())
      OR (current_setting('app.all_clients', true) = 'on'
          AND EXISTS (SELECT 1 FROM clients WHERE id = c AND agency_id = app_agency()))
$$;

-- Идемпотентно включает RLS и выдаёт права на все таблицы с колонкой client_id.
-- Вызывается после каждой миграции, поэтому новые таблицы попадают под политику автоматически.
CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
BEGIN
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

  FOR t IN
    SELECT c.relname AS name,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'client_id') AS has_client,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'client_id' AND ic.is_nullable = 'YES') AS client_nullable,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'agency_id') AS has_agency
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    -- Секреты и служебные таблицы приложению под app_user недоступны вовсе.
    IF t.name IN ('encrypted_secrets', 'schema_migrations') THEN
      CONTINUE;
    END IF;
    -- Справочники: только чтение, без политик.
    IF t.name IN ('metric_definitions', 'retention_policies') THEN
      EXECUTE format('GRANT SELECT ON %I TO app_user', t.name);
      CONTINUE;
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t.name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.name);

    IF t.name = 'agencies' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON agencies USING (id = app_agency()) WITH CHECK (id = app_agency())';
    ELSIF t.name = 'clients' THEN
      EXECUTE $p$CREATE POLICY tenant_isolation ON clients
        USING (agency_id = app_agency() AND (current_setting('app.all_clients', true) = 'on' OR id = ANY(app_client_ids())))
        WITH CHECK (agency_id = app_agency() AND (current_setting('app.all_clients', true) = 'on' OR id = ANY(app_client_ids())))$p$;
    ELSIF t.has_client AND t.has_agency THEN
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
        USING (agency_id = app_agency() AND (client_id IS NULL OR app_can_client(client_id) OR current_setting('app.audit', true) = 'on'))
        WITH CHECK (agency_id = app_agency() AND (client_id IS NULL OR app_can_client(client_id)))$p$, t.name);
    ELSIF t.has_client AND t.client_nullable THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (client_id IS NULL OR app_can_client(client_id)) WITH CHECK (client_id IS NULL OR app_can_client(client_id))', t.name);
    ELSIF t.has_client THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (app_can_client(client_id)) WITH CHECK (app_can_client(client_id))', t.name);
    ELSIF t.has_agency THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (agency_id = app_agency()) WITH CHECK (agency_id = app_agency())', t.name);
    ELSE
      -- Таблица без признака владельца: доступ запрещён, пока для неё не описана политика.
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (false)', t.name);
    END IF;
  END LOOP;
END $$;
