-- Автопилот сотрудника: личный агент, паспорт голоса, прогрев 30 дней, посты через официальный Posts API
-- по постоянному согласию владельца с окном отмены, портреты по своим фотографиям, Telegram в одно касание.
-- Решения и аудиты: docs/autopilot.md, docs/autopilot-audits-2026-10-16.md.

-- Новые виды согласий: автопилот постов и обработка своих фотографий для портрета.
ALTER TABLE consents DROP CONSTRAINT IF EXISTS consents_action_scope_check;
ALTER TABLE consents ADD CONSTRAINT consents_action_scope_check CHECK (action_scope IN ('publish_post','comment','react','analytics_read','profile_edit_tasks','ai_processing','autopilot_posts','likeness_processing'));
-- Условия согласия, которые видел владелец: окно отмены, версия паспорта, проверка компанией.
ALTER TABLE consents ADD COLUMN terms jsonb NOT NULL DEFAULT '{}';

-- Проверка постов автопилота компанией до публикации. Для crypto и fin обязательна.
ALTER TABLE company_briefs ADD COLUMN autopilot_review text NOT NULL DEFAULT 'auto' CHECK (autopilot_review IN ('auto','company'));

-- Назначение файла: исходные фото для портрета не прикрепляются к постам и удаляются после генерации.
ALTER TABLE media_assets ADD COLUMN purpose text NOT NULL DEFAULT 'content' CHECK (purpose IN ('content','portrait_source','portrait','post_image')),
  ADD COLUMN ai_generated boolean NOT NULL DEFAULT false;

CREATE TABLE personal_agents (
  account_id uuid PRIMARY KEY REFERENCES managed_accounts(id) ON DELETE CASCADE,
  client_id uuid NOT NULL REFERENCES clients(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role_key text,
  onboarding_step text NOT NULL DEFAULT 'role' CHECK (onboarding_step IN ('role','interview','passport','photos','autopilot','done')),
  interview jsonb NOT NULL DEFAULT '{}',
  interview_source_id uuid REFERENCES knowledge_sources(id) ON DELETE SET NULL,
  passport jsonb,
  passport_version int NOT NULL DEFAULT 0,
  passport_hash text,
  passport_confirmed_at timestamptz,
  autopilot text NOT NULL DEFAULT 'off' CHECK (autopilot IN ('off','on','paused')),
  autopilot_paused_until timestamptz,
  veto_hours int NOT NULL DEFAULT 24 CHECK (veto_hours BETWEEN 4 AND 72),
  images_enabled boolean NOT NULL DEFAULT true,
  budget_usd_month numeric(10,2) NOT NULL DEFAULT 15 CHECK (budget_usd_month >= 0 AND budget_usd_month <= 200),
  spent_month text,
  spent_usd numeric(12,6) NOT NULL DEFAULT 0,
  telegram_chat_id text UNIQUE,
  telegram_link_hash text UNIQUE,
  telegram_link_expires timestamptz,
  telegram_linked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE autopilot_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('post','company_news')),
  slot_key text NOT NULL,
  topic_tag text,
  topic_title text,
  source_url text,
  source_content_item_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  publish_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','needs_owner','review','veto_window','scheduled','published','vetoed','blocked','expired','failed')),
  content_item_id uuid REFERENCES content_items(id) ON DELETE SET NULL,
  body text,
  body_sha256 text,
  media_id uuid REFERENCES media_assets(id) ON DELETE SET NULL,
  ai_execution_id uuid,
  cost_usd numeric(12,6),
  veto_codes text[] NOT NULL DEFAULT '{}',
  warnings text[] NOT NULL DEFAULT '{}',
  review_required boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES users(id),
  reviewed_at timestamptz,
  review_comment text,
  owner_action text CHECK (owner_action IN ('vetoed','published_now','edited','approved')),
  owner_action_at timestamptz,
  consent_id uuid REFERENCES consents(id),
  external_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, slot_key)
);
CREATE INDEX autopilot_posts_due_idx ON autopilot_posts(status, publish_at);
CREATE INDEX autopilot_posts_client_idx ON autopilot_posts(client_id, publish_at);

CREATE TABLE portrait_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'collecting' CHECK (status IN ('collecting','queued','generating','ready','chosen','failed','cancelled')),
  style text NOT NULL DEFAULT 'studio' CHECK (style IN ('studio','office','outdoor')),
  source_media_ids uuid[] NOT NULL DEFAULT '{}',
  result_media_ids uuid[] NOT NULL DEFAULT '{}',
  banner_media_id uuid,
  chosen_media_id uuid,
  provider text,
  model text,
  cost_usd numeric(12,6),
  error text,
  consent_id uuid REFERENCES consents(id),
  created_by uuid REFERENCES users(id),
  sources_purged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portrait_jobs_account_idx ON portrait_jobs(account_id, created_at DESC);

-- Исходящие сообщения Telegram: доступны только агентству и исполнителю.
CREATE TABLE telegram_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  buttons jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','cancelled')),
  attempts int NOT NULL DEFAULT 0,
  error text,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX telegram_outbox_pending_idx ON telegram_outbox(status, created_at);

CREATE OR REPLACE FUNCTION apply_rls() RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  t record;
  full_ids text := 'SELECT unnest(app_client_ids())';
  acc_ids text := 'SELECT unnest(app_account_ids())';
  part_ids text := 'SELECT unnest(app_partial_client_ids())';
  scope_expr text;
  internal_only text[] := ARRAY['tasks', 'time_entries', 'workflow_runs', 'workflow_definitions', 'incidents', 'deletion_runs', 'strategy_recommendations', 'experiments', 'profile_audits', 'agent_runs', 'employee_invites', 'telegram_outbox'];
  -- Персональные данные участия сотрудника: вне агентства видит только владелец аккаунта, руководитель компании получает агрегаты через сервис.
  owner_scoped text[] := ARRAY['mission_actions', 'safety_events', 'account_safety', 'employee_profiles', 'consents', 'personal_agents', 'autopilot_posts', 'portrait_jobs'];
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
