import type { ReactNode } from "react";

import { TypeGlyph } from "../pool/QuestionTable";
import { cx, pressable } from "../ui";

/** The first line of a prompt, short enough for a row. */
export function promptLine(prompt: string, max = 120): string {
  const line = prompt.replace(/[`*_#>\n]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/**
 * One question the launcher can start, in either list ("Recent polls",
 * "From pools"): the type, the internal name, the statement's first line and
 * a quiet line of facts. In "From pools", pressing it selects it and "Start
 * the poll" runs it (`selected`); in "Recent polls" it opens the question in
 * the editor (no `selected`, `busy` while it loads).
 *
 * `aside` sits BESIDE the pressable part, not inside it: the outcome donut
 * takes the focus to show its rates, and a focusable thing inside a button is
 * one control too many for a screen reader.
 */
export function PickRow({
  type,
  name,
  prompt,
  meta,
  aside,
  selected,
  busy,
  onSelect,
}: {
  type: string;
  name: string;
  prompt: string;
  meta: ReactNode;
  aside?: ReactNode;
  /** Absent where pressing opens rather than selects: no pressed state then. */
  selected?: boolean;
  busy?: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      className={cx(
        "flex items-center gap-3 rounded-field border pr-3 transition-colors",
        selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-2",
      )}
    >
      <div
        {...pressable(onSelect)}
        aria-pressed={selected}
        aria-busy={busy || undefined}
        className={cx(
          "flex min-w-0 flex-1 items-start gap-3 rounded-field p-3 text-left",
          busy ? "cursor-progress" : "cursor-pointer",
        )}
      >
        <span className="mt-0.5">
          <TypeGlyph type={type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px] font-bold">{name}</span>
          <span className="mt-0.5 block text-[13px] text-fg-muted">{promptLine(prompt)}</span>
          <span className="mt-1 block text-xs text-fg-faint">{meta}</span>
        </span>
      </div>
      {aside}
    </li>
  );
}
