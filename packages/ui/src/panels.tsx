/**
 * Panels: the settings section a host may take into its right column and
 * the teacher's "try the reference" row with the state machine behind it
 * (audit P-01k and P-01g), and the note set inside a card (`NotePanel`).
 */
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { card, cx, hint } from "./styles.js";
import { Button } from "./controls.js";

/**
 * The block an editor lets the host move (`EditorProps.aside`).
 *
 * Given an element, the section is PORTALLED there — the right column of the
 * question editor, under "Properties" — and dressed as a card, because that
 * is what it becomes there. Without one it renders in place, one section of
 * the main column among the others, which is what a test and any other host
 * get. The element arrives `null` on the host's first render, so the section
 * simply moves on the next one.
 */
export function AsideSection({
  aside,
  children,
}: {
  aside: HTMLElement | null | undefined;
  children: ReactNode;
}): ReactNode {
  const section = (
    <section className={cx(aside ? cx(card, "p-4") : "", "flex flex-col gap-3")}>{children}</section>
  );
  return aside ? createPortal(section, aside) : section;
}

/**
 * A note set inside a card: a 12 px uppercase eyebrow naming it ("Explanation",
 * "Comment", "Reference solution") over its body, in a field-radius panel
 * with 12 px of padding and 4 px between the eyebrow and the body.
 *
 * `soft` (a `surface-2` recess) is for what the product says — an
 * explanation, a key; `outlined` (a `line-strong` hairline on `surface`) is
 * for what a person wrote to this reader — a teacher's comment, a student's
 * answer. `aside` sits at the end of the eyebrow's line, in the body's
 * case and figures (a count). DESIGN.md › Components › NotePanel.
 */
export function NotePanel({
  eyebrow,
  aside,
  tone = "soft",
  children,
}: {
  eyebrow: ReactNode;
  aside?: ReactNode;
  tone?: "soft" | "outlined";
  children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cx(
        "rounded-field p-3",
        tone === "soft" ? "bg-surface-2" : "border border-line-strong bg-surface",
      )}
    >
      <p className="flex items-baseline justify-between gap-2 text-xs font-semibold uppercase tracking-wide text-fg-faint">
        <span>{eyebrow}</span>
        {aside == null ? null : <span className="font-normal normal-case tracking-normal tabular-nums">{aside}</span>}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

/** What the last try said, in one line; `danger` only for a real failure. */
export interface TryStatus {
  tone: "hint" | "danger";
  text: ReactNode;
}

/**
 * The teacher's check of their own key: a secondary button, and one status
 * line beside it. It is never the primary action of an editor — it verifies
 * the question, it does not author it (invariant 2).
 */
export function TryPanel({
  label,
  runningLabel,
  running,
  disabled,
  onTry,
  status,
}: {
  label: string;
  runningLabel: string;
  running: boolean;
  disabled?: boolean | undefined;
  onTry: () => void;
  status: TryStatus | null;
}): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        disabled={disabled || running}
        onClick={onTry}
      >
        {running ? runningLabel : label}
      </Button>
      {status === null ? null : (
        <p role="status" className={status.tone === "danger" ? "text-[13px] text-danger" : hint}>
          {status.text}
        </p>
      )}
    </div>
  );
}

/**
 * Where the teacher's try of the reference stands. `Reason` names why it
 * failed — each editor has its own, read to pick a sentence — and `Done` is
 * what a finished run carries (a count, a picture, the plots).
 */
export type TryState<Done extends object, Reason extends string> =
  | { status: "idle" }
  | { status: "running" }
  | { status: "unavailable" }
  | { status: "failed"; reason: Reason }
  | ({ status: "done" } & Done);

/**
 * The try of an editor: its state, and `run`, which refuses at once with
 * `blocked` — a mistake the teacher reads on this screen, so nothing is
 * sent — or else shows "running" until `attempt` settles. A throw fails
 * with `thrown`.
 */
export function useReferenceTry<Done extends object, Reason extends string>(
  thrown: Reason,
): {
  state: TryState<Done, Reason>;
  run: (blocked: Reason | null, attempt: () => Promise<TryState<Done, Reason>>) => Promise<void>;
} {
  const [state, setState] = useState<TryState<Done, Reason>>({ status: "idle" });
  async function run(blocked: Reason | null, attempt: () => Promise<TryState<Done, Reason>>) {
    if (blocked !== null) {
      setState({ status: "failed", reason: blocked });
      return;
    }
    setState({ status: "running" });
    try {
      setState(await attempt());
    } catch {
      setState({ status: "failed", reason: thrown });
    }
  }
  return { state, run };
}

/**
 * The {@link TryPanel} line of a try state: `hint` for "unavailable" and for
 * a finished run, `danger` for a failure, nothing before the first try.
 */
export function tryStatusOf<Done extends object, Reason extends string>(
  state: TryState<Done, Reason>,
  text: {
    unavailable: ReactNode;
    failed: (reason: Reason) => ReactNode;
    done: (state: Done) => ReactNode;
  },
): TryStatus | null {
  switch (state.status) {
    case "unavailable":
      return { tone: "hint", text: text.unavailable };
    case "failed":
      return { tone: "danger", text: text.failed(state.reason) };
    case "done":
      return { tone: "hint", text: text.done(state) };
    default:
      return null;
  }
}
