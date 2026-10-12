import { ChevronRight } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { useT } from "../../i18n";
import { cx } from "../../ui";

/**
 * A criterion's rationale folded under it (ADR-106 §6), on the staff's
 * grading table and the student's criteria table alike: a "Rationale"
 * toggle, then, unfolded, what the table puts there.
 */
export function RationaleFold({ children }: { children: ReactNode }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-0.5 self-start rounded-sm text-xs font-medium text-fg-muted transition-colors hover:text-fg"
      >
        <ChevronRight aria-hidden className={cx("size-3.5 transition-transform", open && "rotate-90")} />
        {t("project.grading.rationale")}
      </button>
      {open ? (
        <span id={id} className="mt-1 flex max-w-[70ch] flex-col items-start gap-1">
          {children}
        </span>
      ) : null}
    </>
  );
}

/** A rationale as plain text (N-SEC-14): a text node, line breaks kept, never markup. */
export const RationaleText = ({ children }: { children: string }) => (
  <span className="whitespace-pre-wrap text-[13px] text-fg-muted">{children}</span>
);
