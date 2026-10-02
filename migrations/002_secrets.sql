-- Зашифрованное хранилище токенов (AES-256-GCM, ключ вне БД: SECRETS_KEY / KMS).
-- В production рекомендуется внешний менеджер секретов; таблица — совместимый fallback.
CREATE TABLE encrypted_secrets (
  ref text PRIMARY KEY,
  iv bytea NOT NULL,
  tag bytea NOT NULL,
  ciphertext bytea NOT NULL,
  key_version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
