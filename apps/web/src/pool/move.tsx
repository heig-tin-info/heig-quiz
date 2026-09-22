import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type DragEvent } from "react";

import type { MoveConflict, MoveResult } from "@quiz/contracts";

import { ApiError, api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";

/**
 * Moving questions to another pool (ADR-017), on both sides of the gesture:
 * the drag-and-drop transfer that a question row writes and a sidebar row
 * reads, and the ONE call that performs the move wherever it was asked for.
 *
 * The drag-and-drop is native HTML5: the codebase has no DnD library, this is
 * one payload travelling from a table row to a navigation row, and a library
 * would be 40 kB to move a list of uuids across the page. Keyboard users are
 * not left out — the bulk bar performs the same move through a dialog, which
 * is also the only way to move a selection of twenty without holding a mouse
 * button down the whole time.
 */

/**
 * The drag payload's MIME type. A private type rather than `text/plain`: the
 * sidebar must light up for a question and for nothing else, and `dragover`
 * can only read the TYPES of a transfer, never its data.
 */
export const QUESTION_DRAG_MIME = "application/x-quiz-questions";

export interface QuestionDrag {
  questionIds: string[];
  /** What the toast calls them: the internal name, or a count. */
  label: string;
}

/** Writes the payload on the drag that a question row starts. */
export function setQuestionDrag(event: DragEvent, drag: QuestionDrag): void {
  event.dataTransfer.setData(QUESTION_DRAG_MIME, JSON.stringify(drag));
  // Firefox starts no drag at all without a `text/plain` fallback.
  event.dataTransfer.setData("text/plain", drag.label);
  event.dataTransfer.effectAllowed = "move";
}

/** Reads it back on the drop; anything that is not ours answers null. */
export function readQuestionDrag(event: DragEvent): QuestionDrag | null {
  const raw = event.dataTransfer.getData(QUESTION_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as QuestionDrag;
    return Array.isArray(parsed.questionIds) && parsed.questionIds.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

const carriesQuestions = (event: DragEvent) =>
  Array.from(event.dataTransfer.types).includes(QUESTION_DRAG_MIME);

/**
 * Makes an element a drop target for questions: the handlers to spread, and
 * whether a question is hovering it right now.
 *
 * `dragenter` and `dragover` both have to preventDefault — the first is what
 * accepts the target, the second what keeps it accepted frame after frame —
 * and the counter is what stops a child element's `dragleave` from putting the
 * highlight out while the pointer is still inside the row.
 */
export function useQuestionDrop(onDrop: (drag: QuestionDrag) => void, enabled = true) {
  const [depth, setDepth] = useState(0);
  const accept = (event: DragEvent) => {
    if (!enabled || !carriesQuestions(event)) return false;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    return true;
  };
  return {
    over: depth > 0,
    handlers: {
      onDragEnter: (event: DragEvent) => {
        if (accept(event)) setDepth((d) => d + 1);
      },
      onDragOver: accept,
      onDragLeave: () => setDepth((d) => Math.max(0, d - 1)),
      onDrop: (event: DragEvent) => {
        setDepth(0);
        if (!enabled) return;
        const drag = readQuestionDrag(event);
        if (!drag) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(drag);
      },
    },
  };
}

export interface MoveRequest {
  questionIds: string[];
  targetPoolId: string;
  /** For the toast and for the confirmation: the pool's name, not its id. */
  targetPoolName: string;
  categoryId?: string | null;
  /** The question's internal name when there is one; a count otherwise. */
  label?: string;
}

/**
 * THE move, wherever it is asked from (a drop on the sidebar, the bulk bar).
 *
 * The server owns every rule; this only asks and retries. The one refusal
 * worth a dialog is `pool_not_linked`: a classroom already plays the
 * question and the target pool is not one its course draws from, so the
 * teacher is asked whether the pool should join that course — and the retry
 * carries `linkCourses: true`, which is the only thing that makes the server
 * write `course_pools`. The other two refusals are messages, because there is
 * nothing to retry: a name is taken, or the course is not the caller's.
 */
export function useMoveQuestions(): (request: MoveRequest) => Promise<boolean> {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();

  return useCallback(
    async (request: MoveRequest) => {
      const call = (linkCourses: boolean) =>
        api<MoveResult>("/app/api/questions/move", {
          method: "POST",
          body: JSON.stringify({
            questionIds: request.questionIds,
            targetPoolId: request.targetPoolId,
            categoryId: request.categoryId ?? null,
            ...(linkCourses ? { linkCourses: true } : {}),
          }),
        });

      const conflictOf = (error: unknown): MoveConflict | null =>
        error instanceof ApiError && error.status === 409
          ? (error.body as MoveConflict)
          : null;

      const report = (error: unknown) => {
        const conflict = conflictOf(error);
        if (conflict?.error === "name_taken") {
          toast(t("pool.move.nameTaken", { name: conflict.names[0] ?? "" }), "error");
        } else if (conflict?.error === "course_forbidden") {
          toast(
            t("pool.move.forbidden", { course: conflict.courses[0]?.courseCode ?? "" }),
            "error",
          );
        } else {
          toast(t("pool.move.failed"), "error");
        }
      };

      let result: MoveResult;
      try {
        result = await call(false);
      } catch (error) {
        const conflict = conflictOf(error);
        if (conflict?.error !== "pool_not_linked") {
          report(error);
          return false;
        }
        const rooms = conflict.courses.flatMap((c) => c.classrooms.map((r) => r.name));
        const ok = await confirm({
          title: t("pool.move.usedTitle"),
          message: t(
            request.questionIds.length === 1 ? "pool.move.usedBody.one" : "pool.move.usedBody",
            {
              n: request.questionIds.length,
              classrooms: rooms.join(", "),
              courses: conflict.courses.map((c) => c.courseCode).join(", "),
              pool: request.targetPoolName,
            },
          ),
          confirmLabel: t("pool.move.usedConfirm"),
          cancelLabel: t("common.cancel"),
        });
        if (!ok) return false;
        try {
          result = await call(true);
        } catch (retryError) {
          report(retryError);
          return false;
        }
      }

      // Both pools changed, and so did the course list when the move linked
      // the pool to a course: everything keyed on them re-reads.
      await qc.invalidateQueries({ queryKey: ["pool"] });
      await qc.invalidateQueries({ queryKey: ["pools"] });
      if (result.linkedCourseIds.length) await qc.invalidateQueries({ queryKey: ["courses"] });
      toast(
        result.moved === 1 && request.label
          ? t("pool.move.done.one", { name: request.label, pool: request.targetPoolName })
          : t("pool.move.done", { n: result.moved, pool: request.targetPoolName }),
        "success",
      );
      return true;
    },
    [confirm, qc, t, toast],
  );
}
