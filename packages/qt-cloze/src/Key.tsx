/**
 * The `cloze` answer key of the debrief (ADR-033, ADR-109): its text, each
 * blank holding the key and how the class filled it. The blanks are IN the
 * statement, so it replaces the host's prompt and lists no answer rows.
 *
 * Staff only (`QuestionTypeClient.Key`): never mounted on a student surface.
 */
import type { KeyBarPart, KeyProps, KeyStats, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import { answeredCount, cx } from "@quiz/ui";

import type { ClozeSolution, ClozeStudent } from "./schema.js";
import { clozeKeyStrings, type ClozeKeyStringKey } from "./strings.js";
import { ClozeFallbackText, type ClozeTextRenderer } from "./text.js";

/** The size of the text, per density: the only one this key draws (DESIGN.md, "Correction projection"). */
const SCALE = { wall: "text-[clamp(20px,2vw,30px)]", page: "text-[15px]" } as const;

type ClozeKeyProps = KeyProps<ClozeStudent | null, ClozeSolution> & {
  strings?: StringOverrides<ClozeKeyStringKey>;
  /** The host's markdown pipeline; the package's small one when absent. */
  renderText?: ClozeTextRenderer;
};

type Group = KeyStats["distribution"][number];

export function ClozeKey({ student, solution, revealed, density, stats, statement, Bar, strings, renderText }: ClozeKeyProps) {
  const s = resolveStrings(clozeKeyStrings, strings);
  const Text = renderText ?? ClozeFallbackText;
  const keys = new Map((solution?.blanks ?? []).map((b) => [b.index, b.expected]));
  const n = answeredCount(stats);
  const hole = (index: number) => {
    const groups = stats.distribution.filter((d) => d.part === index);
    const sum = (keep: (d: Group) => boolean) => groups.filter(keep).reduce((total, d) => total + d.count, 0);
    // A blank left empty is an absence like a question left blank, and
    // stays the track. The groups are never capped (ADR-033), so the filled
    // ones are `n` less the empty. Hidden, the bar is that one muted length:
    // how far the class got, since the right / wrong split IS the key.
    const filled = n - sum((d) => d.label === "") - stats.outcomes.blank;
    const right = sum((d) => d.label !== "" && d.correct === true);
    const parts: KeyBarPart[] = revealed
      ? [
          { tone: "success", label: s.correct, value: right },
          { tone: "danger", label: s.wrong, value: filled - right },
        ]
      : [{ tone: "muted", label: s.filled, value: filled }];
    return (
      <span className="mx-1 inline-flex min-w-[8ch] flex-col gap-1 align-middle leading-tight">
        <span
          className={cx(
            "border-b-2 px-2.5 text-center font-mono font-semibold",
            revealed ? "border-success text-success" : "border-dashed border-line-strong text-transparent",
          )}
          aria-hidden={!revealed}
        >
          {keys.get(index) ?? "…"}
        </span>
        {/* A parameterized cloze groups nothing by what was written (ADR-056
            §9): its blank holds the example's key, the head the verdicts. */}
        {stats.parameterized ? null : <Bar className="h-1.5" parts={parts} total={Math.max(1, n)} />}
      </span>
    );
  };
  return statement(
    <div
      className={cx(
        "max-w-[62ch] font-medium [&_.md-cloze]:text-[1em]! [&_.md-cloze_li]:leading-[2.6]! [&_.md-cloze_p]:leading-[2.6]!",
        SCALE[density],
      )}
    >
      <Text template={student?.template ?? ""} renderBlank={hole} />
    </div>,
  );
}
