-- Стратегии активности (от «Репутации» до «Агрессивной»), лиды и черновики сообщений, подписка $200 в месяц за аккаунт.

-- Уровень по умолчанию и потолок компании; сотрудник может выбрать уровень ниже.
ALTER TABLE clients ADD COLUMN autopilot_strategy text NOT NULL DEFAULT 'reputation' CHECK (autopilot_strategy IN ('reputation','steady','growth','active','aggressive'));
ALTER TABLE personal_agents ADD COLUMN strategy text CHECK (strategy IN ('reputation','steady','growth','active','aggressive')),
  ADD COLUMN title text,
  ADD COLUMN photo_media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL;
ALTER TABLE personal_agents DROP CONSTRAINT IF EXISTS personal_agents_onboarding_step_check;
ALTER TABLE personal_agents ADD CONSTRAINT personal_agents_onboarding_step_check CHECK (onboarding_step IN ('role','interview','passport','photos','autopilot','payment','done'));

-- Лиды и черновики: личные сообщения и приглашения готовит агент, отправляет сотрудник сам одним касанием.
CREATE TABLE outreach_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('message','invite')),
  lead_name text NOT NULL,
  lead_title text,
  lead_company text,
  lead_url text NOT NULL,
  source text NOT NULL DEFAULT 'import' CHECK (source IN ('import','sales_navigator_export','manual')),
  draft text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','sent','skipped','blocked')),
  veto_codes text[] NOT NULL DEFAULT '{}',
  week_key text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, lead_url)
);
CREATE INDEX outreach_items_account_idx ON outreach_items(account_id, status);

-- Подписка за аккаунт: $200 в месяц. Промокод даёт бесплатные месяцы.
CREATE TABLE subscriptions (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  plan text NOT NULL DEFAULT 'autopilot',
  price_usd numeric(10,2) NOT NULL DEFAULT 200,
  status text NOT NULL DEFAULT 'none' CHECK (status IN ('none','trialing','active','past_due','canceled')),
  period_end timestamptz,
  provider text CHECK (provider IN ('stripe','demo','promo','invoice')),
  provider_ref text,
  paid_by_user_id uuid REFERENCES users(id),
  promo_code_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE promo_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id),
  code text NOT NULL,
  free_months int NOT NULL DEFAULT 1 CHECK (free_months BETWEEN 1 AND 12),
  max_redemptions int NOT NULL DEFAULT 100,
  redemptions int NOT NULL DEFAULT 0,
  expires_at timestamptz,
  disabled_at timestamptz,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, code)
);

CREATE TABLE promo_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_code_id uuid NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  redeemed_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (promo_code_id, account_id)
);

CREATE TABLE billing_checkouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_ids uuid[] NOT NULL,
  amount_usd numeric(10,2) NOT NULL,
  provider text NOT NULL,
  provider_session text,
  url text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','expired','failed')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);

CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  full_ids text := 'SELECT unnest(app_client_ids())';
  acc_ids text := 'SELECT unnest(app_account_ids())';
  part_ids text := 'SELECT unnest(app_partial_client_ids())';
  scope_expr text;
  internal_only text[] := ARRAY['tasks', 'time_entries', 'workflow_runs', 'workflow_definitions', 'incidents', 'deletion_runs', 'strategy_recommendations', 'experiments', 'profile_audits', 'agent_runs', 'employee_invites', 'telegram_outbox', 'promo_codes', 'billing_checkouts'];
  -- Персональные данные участия сотрудника: вне агентства видит только владелец аккаунта, руководитель компании получает агрегаты через сервис.
  owner_scoped text[] := ARRAY['mission_actions', 'safety_events', 'account_safety', 'employee_profiles', 'consents', 'personal_agents', 'autopilot_posts', 'portrait_jobs', 'outreach_items', 'subscriptions'];
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
