/**
 * The picture half of a `codeimage` player: the two toggles (view, layout),
 * the grids, the score line and the palette legend. Shared by the student's
 * player and the review, which show the same images with the same controls.
 *
 * The view toggle picks what a single grid shows — the target, the computed
 * image, or the difference. Side by side, the computed image is always on
 * the left and the toggle picks the right-hand grid: the target or the
 * difference (the computed image is already there).
 */
import { useId, type ReactNode } from "react";

import { fmt } from "@quiz/core/client";
import { cx, hint, Segmented } from "@quiz/ui";

import { PixelGrid } from "./PixelGrid.js";
import { countCorrect, PASTEL_16 } from "./pixels.js";
import type { ImageSpec } from "./schema.js";
import type { ImagePlayerStrings } from "./strings.js";

export type ImageView = "target" | "computed" | "diff";
export type ImageLayout = "single" | "split";

type PanelStrings = Pick<
  ImagePlayerStrings,
  | "view"
  | "viewTarget"
  | "viewComputed"
  | "viewDiff"
  | "layout"
  | "layoutSingle"
  | "layoutSplit"
  | "targetImage"
  | "computedImage"
  | "diffImage"
  | "notRunYet"
  | "noTarget"
  | "pixelScore"
  | "diffOk"
  | "diffWrong"
  | "legend"
>;

export function ImagePanel({
  spec,
  target,
  computed,
  view,
  onView,
  layout,
  onLayout,
  s,
  emptyLabel,
}: {
  spec: ImageSpec;
  /** `null` when the question has no valid target (a draft). */
  target: Int16Array | null;
  /** `null` before the first run. */
  computed: Int16Array | null;
  view: ImageView;
  onView: (view: ImageView) => void;
  layout: ImageLayout;
  onLayout: (layout: ImageLayout) => void;
  s: PanelStrings;
  /** What an empty computed grid says; the player's "run your program". */
  emptyLabel?: string | undefined;
}): ReactNode {
  const ids = useId();
  const total = spec.width * spec.height;
  const matching = computed !== null && target !== null ? countCorrect(computed, target) : null;

  const grid = (which: ImageView): ReactNode => {
    const common = { width: spec.width, height: spec.height, palette: spec.palette };
    switch (which) {
      case "target":
        return (
          <PixelGrid {...common} pixels={target} label={s.targetImage} emptyLabel={s.noTarget} />
        );
      case "computed":
        return (
          <PixelGrid
            {...common}
            pixels={computed}
            label={s.computedImage}
            emptyLabel={emptyLabel ?? s.notRunYet}
          />
        );
      case "diff":
        return (
          <PixelGrid
            {...common}
            pixels={target === null ? null : computed}
            diffAgainst={target}
            label={s.diffImage}
            emptyLabel={target === null ? s.noTarget : (emptyLabel ?? s.notRunYet)}
          />
        );
    }
  };

  // Side by side, the right-hand grid is the target or the difference.
  const right: ImageView = view === "diff" ? "diff" : "target";
  const viewOptions =
    layout === "split"
      ? [
          { value: "target" as const, label: s.viewTarget },
          { value: "diff" as const, label: s.viewDiff },
        ]
      : [
          { value: "target" as const, label: s.viewTarget },
          { value: "computed" as const, label: s.viewComputed },
          { value: "diff" as const, label: s.viewDiff },
        ];
  const shownView = layout === "split" ? right : view;
  const showsDiff = shownView === "diff";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span id={`${ids}-view`} className="text-[13px] font-medium text-fg-muted">
            {s.view}
          </span>
          <Segmented
            name={`${ids}-view-radio`}
            labelledBy={`${ids}-view`}
            value={shownView}
            options={viewOptions}
            onChange={onView}
          />
        </div>
        <div className="flex items-center gap-2">
          <span id={`${ids}-layout`} className="text-[13px] font-medium text-fg-muted">
            {s.layout}
          </span>
          <Segmented
            name={`${ids}-layout-radio`}
            labelledBy={`${ids}-layout`}
            value={layout}
            options={[
              { value: "single" as const, label: s.layoutSingle },
              { value: "split" as const, label: s.layoutSplit },
            ]}
            onChange={onLayout}
          />
        </div>
      </div>

      {layout === "split" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Figure caption={s.computedImage}>{grid("computed")}</Figure>
          <Figure caption={right === "diff" ? s.diffImage : s.targetImage}>{grid(right)}</Figure>
        </div>
      ) : (
        <Figure
          caption={
            view === "diff" ? s.diffImage : view === "computed" ? s.computedImage : s.targetImage
          }
        >
          {grid(view)}
        </Figure>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {matching === null ? null : (
          <p role="status" className="text-[13px] font-medium tabular-nums text-fg">
            {fmt(s.pixelScore, {
              matching,
              total,
              percent: Math.floor((1000 * matching) / total) / 10,
            })}
          </p>
        )}
        {showsDiff ? (
          <p className={cx(hint, "flex items-center gap-3")}>
            <span className="flex items-center gap-1.5">
              <Swatch className="bg-success" />
              <span>{s.diffOk}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <Swatch className="bg-danger" />
              <span>{s.diffWrong}</span>
            </span>
          </p>
        ) : null}
      </div>

      {spec.palette === "color16" ? <Legend label={s.legend} /> : null}
    </div>
  );
}

function Figure({ caption, children }: { caption: string; children: ReactNode }): ReactNode {
  return (
    <figure className="flex min-w-0 flex-col gap-1.5">
      <figcaption className="text-[13px] font-medium text-fg-muted">{caption}</figcaption>
      {children}
    </figure>
  );
}

function Swatch({ className, color }: { className?: string; color?: string }): ReactNode {
  return (
    <span
      aria-hidden="true"
      className={cx("inline-block size-3 shrink-0 border border-line-strong", className)}
      style={color === undefined ? undefined : { backgroundColor: color }}
    />
  );
}

/** The sixteen colours with their index: what `printf("%d ", 12)` paints. */
function Legend({ label }: { label: string }): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-[13px] font-medium text-fg-muted">{label}</span>
      <ul className="flex flex-wrap gap-x-2.5 gap-y-1">
        {PASTEL_16.map((color, i) => (
          <li key={i} className="flex items-center gap-1 font-mono text-[12px] text-fg-muted">
            <Swatch color={color} />
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
