-- Взаимодействия в X (Twitter) в одно касание: агент готовит ответы на целевые твиты,
-- сотрудник отправляет сам (reply) или ставит лайк (like) одним касанием через официальный X API v2.
-- Те же принципы, что для LinkedIn: сервер не действует без участия человека, потолки задаёт стратегия
-- (ответы -> недельный лимит комментариев, лайки -> недельный лимит реакций), офицер безопасности и охлаждение.
-- Строки изолированы «по аккаунту» средствами RLS (client_id + account_id): вне агентства их видит владелец.

CREATE TABLE x_engagements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id),
  account_id uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('reply','like')),
  target_tweet_id text NOT NULL,
  target_url text,
  target_author text,
  target_excerpt text,
  draft text,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','drafted','sent','skipped','blocked')),
  veto_codes text[] NOT NULL DEFAULT '{}',
  external_id text,
  week_key text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, target_tweet_id)
);
CREATE INDEX x_engagements_account_status ON x_engagements (account_id, status);
