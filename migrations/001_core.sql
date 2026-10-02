-- Agency LinkedIn OS: базовая схема (этап 1 + контракты этапа 2)
-- Все клиентские сущности несут client_id (и account_id, где применимо) для изоляции.
-- Время хранится в timestamptz (UTC), часовой пояс отображения хранится отдельно.

CREATE TABLE agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  locale text NOT NULL DEFAULT 'ru',
  languages text[] NOT NULL DEFAULT '{}',
  weekly_capacity_hours numeric(5,1) NOT NULL DEFAULT 40,
  internal_hourly_rate numeric(10,2),
  is_active boolean NOT NULL DEFAULT true,
  mfa_enrolled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  name text NOT NULL
);

CREATE TABLE clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id) ON DELETE RESTRICT,
  name text NOT NULL,
  contract_ref text,
  service_package text,
  monthly_fee numeric(12,2),
  team_id uuid REFERENCES teams(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('onboarding','active','paused','offboarding','closed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX clients_agency_idx ON clients(agency_id);

-- Роль назначается на уровне agency / client / account. scope_client_id и scope_account_id
-- задают границу; NULL означает «всё агентство» (только для внутренних ролей).
CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  agency_id uuid NOT NULL REFERENCES agencies(id),
  role text NOT NULL CHECK (role IN ('owner','ops_director','strategist','account_manager','author','designer','editor','community_manager','analyst','client','auditor')),
  scope_client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  scope_account_id uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memberships_user_idx ON memberships(user_id) WHERE revoked_at IS NULL;

CREATE TABLE managed_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('executive','founder','expert','employee','job_seeker','company_page')),
  display_name text NOT NULL,
  profile_url text,
  primary_language text NOT NULL DEFAULT 'en',
  extra_languages text[] NOT NULL DEFAULT '{}',
  timezone text NOT NULL,
  audience_geo text[] NOT NULL DEFAULT '{}',
  manager_id uuid REFERENCES users(id),
  confidential_job_search boolean NOT NULL DEFAULT false,
  publishing_paused boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'onboarding' CHECK (status IN ('onboarding','active','paused','offboarded')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX managed_accounts_client_idx ON managed_accounts(client_id);
ALTER TABLE memberships ADD CONSTRAINT memberships_account_fk FOREIGN KEY (scope_account_id) REFERENCES managed_accounts(id) ON DELETE CASCADE;

CREATE TABLE account_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  responsibility text NOT NULL,
  UNIQUE (account_id, user_id, responsibility)
);

-- Согласие владельца ресурса на конкретный вид действий. Договор с компанией не даёт
-- согласия за сотрудника: согласие привязано к аккаунту и подписанту.
CREATE TABLE consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  action_scope text NOT NULL CHECK (action_scope IN ('publish_post','comment','react','analytics_read','profile_edit_tasks','ai_processing')),
  granted_by_name text NOT NULL,
  evidence_ref text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  paused_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX consents_account_idx ON consents(account_id, action_scope);

-- Токены хранятся только в менеджере секретов; здесь ссылка на секрет.
CREATE TABLE oauth_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'linkedin',
  external_subject text NOT NULL,
  granted_scopes text[] NOT NULL DEFAULT '{}',
  secret_ref text NOT NULL,
  expires_at timestamptz,
  status text NOT NULL CHECK (status IN ('active','expiring','expired','revoked','error')),
  connected_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oauth_connections_account_idx ON oauth_connections(account_id);

CREATE TABLE capability_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  operation text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('api','assisted','manual_import','unavailable')),
  permission text,
  access_basis text,
  api_version text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  unavailable_reason text,
  alternative text,
  source text NOT NULL
);
CREATE INDEX capability_snapshots_lookup ON capability_snapshots(account_id, operation, checked_at DESC);

CREATE TABLE strategy_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  version int NOT NULL,
  template text NOT NULL,
  playbook jsonb NOT NULL,
  brand_voice jsonb NOT NULL DEFAULT '{}',
  restrictions jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','superseded')),
  change_reason text,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, version)
);

CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  title text NOT NULL,
  kind text NOT NULL,
  body text NOT NULL,
  usage_rights text NOT NULL DEFAULT 'internal_and_ai' CHECK (usage_rights IN ('internal_only','internal_and_ai')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verified_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  statement text NOT NULL,
  source_id uuid REFERENCES knowledge_sources(id),
  confirmed_by text NOT NULL,
  valid_as_of date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE content_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE RESTRICT,
  title text NOT NULL,
  objective text,
  pillar text,
  state text NOT NULL DEFAULT 'idea',
  current_version_id uuid,
  approved_version_id uuid,
  scheduled_at timestamptz,
  scheduled_tz text,
  author_id uuid REFERENCES users(id),
  row_version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_items_account_state ON content_items(account_id, state);
CREATE INDEX content_items_scheduled ON content_items(scheduled_at) WHERE state = 'scheduled';

CREATE TABLE content_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  version int NOT NULL,
  body text NOT NULL,
  media_ids uuid[] NOT NULL DEFAULT '{}',
  target_account_id uuid NOT NULL REFERENCES managed_accounts(id),
  content_hash text NOT NULL,
  internal_notes jsonb NOT NULL DEFAULT '[]',
  created_by uuid REFERENCES users(id),
  origin text NOT NULL DEFAULT 'human' CHECK (origin IN ('human','ai_draft')),
  ai_execution_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id, version)
);

CREATE TABLE media_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  bytes bigint NOT NULL,
  sha256 text NOT NULL,
  scan_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
  content_version_id uuid NOT NULL REFERENCES content_versions(id),
  content_hash text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('editorial','client')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','changes_requested','invalidated')),
  requested_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  approval_request_id uuid NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  decided_by uuid NOT NULL REFERENCES users(id),
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested')),
  comment text,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publication_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  content_version_id uuid NOT NULL REFERENCES content_versions(id),
  idempotency_key text NOT NULL UNIQUE,
  mode text NOT NULL CHECK (mode IN ('api','assisted')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','succeeded','failed','unknown','dead','cancelled','awaiting_human')),
  run_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  lease_owner text,
  lease_until timestamptz,
  last_error_code text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX publication_jobs_due ON publication_jobs(run_at) WHERE status IN ('queued','leased');

CREATE TABLE external_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  content_item_id uuid NOT NULL REFERENCES content_items(id),
  publication_job_id uuid REFERENCES publication_jobs(id),
  external_id text,
  url text,
  evidence_type text NOT NULL CHECK (evidence_type IN ('api_confirmed','manual_mark','unconfirmed')),
  published_at timestamptz,
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (content_item_id)
);

CREATE TABLE action_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  actor uuid REFERENCES users(id),
  action_type text NOT NULL,
  target text,
  origin text NOT NULL CHECK (origin IN ('platform_api','platform_assisted','manual_mark','integration_observed')),
  approval_id uuid,
  requested_at timestamptz NOT NULL DEFAULT now(),
  executed_at timestamptz,
  status text NOT NULL,
  external_id text,
  evidence_type text NOT NULL CHECK (evidence_type IN ('api_confirmed','manual_mark','unconfirmed')),
  error_code text
);
CREATE INDEX action_records_account_idx ON action_records(account_id, requested_at DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid REFERENCES managed_accounts(id),
  type text NOT NULL,
  title text NOT NULL,
  details text,
  assignee_id uuid REFERENCES users(id),
  due_at timestamptz,
  estimate_minutes int,
  depends_on uuid[] NOT NULL DEFAULT '{}',
  definition_of_done text,
  links jsonb NOT NULL DEFAULT '[]',
  priority numeric(5,4),
  priority_reason text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','blocked','done','cancelled')),
  source_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX tasks_assignee_idx ON tasks(assignee_id, status);
CREATE INDEX tasks_account_idx ON tasks(account_id, status);
CREATE UNIQUE INDEX tasks_source_unique ON tasks(source_ref) WHERE source_ref IS NOT NULL AND status NOT IN ('done','cancelled');

CREATE TABLE metric_definitions (
  key text PRIMARY KEY,
  name text NOT NULL,
  unit text NOT NULL,
  nature text NOT NULL CHECK (nature IN ('periodic','cumulative','point_in_time')),
  definition text NOT NULL,
  definition_version int NOT NULL DEFAULT 1,
  is_platform_defined boolean NOT NULL DEFAULT false
);

CREATE TABLE metric_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  content_item_id uuid REFERENCES content_items(id),
  metric_key text NOT NULL REFERENCES metric_definitions(key),
  value numeric,
  period_start timestamptz,
  period_end timestamptz,
  observed_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('linkedin_api','manual_import','manual_entry','client_crm')),
  source_detail text,
  definition_version int NOT NULL DEFAULT 1,
  availability_status text NOT NULL CHECK (availability_status IN ('available','not_available','pending','not_permitted')),
  import_batch_key text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX metric_snapshots_lookup ON metric_snapshots(account_id, metric_key, observed_at DESC);
CREATE UNIQUE INDEX metric_snapshots_import_dedupe ON metric_snapshots(import_batch_key, metric_key, account_id, coalesce(content_item_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE import_batch_key IS NOT NULL;

CREATE TABLE opportunities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  pipeline text NOT NULL CHECK (pipeline IN ('business','job_search')),
  stage text NOT NULL,
  title text NOT NULL,
  attribution text NOT NULL CHECK (attribution IN ('confirmed_click','client_mark','crm_event','manager_assumption')),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid REFERENCES managed_accounts(id),
  kind text NOT NULL CHECK (kind IN ('weekly','monthly','agency')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  body jsonb NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid REFERENCES managed_accounts(id),
  user_id uuid NOT NULL REFERENCES users(id),
  task_id uuid REFERENCES tasks(id),
  minutes int NOT NULL CHECK (minutes > 0),
  work_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id uuid NOT NULL REFERENCES agencies(id),
  client_id uuid REFERENCES clients(id),
  account_id uuid REFERENCES managed_accounts(id),
  severity text NOT NULL,
  kind text NOT NULL,
  summary text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- Аудит хранит метаданные операции, а не исходный клиентский контент.
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  agency_id uuid NOT NULL,
  client_id uuid,
  account_id uuid,
  actor_id uuid,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_client_idx ON audit_events(client_id, created_at DESC);

CREATE TABLE outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  client_id uuid,
  payload jsonb NOT NULL,
  dedupe_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX outbox_pending ON outbox(id) WHERE processed_at IS NULL;

CREATE TABLE ai_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id),
  role text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  source_ids uuid[] NOT NULL DEFAULT '{}',
  cost_usd numeric(10,4),
  output jsonb NOT NULL,
  editor_decision text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_policies (
  data_class text PRIMARY KEY,
  source text NOT NULL,
  purpose text NOT NULL,
  recipients text NOT NULL,
  retention_days int,
  deletion_procedure text NOT NULL
);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
