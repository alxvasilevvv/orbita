# Матрица возможностей LinkedIn

Дата проверки: **2026-10-02**. Метод: официальная документация Microsoft Learn и справка LinkedIn, найденные веб-поиском; Developer Portal нашего приложения не проверялся, поэтому столбец «Подтверждена для нашего приложения» везде «нет / требует проверки». Наличие документации не означает, что доступ выдан нашему приложению; разрешение на запись не означает права читать историю действий.

| Возможность | Тип аккаунта | Продукт / API | Разрешение | Одобрение LinkedIn | Подтверждена для нас | Альтернатива в платформе |
|---|---|---|---|---|---|---|
| Подключение профиля | Участник | Sign In with LinkedIn using OpenID Connect | `openid profile` | Нет (self-serve) | Требует проверки | Assisted без подключения |
| Публикация текста и медиа | Участник | Share on LinkedIn, Posts API `/rest/posts`, Images API | `w_member_social` | Нет (self-serve) | Требует проверки | Assisted-задача владельцу, ручная отметка ссылки |
| Публикация на странице | Организация | Community Management API, Posts API | `w_organization_social` | Да (Development → Standard tier) | Нет | Assisted: администратор страницы |
| Получение собственных публикаций | Участник / организация | Community Management API | `r_member_social` (ограниченный) / `r_organization_social` | Да | Нет | Ручное внесение ссылок |
| Аналитика публикаций | Участник / организация | Community Management API (member post analytics, organization share statistics) | `r_member_postAnalytics` / `r_organization_social` | Да | Нет | Импорт выгрузки, ручной ввод с источником |
| Аналитика профиля и подписчиков | Участник / организация | Community Management API (follower statistics) | `r_member_profileAnalytics` / `r_organization_followers` | Да | Нет | Ручной снимок с датой наблюдения |
| Чтение комментариев и реакций | Участник / организация | Community Management API (socialActions, reactions) | `r_member_social` / `r_organization_social` | Да | Нет | Менеджер добавляет вручную |
| Создание комментариев и реакций | Участник / организация | Community Management API | `w_member_social` / `w_organization_social` | Да для организаций; для участника требует проверки | Нет | Согласованный текст, действие выполняет человек |
| Управление страницей | Организация | Community Management API (organizations) | `rw_organization_admin` | Да | Нет | Задачи администратору |
| Сообщения страниц | Организация | Публичного продукта не найдено |: |: | Нет | Ручная обработка |
| Личные сообщения | Участник | Публичного API нет |: |: | Нет | Только сам владелец; синхронизации нет |
| Приглашения в контакты | Участник | Публичного API нет |: |: | Нет | Задача владельцу |
| Изменение профиля | Участник | Публичного API нет |: |: | Нет | Задачи владельцу с готовыми текстами по аудиту |
| История исходящих реакций | Участник | Публичного API нет |: |: | Нет | Недоступно: видим только действия через платформу |

## Источники

- [Getting Access to LinkedIn APIs](https://learn.microsoft.com/en-us/linkedin/shared/authentication/getting-access)
- [Share on LinkedIn](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/share-on-linkedin): `w_member_social`, self-serve
- [Community Management overview](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview): vetted product, Development и Standard tier, Standard требует скринкаст по каждому сценарию; Development tier запрашивается только новым приложением без других продуктов
- [Increasing Access](https://learn.microsoft.com/en-us/linkedin/marketing/increasing-access): Development tier рассчитан на построение и тест интеграции в течение 12 месяцев
- [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api): `/rest/posts`, заголовки `LinkedIn-Version`, `X-Restli-Protocol-Version`, идентификатор в `x-restli-id`
- [API Rate Limiting](https://learn.microsoft.com/en-us/linkedin/shared/api-guide/concepts/rate-limits): лимиты на приложение и участника по методам, сбрасываются в полночь UTC, фактические значения видны в Developer Portal
- [Prohibited software and extensions](https://www.linkedin.com/help/linkedin/answer/a1341387)
- [Marketing API Terms](https://www.linkedin.com/legal/l/marketing-api-terms): ограничения хранения и использования API-данных, сверить до использования данных в AI и CRM

## Как обновлять

1. Проверить продукты в Developer Portal приложения, записать дату.
2. Обновить `LINKEDIN_APPROVED_PRODUCTS` в окружении. Реестр возможностей пересчитается при следующей проверке аккаунта (кнопка «Проверить возможности» или подключение OAuth).
3. Обновить эту таблицу и `CAPABILITY_CATALOG` в `src/core/capabilities.ts`.
