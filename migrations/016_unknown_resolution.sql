-- Авторазрешение publication_unknown: отметка времени последней проверки, чтобы ограничить
-- частоту обращений к площадке (не чаще раза в час на материал) и не дёргать API вхолостую.
ALTER TABLE content_items ADD COLUMN unknown_checked_at timestamptz;
