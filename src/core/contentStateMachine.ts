import type { Operation } from "./permissions";

export const CONTENT_STATES = [
  "idea", "brief", "draft", "editorial_review", "client_review", "approved", "scheduled",
  "publishing", "published", "changes_requested", "cancelled", "failed", "publication_unknown", "archived",
] as const;
export type ContentState = (typeof CONTENT_STATES)[number];

export interface TransitionRule {
  from: ContentState[];
  to: ContentState;
  /** Операция, которую должен иметь инициатор. "system": только фоновый исполнитель. */
  requires: Operation | "system";
  /** Обязательные данные. */
  needs?: ("version" | "schedule" | "comment" | "approval" | "external_evidence")[];
  event: string;
  notify: string[];
  /** Как отменяется переход. */
  undo: string;
}

export const TRANSITIONS: TransitionRule[] = [
  { from: ["idea"], to: "brief", requires: "create_content", event: "content.brief_created", notify: [], undo: "вернуть в idea" },
  { from: ["idea", "brief", "changes_requested"], to: "draft", requires: "edit_content", needs: ["version"], event: "content.drafted", notify: [], undo: "новая версия" },
  { from: ["draft", "changes_requested"], to: "editorial_review", requires: "edit_content", needs: ["version"], event: "content.sent_to_editor", notify: ["editor"], undo: "отозвать в draft" },
  { from: ["editorial_review"], to: "client_review", requires: "editorial_approve", needs: ["approval"], event: "content.editor_approved", notify: ["client_approvers", "account_manager"], undo: "новая версия аннулирует согласование" },
  { from: ["editorial_review", "client_review"], to: "changes_requested", requires: "view", needs: ["comment"], event: "content.changes_requested", notify: ["author"], undo: "автор создаёт новую версию" },
  { from: ["client_review"], to: "approved", requires: "client_approve", needs: ["approval"], event: "content.client_approved", notify: ["account_manager"], undo: "изменение версии аннулирует" },
  { from: ["approved"], to: "scheduled", requires: "schedule", needs: ["schedule"], event: "content.scheduled", notify: ["account_manager"], undo: "unschedule → approved" },
  { from: ["scheduled"], to: "approved", requires: "schedule", event: "content.unscheduled", notify: [], undo: "запланировать снова" },
  { from: ["scheduled", "approved"], to: "publishing", requires: "system", event: "content.publishing", notify: [], undo: "нельзя: исход определяется внешней системой" },
  { from: ["publishing"], to: "published", requires: "system", needs: ["external_evidence"], event: "content.published", notify: ["account_manager", "client_approvers"], undo: "удаление: отдельная операция" },
  { from: ["publishing"], to: "failed", requires: "system", event: "content.failed", notify: ["account_manager"], undo: "повторная постановка после разбора" },
  { from: ["publishing"], to: "publication_unknown", requires: "system", event: "content.publication_unknown", notify: ["account_manager", "ops_director"], undo: "разрешение неопределённости" },
  { from: ["publication_unknown"], to: "published", requires: "publish", needs: ["external_evidence"], event: "content.unknown_resolved_published", notify: [], undo: "нет" },
  { from: ["publication_unknown", "failed"], to: "approved", requires: "publish", needs: ["comment"], event: "content.unknown_resolved_not_published", notify: [], undo: "нет" },
  { from: ["approved", "scheduled"], to: "publishing", requires: "publish", event: "content.assisted_started", notify: [], undo: "нет" },
  { from: ["idea", "brief", "draft", "editorial_review", "client_review", "changes_requested", "approved", "scheduled", "failed"], to: "cancelled", requires: "edit_content", needs: ["comment"], event: "content.cancelled", notify: ["account_manager"], undo: "восстановить в draft" },
  { from: ["published", "cancelled"], to: "archived", requires: "edit_content", event: "content.archived", notify: [], undo: "разархивировать" },
];

export class TransitionError extends Error {
  status = 409;
}

export function findTransition(from: ContentState, to: ContentState): TransitionRule | undefined {
  return TRANSITIONS.find((t) => t.to === to && t.from.includes(from));
}

export function assertTransition(from: ContentState, to: ContentState): TransitionRule {
  const t = findTransition(from, to);
  if (!t) throw new TransitionError(`Переход ${from} → ${to} не разрешён`);
  return t;
}

/** Состояния, в которых правка текста/медиа/аккаунта аннулирует согласование. */
export const APPROVAL_SENSITIVE: ContentState[] = ["client_review", "approved", "scheduled"];

/** Хеш значимого содержания версии: текст, медиа, целевой аккаунт. */
export async function contentHash(v: { body: string; media_ids: string[]; target_account_id: string }): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256")
    .update(JSON.stringify([v.body, [...v.media_ids].sort(), v.target_account_id]))
    .digest("hex");
}
