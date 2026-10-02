-- Модули этапов 2–5: уведомления, медиа, взаимодействия, сценарии, аудит профиля,
-- улучшение стратегии, эксперименты, экспорты, SLA, бюджеты AI.

ALTER TABLE clients
  ADD COLUMN ai_budget_usd_month numeric(10,2),
  ADD COLUMN approval_sla_hours int NOT NULL DEFAULT 48,
  ADD COLUMN offboarding_started_at timestamptz;

ALTER TABLE content_items
  ADD COLUMN planned_for timestamptz,
  ADD COLUMN format text NOT NULL DEFAULT 'text' CHECK (format IN ('text','image','multi_image','document','video','article')),
  ADD COLUMN campaign text;
CREATE INDEX content_items_planned ON content_items(account_id, planned_for) WHERE planned_for IS NOT NULL;

ALTER TABLE media_assets
  ADD COLUMN original_name text,
  ADD COLUMN width int,
  ADD COLUMN height int,
  ADD COLUMN external_urn text,
  ADD COLUMN uploaded_by uuid REFERENCES users(id),
  ADD COLUMN scan_detail text;
CREATE UNIQUE INDEX media_assets_dedupe ON media_assets(account_id, sha256);

ALTER TABLE ai_executions
  ADD COLUMN tokens_in int,
  ADD COLUMN tokens_out int,
  ADD COLUMN latency_ms int,
  ADD COLUMN quality jsonb,
  ADD COLUMN edit_ratio numeric(5,4),
  ADD COLUMN decided_at timestamptz;

ALTER TABLE incidents
  ADD COLUMN owner_id uuid REFERENCES users(id),
  ADD COLUMN resolution text;

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  link text,
  dedupe_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  delivered_at timestamptz
);
CREATE INDEX notifications_user_idx ON notifications(user_id, created_at DESC) WHERE read_at IS NULL;

-- Утверждённый клиентом список профессиональных источников для взаимодействий.
CREATE TABLE engagement_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  label text NOT NULL,
  url text NOT NULL,
  approved_by_name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE engagement_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  target_url text NOT NULL,
  target_author text,
  target_excerpt text,
  source text NOT NULL CHECK (source IN ('manager_added','approved_source_list','integration','inbound')),
  action_type text NOT NULL CHECK (action_type IN ('comment','react','reply')),
  relevance numeric(4,3) NOT NULL,
  audience_fit numeric(4,3) NOT NULL,
  contribution_value numeric(4,3) NOT NULL,
  timeliness numeric(4,3) NOT NULL,
  priority numeric(5,4),
  block_reasons text[] NOT NULL DEFAULT '{}',
  rationale text NOT NULL,
  proposed_comment text,
  fact_source_ids uuid[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','blocked','approved','rejected','executed','expired')),
  execution_mode text CHECK (execution_mode IN ('api','assisted')),
  approver_id uuid REFERENCES users(id),
  approved_at timestamptz,
  executed_by uuid REFERENCES users(id),
  executed_at timestamptz,
  action_record_id uuid REFERENCES action_records(id),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX engagement_queue ON engagement_recommendations(account_id, status, priority DESC);

-- Конструктор сценариев: событие → условия → внутренние действия → согласование → внешнее действие.
CREATE TABLE workflow_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  owner_id uuid REFERENCES users(id),
  version int NOT NULL DEFAULT 1,
  trigger text NOT NULL,
  conditions jsonb NOT NULL DEFAULT '[]',
  actions jsonb NOT NULL DEFAULT '[]',
  max_runs_per_day int NOT NULL DEFAULT 200,
  enabled boolean NOT NULL DEFAULT true,
  is_builtin boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agency_id, key, version)
);

CREATE TABLE workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  workflow_id uuid NOT NULL REFERENCES workflow_definitions(id) ON DELETE CASCADE,
  event_key text NOT NULL,
  depth int NOT NULL DEFAULT 0,
  mode text NOT NULL CHECK (mode IN ('execute','preview')),
  status text NOT NULL CHECK (status IN ('executed','skipped','limited','loop_blocked','failed','preview')),
  actions_taken jsonb NOT NULL DEFAULT '[]',
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, event_key, mode)
);
CREATE INDEX workflow_runs_recent ON workflow_runs(workflow_id, created_at DESC);

CREATE TABLE profile_audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  criteria jsonb NOT NULL,
  summary text,
  tasks_created int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE strategy_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  observation text NOT NULL,
  data_used jsonb NOT NULL,
  limitations text[] NOT NULL DEFAULT '{}',
  hypothesis text NOT NULL,
  proposed_change text NOT NULL,
  expected_signal text NOT NULL,
  review_at date NOT NULL,
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','rejected')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, week_start, proposed_change)
);

CREATE TABLE experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  recommendation_id uuid REFERENCES strategy_recommendations(id),
  kind text NOT NULL DEFAULT 'sequential' CHECK (kind IN ('sequential')),
  hypothesis text NOT NULL,
  change text NOT NULL,
  metric_key text NOT NULL,
  expected_signal text NOT NULL,
  start_date date NOT NULL,
  review_date date NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','supported','not_supported','inconclusive','stopped')),
  conclusion text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  account_id uuid REFERENCES managed_accounts(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('content','actions','metrics','tasks','time')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','ready','failed','expired')),
  storage_key text,
  row_count int,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  expires_at timestamptz
);

-- Журнал выполнения процедуры удаления данных клиента (без содержимого).
CREATE TABLE deletion_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_ref uuid NOT NULL,
  client_name_hash text NOT NULL,
  requested_by uuid REFERENCES users(id),
  steps jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL CHECK (status IN ('running','completed','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
