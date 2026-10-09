import { useCallback, useEffect, useState } from "react";

import type { PlayerItem, PlayerState } from "../attempt/playerReducer";
import { UnsavedAnswer } from "../attempt/useAttempt";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { useShortcuts } from "../shortcuts";
import { modKey } from "../ui";
import type { PlayerSession } from "./Player";
import { emptyAnswerOf } from "./QuestionHost";

/**
 * What the player's buttons and keys DO, apart from how they look: validate
 * (behind its confirmation), skip, flag, clear, hand in, and the keyboard.
 * Each one says in a toast when its write did not land; none of them decides
 * that the attempt is over — the session does, from the server.
 *
 * The keyboard: `Alt + ←/→` moves, `Ctrl + Enter` validates where validating
 * exists. Alt and Ctrl, not bare arrows: every question type has a field, and
 * a player that steals the arrow keys cannot be used to write.
 */
export function usePlayerControls({
  session,
  item,
  readOnly,
  canValidate,
  blank,
  notepad = false,
}: {
  session: PlayerSession;
  item: PlayerItem | undefined;
  readOnly: boolean;
  /** The condition of the Validate button, so `Ctrl+Enter` never asks for more. */
  canValidate: boolean;
  /** The question holds no answer: the confirmation says it closes empty. */
  blank: boolean;
  /** The evaluation provides a notepad, which a checkpoint empties (ADR-090). */
  notepad?: boolean;
}) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const { state, dispatch, markDone, skip, flag, submit, setAnswer } = session;
  const [submitting, setSubmitting] = useState(false);
  // The validation step is named for what it closes: an empty question is
  // left blank, not validated (F-LIVE-08).
  const validateLabel = t(blank ? "player.validateBlank" : "player.validate");

  const validate = useCallback(async () => {
    if (!item || !canValidate) return;
    // Irreversible, so it asks first: in `forward_only` the question closes
    // for good, at a checkpoint everything before it does too.
    const ok = await confirm({
      title: t("player.validate.title"),
      message:
        state.navigation === "milestones"
          ? t(notepad ? "conditions.navigation.milestones.bodyNotepad" : "conditions.navigation.milestones.body")
          : t(blank ? "player.validateBlank.body" : "player.validate.body"),
      confirmLabel: validateLabel,
      // Irreversible: Enter right after Ctrl+Enter must not validate for good.
      focusCancel: true,
    });
    if (!ok) return;
    try {
      await markDone(item.id, true);
    } catch (error) {
      toast(
        t(error instanceof UnsavedAnswer ? "player.validateUnsaved" : "player.validateFailed"),
        "error",
      );
    }
  }, [item, canValidate, blank, notepad, validateLabel, state.navigation, confirm, t, markDone, toast]);

  /** A write that may fail, for a question that is still open. */
  const onOpenItem = useCallback(
    (write: (item: PlayerItem) => Promise<void>) => async () => {
      if (!item || readOnly) return;
      try {
        await write(item);
      } catch {
        toast(t("player.saveFailed"), "error");
      }
    },
    [item, readOnly, toast, t],
  );
  const toggleSkip = onOpenItem((i) => skip(i.id, !i.skipped));
  const toggleFlag = onOpenItem((i) => flag(i.id, !i.flagged));
  const clear = useCallback(() => {
    if (item) setAnswer(item.id, emptyAnswerOf(item.type, item.student), false);
  }, [item, setAnswer]);

  const handIn = useCallback(async () => {
    try {
      await submit();
    } catch {
      toast(t("player.submitFailed"), "error");
    } finally {
      setSubmitting(false);
    }
  }, [submit, toast, t]);

  // `Alt` and `Ctrl` are held on purpose: the bare keys belong to whatever
  // field the student is typing in.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (submitting) return;
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        dispatch({ type: "move", delta: e.key === "ArrowRight" ? 1 : -1 });
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void validate();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, validate, submitting]);

  // The same keys, for the sidebar strip. The zen player runs outside the
  // Shell and therefore shows no strip of its own; registering them anyway
  // costs nothing and keeps the day the frame comes back one line of work.
  useShortcuts([
    // A one-question attempt has nowhere to move: offering the two arrows
    // would teach a shortcut that does nothing.
    ...(state.items.length > 1
      ? [
          { keys: "Alt+←", label: t("player.command.prev") },
          { keys: "Alt+→", label: t("player.command.next") },
        ]
      : []),
    // Only where there is something to validate: a shortcut that does
    // nothing on this paper is one the student learns for nothing.
    ...(state.navigation === "free"
      ? []
      : [{ keys: `${modKey()}+Enter`, label: t("player.validate") }]),
  ]);

  return {
    validateLabel,
    submitting,
    openSubmit: () => setSubmitting(true),
    cancelSubmit: () => setSubmitting(false),
    handIn,
    validate,
    toggleSkip,
    toggleFlag,
    clear,
  };
}
