import { useT } from "../i18n";
import { cx, Tip } from "./layers";

// Bar: one horizontal bar cut into parts, for counts that add up to a whole.

/** The meaning of a part, never a raw colour (DESIGN.md, "Correction projection"). */
export type BarTone = "success" | "partial" | "danger" | "warning" | "muted" | "info";

export const BAR_TONES: Record<BarTone, string> = {
  success: "bg-success",
  // Partial credit is green HATCHED over the track: the same family as full
  // credit, told apart by texture as well as by tone.
  partial: "bg-[repeating-linear-gradient(135deg,var(--success)_0_5px,transparent_5px_9px)]",
  danger: "bg-danger",
  warning: "bg-warning",
  muted: "bg-fg-faint/50",
  // A share with no verdict: the choices picked on a question of the pool (ADR-043).
  info: "bg-info",
};

export interface BarPart {
  tone: BarTone;
  value: number;
  /** What the part counts ("wrong"). A bar whose parts all say it speaks. */
  label?: string;
}

/**
 * A thin segmented bar: each part takes its share of `total` (the sum of the
 * parts by default; what is left of a larger total stays the empty track).
 * The parts are parted by 2 px gaps, so a colour is never the only thing that
 * tells two of them apart.
 *
 * The figures are never printed beside it — the bar is the one reading — but
 * they are one hover or one Tab away: when every part has a `label`, the bar
 * spells its non-empty parts out ("wrong: 4 · no answer: 1"), as the bubble
 * AND as its accessible name. Without labels it is decoration, hidden from
 * assistive technology, and says nothing more than the text next to it.
 *
 * The height is the caller's (`className`, e.g. `h-2`). An empty part draws
 * nothing, not even its gap.
 */
export function SegmentedBar({
  parts,
  total,
  className = "h-2",
}: {
  parts: readonly BarPart[];
  total?: number;
  className?: string;
}) {
  const t = useT();
  const label = parts.every((p) => p.label)
    ? parts
        .filter((p) => p.value > 0)
        .map((p) => t("bar.part", { word: p.label!, n: p.value }))
        .join(" · ")
    : "";
  const sum = parts.reduce((s, p) => s + p.value, 0);
  const rest = Math.max(0, (total ?? sum) - sum);
  const bar = (
    <span
      {...(label ? { role: "img", tabIndex: 0, "aria-label": label } : { "aria-hidden": true })}
      className={cx("flex w-full gap-0.5 overflow-hidden rounded-full bg-surface-3", className)}
    >
      {parts.map((part, index) =>
        part.value > 0 ? (
          <span
            key={index}
            className={cx("min-w-0 basis-0", BAR_TONES[part.tone])}
            style={{ flexGrow: part.value }}
          />
        ) : null,
      )}
      {rest > 0 ? <span className="min-w-0 basis-0" style={{ flexGrow: rest }} /> : null}
    </span>
  );
  return label ? (
    <Tip label={label} className="flex w-full">
      {bar}
    </Tip>
  ) : (
    bar
  );
}
