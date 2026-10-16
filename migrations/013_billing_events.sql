-- Дедуп входящих событий оплаты: одно событие провайдера применяется один раз (идемпотентность вебхука).
CREATE TABLE billing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid REFERENCES agencies(id),
  provider text NOT NULL,
  event_id text NOT NULL,
  type text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, event_id)
);

CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  full_ids text := 'SELECT unnest(app_client_ids())';
  acc_ids text := 'SELECT unnest(app_account_ids())';
  part_ids text := 'SELECT unnest(app_partial_client_ids())';
  scope_expr text;
  internal_only text[] := ARRAY['tasks', 'time_entries', 'workflow_runs', 'workflow_definitions', 'incidents', 'deletion_runs', 'strategy_recommendations', 'experiments', 'profile_audits', 'agent_runs', 'employee_invites', 'telegram_outbox', 'promo_codes', 'billing_checkouts', 'billing_events'];
  -- Персональные данные участия сотрудника: вне агентства видит только владелец аккаунта, руководитель компании получает агрегаты через сервис.
  owner_scoped text[] := ARRAY['mission_actions', 'safety_events', 'account_safety', 'employee_profiles', 'consents', 'personal_agents', 'autopilot_posts', 'portrait_jobs', 'outreach_items', 'subscriptions', 'agent_messages', 'content_plans'];
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

    IF t.name = 'managed_accounts' THEN
      scope_expr := format('(client_id IN (%s) OR id IN (%s))', full_ids, acc_ids);
    ELSIF t.name = ANY(owner_scoped) THEN
      scope_expr := format($s$((current_setting('app.internal', true) = 'on' AND (client_id IN (%s) OR account_id IN (%s))) OR account_id IN (%s))$s$, full_ids, acc_ids, acc_ids);
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
