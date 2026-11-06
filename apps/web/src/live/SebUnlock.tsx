/**
 * The unlock password of the evaluation's Safe Exam Browser (ADR-027,
 * addendum of 2026-11-06), for the teacher in the room: SEB locks after a
 * user-session switch and asks for it before the student may resume.
 *
 * Hidden until clicked, and hidden again on a reload: the live screen is
 * often projected (F-DASH-02), and a password on the beamer is a password
 * for the whole room. The reveal is this component's state, never stored.
 * Secondary by construction: a text link in the status row, beside the
 * journal, never a button competing with the header's controls.
 */
import { KeyRound } from "lucide-react";
import { useState } from "react";

import { useT } from "../i18n";
import { cx, textLink, Tip } from "../ui";

export function SebUnlock({ password }: { password: string | null }) {
  const t = useT();
  const [shown, setShown] = useState(false);
  if (password === null) return null;
  return (
    <Tip label={t("live.sebUnlock.tip")}>
      <button
        type="button"
        aria-pressed={shown}
        onClick={() => setShown((v) => !v)}
        className={cx("flex items-center gap-1.5 text-[13px] text-fg-muted", textLink)}
      >
        <KeyRound className="size-4" aria-hidden />
        {t("live.sebUnlock.label")}
        {shown ? <span className="font-mono font-semibold tracking-[0.08em] text-fg">{password}</span> : null}
      </button>
    </Tip>
  );
}
