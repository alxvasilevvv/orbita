-- Сети: аккаунт принадлежит одной сети. X (Twitter) добавляется как второй канал поверх того же слоя.
ALTER TABLE managed_accounts ADD COLUMN network text NOT NULL DEFAULT 'linkedin' CHECK (network IN ('linkedin','x'));
CREATE INDEX managed_accounts_network_idx ON managed_accounts(network);

-- Транзитный статус публикации в X (внешний вызов вне транзакции).
ALTER TABLE autopilot_posts DROP CONSTRAINT IF EXISTS autopilot_posts_status_check;
ALTER TABLE autopilot_posts ADD CONSTRAINT autopilot_posts_status_check CHECK (status IN ('planned','needs_owner','review','veto_window','scheduled','publishing_x','published','vetoed','blocked','expired','failed'));
