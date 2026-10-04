/*
 * The group sets' rules on the web side (ADR-070, M3-16a), pure: where a
 * student is, the optimistic move, the words of a refusal, the sizes a
 * random formation would make. `GroupSetPage.tsx` and `GroupBoard.tsx`
 * draw them.
 */
import { z } from "zod";

import { GroupErrorCode, type GroupRemainder, type GroupSetDetail, type GroupStudent } from "@quiz/contracts";
import { groupSizes } from "@quiz/domain";

import { ApiError, apiErrorMessage, refusalCodeOf } from "../api";
import type { Dict, TFunction } from "../i18n";

/** A student as the board writes them: family name first, like the roster and the project page. */
export const studentName = (s: Pick<GroupStudent, "nom" | "prenom">): string => `${s.nom} ${s.prenom}`;

/** The group `enrollmentId` is in (its id), `null` when in none, `undefined` when not a student of the set. */
export function placeOf(detail: GroupSetDetail, enrollmentId: string): string | null | undefined {
  if (detail.unplaced.some((s) => s.enrollmentId === enrollmentId)) return null;
  return detail.groups.find((g) => g.members.some((s) => s.enrollmentId === enrollmentId))?.id;
}

/** The student of the set `enrollmentId` names, wherever they are. */
export function studentOf(detail: GroupSetDetail, enrollmentId: string): GroupStudent | undefined {
  return [...detail.unplaced, ...detail.groups.flatMap((g) => g.members)].find((s) => s.enrollmentId === enrollmentId);
}

const byName = (a: GroupStudent, b: GroupStudent) => studentName(a).localeCompare(studentName(b));

/**
 * The set with `enrollmentId` moved into `groupId` (`null`: out of every
 * group), as the server will answer it: a list keeps its name order. The
 * optimistic step of a move, replaced by the server's answer.
 */
export function withMove(detail: GroupSetDetail, enrollmentId: string, groupId: string | null): GroupSetDetail {
  const student = studentOf(detail, enrollmentId);
  if (!student || (groupId !== null && !detail.groups.some((g) => g.id === groupId))) return detail;
  const without = (list: GroupStudent[]) => list.filter((s) => s.enrollmentId !== enrollmentId);
  const into = (list: GroupStudent[]) => [...without(list), student].sort(byName);
  return {
    ...detail,
    unplaced: groupId === null ? into(detail.unplaced) : without(detail.unplaced),
    groups: detail.groups.map((g) => ({ ...g, members: g.id === groupId ? into(g.members) : without(g.members) })),
  };
}

/** A group whose members outnumber the set's maximum size: a warning, never a refusal (ADR-070 §3). */
export const overMax = (members: number, maxSize: number | null): boolean => maxSize !== null && members > maxSize;

// ---------------------------------------------------------------- the random formation

/** The sizes of the new groups, largest first, counted: 23 by 3, smaller → [{3: 7}, {2: 1}]. */
export function sizesSummary(n: number, size: number, remainder: GroupRemainder): { size: number; count: number }[] {
  if (n < 1 || size < 1 || size > n) return [];
  const counts = new Map<number, number>();
  for (const s of groupSizes(n, size, remainder)) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => b - a).map(([s, count]) => ({ size: s, count }));
}

/** The size the random formation opens on: the set's maximum, else pairs — never more than the students to place. */
export const defaultRandomSize = (unplaced: number, maxSize: number | null): number =>
  Math.max(1, Math.min(maxSize ?? 2, unplaced));

// ---------------------------------------------------------------- refusals

/**
 * The words of each refusal of the group routes, by code. `has_repo` comes
 * with M3-15b-1 (a write that would change the members of, or delete, a
 * copy's group that has a repository): worded here already, so the code
 * joining `GROUP_REFUSALS` needs no change on this side.
 */
type RefusalCode = GroupErrorCode | "has_repo";
const REFUSAL_KEY: Record<RefusalCode, keyof Dict> = {
  classroom_archived: "groups.refusal.classroomArchived",
  set_in_use: "groups.refusal.setInUse",
  duplicate_name: "groups.refusal.duplicateName",
  nobody_to_place: "groups.refusal.nobodyToPlace",
  size_out_of_range: "groups.refusal.sizeOutOfRange",
  has_repo: "groups.refusal.hasRepo",
};

const isRefusalCode = (code: string | null): code is RefusalCode => code !== null && Object.hasOwn(REFUSAL_KEY, code);

/** The refusal of a group route this error is, or null. */
export function groupRefusal(error: unknown): GroupErrorCode | null {
  const parsed = GroupErrorCode.safeParse(refusalCodeOf(error));
  return parsed.success ? parsed.data : null;
}

/** What a failed write of a set says: the refusal worded, else the server's message, else `error.save`. */
export function groupRefusalMessage(error: unknown, t: TFunction): string {
  const code = refusalCodeOf(error);
  if (!isRefusalCode(code)) return apiErrorMessage(error, t("error.save"));
  const max = error instanceof ApiError ? (error.body as { max?: unknown } | null)?.max : undefined;
  return t(REFUSAL_KEY[code], { max: typeof max === "number" ? max : "" });
}

/**
 * The `409 set_in_use` body (`modules/group/errors.ts`): the projects that
 * are not archived and name the set. Read here, where it is worded; the
 * contracts name the code only.
 */
const SetInUseBody = z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) });

export function setInUseProjects(error: unknown): { id: string; name: string }[] | null {
  if (groupRefusal(error) !== "set_in_use" || !(error instanceof ApiError)) return null;
  const parsed = SetInUseBody.safeParse(error.body);
  return parsed.success ? parsed.data.projects : [];
}

/** An Undo answered 404: the group the student came from is gone (ADR-070 §6). */
export const undoGone = (error: unknown): boolean => error instanceof ApiError && error.status === 404;
