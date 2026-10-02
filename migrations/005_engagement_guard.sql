-- Проверка «цель принадлежит другому клиенту агентства» должна работать и для ролей,
-- которым RLS не показывает чужих клиентов. Функция возвращает только boolean.
CREATE OR REPLACE FUNCTION target_is_other_managed_account(p_agency uuid, p_account uuid, p_url text, p_author text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM managed_accounts a JOIN clients c ON c.id = a.client_id
     WHERE c.agency_id = p_agency AND a.id <> p_account
       AND ((a.profile_url IS NOT NULL AND p_url LIKE a.profile_url || '%')
         OR (p_author IS NOT NULL AND lower(regexp_replace(p_author, '[^[:alnum:]]+', ' ', 'g')) = lower(regexp_replace(a.display_name, '[^[:alnum:]]+', ' ', 'g'))))
  )
$$;
GRANT EXECUTE ON FUNCTION target_is_other_managed_account(uuid, uuid, text, text) TO app_user;
