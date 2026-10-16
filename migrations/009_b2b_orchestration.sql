-- B2B-оркестрация: руководитель компании, сотрудники, агенты, миссии, безопасность аккаунтов.
-- Решения по итогам шести аудитов: docs/b2b-audits-2026-10-16.md.

-- Роль руководителя компании клиента: только на клиента, никогда на агентство или аккаунт.
ALTER TABLE memberships DROP CONSTRAINT IF EXISTS memberships_role_check;
ALTER TABLE memberships ADD CONSTRAINT memberships_role_check CHECK (role IN ('owner','ops_director','strategist','account_manager','author','designer','editor','community_manager','analyst','client','auditor','client_admin'));
ALTER TABLE memberships ADD CONSTRAINT memberships_client_admin_scope CHECK (role <> 'client_admin' OR (scope_client_id IS NOT NULL AND scope_account_id IS NULL));

-- Согласие хранит, кто его дал (пользователь платформы), а не только имя.
ALTER TABLE consents ADD COLUMN granted_by_user_id uuid REFERENCES users(id);

-- Аварийная остановка активности компании: ставит руководитель или агентство, снимает только агентство.
ALTER TABLE clients ADD COLUMN engagement_paused_at timestamptz, ADD COLUMN engagement_paused_by uuid REFERENCES users(id), ADD COLUMN engagement_paused_reason text;

-- Бриф компании с версиями: правку руководителя утверждает агентство.
CREATE TABLE company_briefs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  version int NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded','rejected')),
  industry text NOT NULL DEFAULT 'general' CHECK (industry IN ('general','crypto','fin','health')),
  positioning text NOT NULL DEFAULT '',
  topics jsonb NOT NULL DEFAULT '[]',              -- [{tag, weight, keywords[]}]
  forbidden_topics text[] NOT NULL DEFAULT '{}',
  disclosure_mode text NOT NULL DEFAULT 'profile' CHECK (disclosure_mode IN ('profile','inline')),
  disclosure_text text NOT NULL DEFAULT '#employee',
  disclaimers jsonb NOT NULL DEFAULT '{}',          -- {"UK": "...", "AE": "..."}
  licenses jsonb NOT NULL DEFAULT '[]',             -- [{regulator, number, jurisdiction}]
  target_countries text[] NOT NULL DEFAULT '{}',
  compliance_owner text,
  compliance_approved_at timestamptz,
  compliance_ref text,
  intensity text NOT NULL DEFAULT 'low' CHECK (intensity IN ('low','normal')),
  email_domains text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, version)
);

-- Профиль участия сотрудника: экспертиза, частота, подтверждение трудоустройства. Видит владелец и команда агентства.
CREATE TABLE employee_profiles (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  expertise_tags text[] NOT NULL DEFAULT '{}',
  expertise_confirmed_by uuid REFERENCES users(id),
  expertise_confirmed_at timestamptz,
  frequency text NOT NULL DEFAULT 'weekly' CHECK (frequency IN ('weekly','biweekly','paused')),
  paused_until timestamptz,
  self_reported_activity text CHECK (self_reported_activity IN ('rare','weekly','daily')),
  notify_email boolean NOT NULL DEFAULT true,
  employment_verified_at timestamptz,
  employment_verified_by uuid REFERENCES users(id),
  verification_method text CHECK (verification_method IN ('email_domain','hr_confirmation')),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Состояние безопасности аккаунта: разгон, охлаждение, половинные лимиты, исключение.
CREATE TABLE account_safety (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  ramp_started_at timestamptz NOT NULL DEFAULT now(),
  cooldown_until timestamptz,
  half_until timestamptz,
  excluded boolean NOT NULL DEFAULT false,
  excluded_reason text,
  api_forbidden_streak int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE safety_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('warning','captcha','restriction','identity_check','throttled','comment_hidden','api_forbidden','token_revoked','restored','excluded')),
  source text NOT NULL CHECK (source IN ('owner','agency','api','system')),
  note text,
  reported_by uuid REFERENCES users(id),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  effects jsonb NOT NULL DEFAULT '{}',
  dedupe_key text UNIQUE
);
CREATE INDEX safety_events_account_idx ON safety_events(account_id, occurred_at DESC);

CREATE TABLE agent_missions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  created_by uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('amplify_post','company_news','discussion','tech_breakdown','engineering_blog','open_source','event_talk','hiring')),
  title text NOT NULL,
  objective text NOT NULL DEFAULT '',
  target_url text,
  target_content_item_id uuid REFERENCES content_items(id),
  target_is_company_post boolean NOT NULL DEFAULT false,
  target_published_at timestamptz,
  target_excerpt text,
  topic_tags text[] NOT NULL DEFAULT '{}',
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  max_participants int NOT NULL DEFAULT 5,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','active','completed','cancelled','blocked')),
  plan_summary jsonb NOT NULL DEFAULT '{}',
  blocked_reasons text[] NOT NULL DEFAULT '{}',
  cancel_reason text,
  idem_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, idem_key),
  CHECK (window_end > window_start)
);
CREATE INDEX agent_missions_client_idx ON agent_missions(client_id, status);

CREATE TABLE mission_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mission_id uuid NOT NULL REFERENCES agent_missions(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('react','comment','repost_note','post')),
  reaction_type text,
  proposed_text text,
  ai_drafted boolean NOT NULL DEFAULT false,
  ai_execution_id uuid,
  final_text text,
  approved_text_sha256 text,
  relevance numeric(4,3),
  rationale text,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  scheduled_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_owner' CHECK (status IN ('awaiting_owner','approved','executing','done','skipped','rejected','blocked','expired','unknown')),
  veto_codes text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  exec_mode text NOT NULL DEFAULT 'assisted' CHECK (exec_mode IN ('api','assisted')),
  external_id text,
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  done_at timestamptz,
  content_item_id uuid REFERENCES content_items(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mission_id, account_id, kind)
);
CREATE INDEX mission_actions_account_idx ON mission_actions(account_id, scheduled_at);
CREATE INDEX mission_actions_status_idx ON mission_actions(status, scheduled_at);
CREATE INDEX mission_actions_target_idx ON mission_actions(mission_id, scheduled_at);

-- Журнал агентов: без текстов чужих постов и промптов, только решения, коды вето и хеши.
CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id),
  mission_id uuid REFERENCES agent_missions(id) ON DELETE SET NULL,
  agent text NOT NULL,
  trigger_key text NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','ok','error','skipped')),
  decisions jsonb NOT NULL DEFAULT '{}',
  input_hash text,
  model text,
  prompt_version text,
  cost_usd numeric(12,6),
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (agent, trigger_key)
);
CREATE INDEX agent_runs_client_idx ON agent_runs(client_id, agent, started_at DESC);

-- Приглашения сотрудников: токен хранится только хешем, одноразовый, 72 часа.
CREATE TABLE employee_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid NOT NULL REFERENCES clients(id),
  email text NOT NULL,
  display_name text NOT NULL,
  title text,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  user_id uuid REFERENCES users(id),
  account_id uuid REFERENCES managed_accounts(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS v4: таблицы «по владельцу» и новые внутренние таблицы.
CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  full_ids text := 'SELECT unnest(app_client_ids())';
  acc_ids text := 'SELECT unnest(app_account_ids())';
  part_ids text := 'SELECT unnest(app_partial_client_ids())';
  scope_expr text;
  internal_only text[] := ARRAY['tasks', 'time_entries', 'workflow_runs', 'workflow_definitions', 'incidents', 'deletion_runs', 'strategy_recommendations', 'experiments', 'profile_audits', 'agent_runs', 'employee_invites'];
  -- Персональные данные участия сотрудника: вне агентства видит только владелец аккаунта, руководитель компании получает агрегаты через сервис.
  owner_scoped text[] := ARRAY['mission_actions', 'safety_events', 'account_safety', 'employee_profiles', 'consents'];
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
