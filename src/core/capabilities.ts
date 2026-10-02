/**
 * Реестр возможностей. Режим операции определяется пересечением трёх фактов:
 * 1) что LinkedIn в принципе предлагает (матрица, docs/linkedin-capability-matrix.md);
 * 2) какие продукты реально одобрены нашему приложению (конфигурация, не документация);
 * 3) какие scopes фактически выдал пользователь при OAuth.
 * Если хоть одно не подтверждено, операция уходит в assisted/manual_import.
 */
export type Mode = "api" | "assisted" | "manual_import" | "unavailable";
export type AccountKind = "executive" | "founder" | "expert" | "employee" | "job_seeker" | "company_page";

export interface CapabilitySpec {
  operation: string;
  label: string;
  appliesTo: "member" | "organization" | "both";
  product: string | null;
  permission: string | null;
  needsLinkedInApproval: boolean;
  fallback: Exclude<Mode, "api">;
  fallbackText: string;
}

export const CAPABILITY_CATALOG: CapabilitySpec[] = [
  { operation: "connect_profile", label: "Подключение профиля", appliesTo: "member", product: "Sign In with LinkedIn using OpenID Connect", permission: "openid profile", needsLinkedInApproval: false, fallback: "assisted", fallbackText: "Ведение без подключения: assisted-процессы" },
  { operation: "publish_post_member", label: "Публикация в личный профиль", appliesTo: "member", product: "Share on LinkedIn", permission: "w_member_social", needsLinkedInApproval: false, fallback: "assisted", fallbackText: "Задача владельцу: готовый текст и медиа, ручная публикация, отметка ссылки" },
  { operation: "publish_post_org", label: "Публикация на странице компании", appliesTo: "organization", product: "Community Management API", permission: "w_organization_social", needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Задача администратору страницы с готовым материалом" },
  { operation: "read_own_posts", label: "Получение собственных публикаций", appliesTo: "both", product: "Community Management API", permission: "r_member_social / r_organization_social", needsLinkedInApproval: true, fallback: "manual_import", fallbackText: "Ручное внесение ссылок на публикации" },
  { operation: "post_analytics", label: "Аналитика публикаций", appliesTo: "both", product: "Community Management API", permission: "r_member_postAnalytics / r_organization_social", needsLinkedInApproval: true, fallback: "manual_import", fallbackText: "Импорт выгрузки или ручной ввод с указанием источника" },
  { operation: "follower_analytics", label: "Аналитика профиля и подписчиков", appliesTo: "both", product: "Community Management API", permission: "r_member_profileAnalytics / r_organization_followers", needsLinkedInApproval: true, fallback: "manual_import", fallbackText: "Ручной ввод снимка с датой наблюдения" },
  { operation: "read_comments", label: "Чтение комментариев и реакций", appliesTo: "both", product: "Community Management API", permission: "r_member_social / r_organization_social", needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Менеджер добавляет комментарии в очередь вручную" },
  { operation: "write_comments", label: "Создание комментариев и реакций", appliesTo: "both", product: "Community Management API", permission: "w_member_social / w_organization_social", needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Согласованный текст и ссылка; действие выполняет человек" },
  { operation: "manage_org_page", label: "Управление страницей компании", appliesTo: "organization", product: "Community Management API", permission: "rw_organization_admin", needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Задачи администратору страницы" },
  { operation: "page_messages", label: "Сообщения страниц", appliesTo: "organization", product: "нет подтверждённого публичного продукта", permission: null, needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Ручная обработка с фиксацией результата" },
  { operation: "direct_messages", label: "Личные сообщения", appliesTo: "member", product: null, permission: null, needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Только ручная работа владельца; платформа не синхронизирует переписку" },
  { operation: "invitations", label: "Приглашения в контакты", appliesTo: "member", product: null, permission: null, needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Задача владельцу; результат отмечается вручную" },
  { operation: "edit_profile", label: "Изменение профиля", appliesTo: "member", product: null, permission: null, needsLinkedInApproval: true, fallback: "assisted", fallbackText: "Задачи владельцу с готовыми текстами по итогам аудита" },
  { operation: "outgoing_reactions_history", label: "История исходящих реакций", appliesTo: "member", product: null, permission: null, needsLinkedInApproval: true, fallback: "unavailable", fallbackText: "Платформа видит только действия, прошедшие через неё или отмеченные вручную" },
];

export interface AppAccess {
  /** Продукты, одобренные НАШЕМУ приложению (подтверждается в Developer Portal). */
  approvedProducts: string[];
  apiVersion: string;
}

export interface AccountContext {
  kind: AccountKind;
  connectionStatus: "active" | "expiring" | "expired" | "revoked" | "error" | "none";
  grantedScopes: string[];
}

export interface ResolvedCapability {
  operation: string;
  label: string;
  mode: Mode;
  permission: string | null;
  access_basis: string | null;
  api_version: string | null;
  unavailable_reason: string | null;
  alternative: string;
}

export function resolveCapabilities(acc: AccountContext, app: AppAccess): ResolvedCapability[] {
  const isOrg = acc.kind === "company_page";
  return CAPABILITY_CATALOG.filter((c) => c.appliesTo === "both" || (c.appliesTo === "organization") === isOrg).map((c) => {
    const base = { operation: c.operation, label: c.label, permission: c.permission, alternative: c.fallbackText, api_version: null as string | null, access_basis: null as string | null };
    let reason: string | null = null;
    if (!c.product || !c.permission) reason = "LinkedIn не предоставляет подтверждённого API для этой операции";
    else if (!app.approvedProducts.includes(c.product)) reason = c.needsLinkedInApproval ? `Продукт «${c.product}» требует одобрения LinkedIn и не подтверждён для нашего приложения` : `Продукт «${c.product}» не добавлен в приложение`;
    else if (acc.connectionStatus !== "active" && acc.connectionStatus !== "expiring") reason = acc.connectionStatus === "none" ? "Аккаунт не подключён через OAuth" : `Подключение в статусе ${acc.connectionStatus}`;
    else {
      const needed = c.permission.split(/[\s/]+/).filter((s) => /^[a-z_A-Z]+$/.test(s));
      const ok = c.permission.includes("/") ? needed.some((s) => acc.grantedScopes.includes(s)) : needed.every((s) => acc.grantedScopes.includes(s));
      if (!ok) reason = `Пользователь не выдал разрешение ${c.permission}`;
    }
    if (reason) return { ...base, mode: c.fallback, unavailable_reason: reason };
    return { ...base, mode: "api" as Mode, unavailable_reason: null, api_version: app.apiVersion, access_basis: `${c.product}; scopes: ${acc.grantedScopes.join(" ")}` };
  });
}

export function appAccessFromEnv(env = process.env): AppAccess {
  return {
    approvedProducts: (env.LINKEDIN_APPROVED_PRODUCTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    apiVersion: env.LINKEDIN_API_VERSION ?? "202608",
  };
}
