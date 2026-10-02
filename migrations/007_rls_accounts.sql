-- RLS v3: изоляция до уровня аккаунта и закрытие внутренних таблиц для представителей клиента.
-- Параметры сессии:
--   app.client_ids          клиенты, доступные целиком (уровень агентства или роль на клиента);
--   app.account_ids         аккаунты, доступные по роли на аккаунт;
--   app.partial_client_ids  клиенты этих аккаунтов (только строки уровня клиента, без чужих аккаунтов);
--   app.internal            'on', если у пользователя есть роль агентства (не только «клиент»).

CREATE OR REPLACE FUNCTION app_account_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_to_array(nullif(current_setting('app.account_ids', true), ''), ',')::uuid[], '{}'::uuid[])
$$;
CREATE OR REPLACE FUNCTION app_partial_client_ids() RETURNS uuid[] LANGUAGE sql STABLE AS $$
  SELECT coalesce(string_to_array(nullif(current_setting('app.partial_client_ids', true), ''), ',')::uuid[], '{}'::uuid[])
$$;

CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  full_ids text := 'SELECT unnest(app_client_ids())';
  acc_ids text := 'SELECT unnest(app_account_ids())';
  part_ids text := 'SELECT unnest(app_partial_client_ids())';
  scope_expr text;
  internal_only text[] := ARRAY['tasks', 'time_entries', 'workflow_runs', 'workflow_definitions', 'incidents', 'deletion_runs', 'strategy_recommendations', 'experiments', 'profile_audits'];
  internal_guard text;
BEGIN
  GRANT USAGE ON SCHEMA public TO app_user;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;

  FOR t IN
    SELECT c.relname AS name,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'client_id') AS has_client,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'client_id' AND ic.is_nullable = 'YES') AS client_nullable,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'account_id') AS has_account,
           EXISTS (SELECT 1 FROM information_schema.columns ic WHERE ic.table_schema = 'public' AND ic.table_name = c.relname AND ic.column_name = 'agency_id') AS has_agency
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    IF t.name IN ('encrypted_secrets', 'schema_migrations') THEN
      EXECUTE format('REVOKE ALL ON %I FROM app_user', t.name);
      CONTINUE;
    END IF;
    IF t.name IN ('metric_definitions', 'retention_policies') THEN
      EXECUTE format('GRANT SELECT ON %I TO app_user', t.name);
      CONTINUE;
    END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_user', t.name);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t.name);

    internal_guard := CASE WHEN t.name = ANY(internal_only) THEN $g$ AND current_setting('app.internal', true) = 'on'$g$ ELSE '' END;

    -- Область строки: клиент целиком или конкретный аккаунт.
    IF t.name = 'managed_accounts' THEN
      scope_expr := format('(client_id IN (%s) OR id IN (%s))', full_ids, acc_ids);
    ELSIF t.has_client AND t.has_account THEN
      scope_expr := format('(client_id IN (%s) OR (account_id IS NOT NULL AND account_id IN (%s)))', full_ids, acc_ids);
    ELSIF t.has_client THEN
      scope_expr := format('(client_id IN (%s) OR client_id IN (%s))', full_ids, part_ids);
    END IF;

    IF t.name = 'agencies' THEN
      EXECUTE 'CREATE POLICY tenant_isolation ON agencies USING (id = app_agency()) WITH CHECK (id = app_agency())';
    ELSIF t.name = 'clients' THEN
      EXECUTE format($p$CREATE POLICY tenant_isolation ON clients
        USING (agency_id = app_agency() AND (id IN (%s) OR id IN (%s)))
        WITH CHECK (agency_id = app_agency() AND (current_setting('app.all_clients', true) = 'on' OR id IN (%s)))$p$, full_ids, part_ids, full_ids);
    ELSIF t.has_client AND t.has_agency THEN
      EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
        USING (agency_id = app_agency() AND (client_id IS NULL OR current_setting('app.audit', true) = 'on' OR %s)%s)
        WITH CHECK (agency_id = app_agency() AND (client_id IS NULL OR %s)%s)$p$, t.name, scope_expr, internal_guard, scope_expr, internal_guard);
    ELSIF t.has_client AND t.client_nullable THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ((client_id IS NULL OR %s)%s) WITH CHECK ((client_id IS NULL OR %s)%s)', t.name, scope_expr, internal_guard, scope_expr, internal_guard);
    ELSIF t.has_client THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (%s%s) WITH CHECK (%s%s)', t.name, scope_expr, internal_guard, scope_expr, internal_guard);
    ELSIF t.has_agency THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (agency_id = app_agency()%s) WITH CHECK (agency_id = app_agency()%s)', t.name, internal_guard, internal_guard);
    ELSE
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (false)', t.name);
    END IF;
  END LOOP;
END $$;

-- Проверка «цель принадлежит другому клиенту»: агентство выводится из аккаунта, LIKE не используется,
-- search_path зафиксирован. Ответ только boolean.
DROP FUNCTION IF EXISTS target_is_other_managed_account(uuid, uuid, text, text);
CREATE FUNCTION target_is_other_managed_account(p_account uuid, p_url text, p_author text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM managed_accounts self JOIN clients sc ON sc.id = self.client_id
      JOIN clients c ON c.agency_id = sc.agency_id
      JOIN managed_accounts a ON a.client_id = c.id
     WHERE self.id = p_account AND a.id <> p_account
       AND ((a.profile_url IS NOT NULL AND length(a.profile_url) > 20 AND left(p_url, length(a.profile_url)) = a.profile_url)
         OR (p_author IS NOT NULL AND lower(regexp_replace(p_author, '[^[:alnum:]]+', ' ', 'g')) = lower(regexp_replace(a.display_name, '[^[:alnum:]]+', ' ', 'g'))))
  )
$$;
GRANT EXECUTE ON FUNCTION target_is_other_managed_account(uuid, text, text) TO app_user;
ALTER FUNCTION app_can_client(uuid) SET search_path = public, pg_temp;

-- Ожидаемая идентичность LinkedIn для аккаунта (urn:li:person:… или urn:li:organization:…).
ALTER TABLE managed_accounts ADD COLUMN linkedin_urn text;
