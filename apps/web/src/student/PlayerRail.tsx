import { useT } from "../i18n";
import { ProgressList, type Segment } from "../ui";
import { pointsLabel } from "./PlayerQuestion";

/**
 * The side column of the zen player on a wide screen: the question list
 * standing beside the question instead of a strip over it, then what belongs
 * to the question on screen but not to its answer — what it is worth. A
 * laptop has width to spare and height to none: every pixel the strip took
 * above the statement came out of the answer field.
 *
 * The shell's `aside` makes it sticky and bounded to the viewport: a long
 * paper scrolls inside the list.
 */
export function PlayerRail({
  segments,
  onSelect,
  label,
  points,
}: {
  segments: Segment[];
  onSelect: (id: string) => void;
  label: string;
  points: number;
}) {
  const t = useT();
  const index = segments.findIndex((s) => s.current === true);
  return (
    <>
      <ProgressList
        segments={segments}
        onSelect={onSelect}
        label={label}
        className="-mx-1 mt-2 min-h-0 flex-1"
      />
      {/* The current question's own line, under the list it closes. */}
      <div className="border-t border-line pt-4">
        <p className="text-[13px] text-fg-muted">
          <span className="font-semibold text-fg">{t("player.question", { n: index + 1 })}</span>
          {" · "}
          {pointsLabel(t, points)}
        </p>
      </div>
    </>
  );
}
