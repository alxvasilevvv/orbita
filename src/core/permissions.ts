/**
 * Модель прав: роль назначается на уровне агентства, клиента или аккаунта,
 * операции проверяются на сервере для конкретной цели (client_id, account_id).
 */
export const ROLES = [
  "owner", "ops_director", "strategist", "account_manager", "author", "designer",
  "editor", "community_manager", "analyst", "client", "auditor",
] as const;
export type Role = (typeof ROLES)[number];

export const OPERATIONS = [
  "view", "edit_strategy", "approve_strategy", "create_content", "edit_content",
  "editorial_approve", "client_approve", "schedule", "publish", "export",
  "manage_connection", "delete", "bulk_action", "manage_team", "view_audit",
  "record_manual_action", "enter_metrics", "view_finance", "manage_tasks",
  "manage_clients", "manage_consent", "run_ai",
] as const;
export type Operation = (typeof OPERATIONS)[number];

const ALL: Operation[] = [...OPERATIONS];

export const ROLE_OPERATIONS: Record<Role, Operation[]> = {
  owner: ALL,
  ops_director: ALL.filter((o) => o !== "view_finance" && o !== "client_approve"),
  strategist: ["view", "edit_strategy", "approve_strategy", "create_content", "edit_content", "editorial_approve", "manage_tasks", "run_ai", "export"],
  account_manager: ["view", "edit_strategy", "create_content", "edit_content", "schedule", "publish", "record_manual_action", "enter_metrics", "manage_tasks", "manage_connection", "manage_consent", "export", "run_ai", "bulk_action"],
  author: ["view", "create_content", "edit_content", "run_ai"],
  designer: ["view", "edit_content"],
  editor: ["view", "edit_content", "editorial_approve", "run_ai"],
  community_manager: ["view", "record_manual_action", "manage_tasks", "run_ai"],
  analyst: ["view", "enter_metrics", "export"],
  client: ["view", "client_approve", "manage_consent"],
  auditor: ["view_audit"],
};

export interface Membership {
  role: Role;
  scope_client_id: string | null;
  scope_account_id: string | null;
  revoked_at?: string | Date | null;
}
export interface Target {
  clientId?: string | null;
  accountId?: string | null;
}

/** Применима ли роль к цели. Роль клиента никогда не бывает «на всё агентство». */
export function membershipApplies(m: Membership, t: Target): boolean {
  if (m.revoked_at) return false;
  if (m.role === "client" && !m.scope_client_id && !m.scope_account_id) return false;
  if (m.scope_account_id) return !!t.accountId && m.scope_account_id === t.accountId;
  if (m.scope_client_id) return !!t.clientId && m.scope_client_id === t.clientId;
  return true; // уровень агентства
}

export function allowedOperations(ms: Membership[], t: Target): Set<Operation> {
  const out = new Set<Operation>();
  for (const m of ms) if (membershipApplies(m, t)) ROLE_OPERATIONS[m.role].forEach((o) => out.add(o));
  return out;
}

export function can(ms: Membership[], op: Operation, t: Target): boolean {
  return allowedOperations(ms, t).has(op);
}

/** Агентские роли, видящие все клиенты (для фильтра реестра). */
export function agencyWide(ms: Membership[]): boolean {
  return ms.some((m) => !m.revoked_at && !m.scope_client_id && !m.scope_account_id && m.role !== "client" && m.role !== "auditor");
}

export class ForbiddenError extends Error {
  status = 403;
  constructor(public op: string, msg?: string) {
    super(msg ?? `Недостаточно прав для операции «${op}»`);
  }
}

/**
 * Разделение обязанностей: автор версии не согласует её сам, если политика
 * клиента явно не разрешает самосогласование.
 */
export function assertNotSelfApproval(opts: { approverId: string; versionAuthorId: string | null; allowSelfApproval: boolean }) {
  if (!opts.allowSelfApproval && opts.versionAuthorId && opts.approverId === opts.versionAuthorId) {
    throw new ForbiddenError("approve", "Автор не может согласовать собственный материал: политика клиента не разрешает самосогласование");
  }
}
