/**
 * The student's one "Enter a code" field (ADR-045): a classroom's join code
 * (F-ORG-06) or a poll's session code (F-LIVE-13), told apart by their
 * length (`enterCode.ts`). ONE component, drawn in two places: the empty
 * student home, where it is the screen's primary action, and the small
 * dialog the sidebar row, the phone's top bar and the palette open.
 *
 * - Type: the field's label and the 13 px line under it; nothing louder.
 * - Color: the submit button is the accent: both places it is drawn, it is
 *   the one action (a home with nothing else to do, a one-field dialog).
 * - Space: the field and its button on one row (8–12), the note tight under it.
 * - Finish: none of its own; it sits in whatever card or dialog holds it.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";

import type { JoinResult, Me } from "@quiz/contracts";

import { api, ApiError, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { studentClassroomsKey, studentHomeKey } from "../queryKeys";
import type { Route } from "../router";
import { Button, Field, Modal } from "../ui";
import { codeTarget, normalizeCode } from "./enterCode";

/**
 * Whether this account gets the code field at all: a real student only.
 * Never a teacher in their own student view (ADR-018 addendum, no. 6: a
 * gesture of the frame must never write a roster, and `POST /join` would give
 * the teacher an ordinary student seat), and never inside an exam, whose
 * palette is a fixed list (W15) and which has no frame.
 */
export function entersCodes(me: Me): boolean {
  return me.role === "student";
}

export function EnterCodeForm({
  navigate,
  autoFocus = false,
  onDone,
}: {
  navigate: (r: Route) => void;
  autoFocus?: boolean;
  /** After a poll was opened or a classroom joined: the dialog closes. */
  onDone?: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const noteId = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const target = codeTarget(value);
    if (target.kind === "invalid") {
      setError(t("code.invalid"));
      return;
    }
    if (target.kind === "poll") {
      // The poll's own page answers an unknown code and hops through the
      // login when the poll wants a name (F-AUTH-05): nothing to check here.
      onDone?.();
      navigate({ view: "join", code: target.code });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api<JoinResult>(`/app/api/join/${encodeURIComponent(target.code)}`, {
        method: "POST",
      });
      toast(
        t(result.status === "joined" ? "join.joined" : "join.already", {
          name: result.classroomName,
        }),
        "success",
      );
      setValue("");
      // The classroom and what it has open show on the home at once.
      void qc.invalidateQueries({ queryKey: studentClassroomsKey });
      void qc.invalidateQueries({ queryKey: studentHomeKey });
      onDone?.();
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 404
          ? t("code.notFound")
          : apiErrorMessage(e, t("error.server")),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="w-full text-left"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <Field
            label={t("code.label")}
            placeholder={t("code.placeholder")}
            fullWidth
            value={value}
            autoFocus={autoFocus}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={noteId}
            className="font-mono tracking-wider"
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          loading={busy}
          disabled={normalizeCode(value) === ""}
        >
          {t("code.action")}
        </Button>
      </div>
      {/* One line under the row: the help, or what went wrong — which says
          the same thing about what the field takes. */}
      <p
        id={noteId}
        role={error ? "alert" : undefined}
        className={error ? "mt-1.5 text-[13px] text-danger" : "mt-1.5 text-[13px] text-fg-faint"}
      >
        {error ?? t("code.hint")}
      </p>
    </form>
  );
}

/** The same field in a small dialog, opened from the frame (sidebar, top bar, palette). */
export function EnterCodeDialog({
  navigate,
  onClose,
}: {
  navigate: (r: Route) => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal title={t("code.title")} size="sm" onClose={onClose}>
      <EnterCodeForm navigate={navigate} autoFocus onDone={onClose} />
    </Modal>
  );
}
