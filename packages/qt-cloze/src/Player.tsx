/**
 * The `cloze` player (in `apps/web/src/student/Player.tsx`): the text as the
 * teacher wrote it, with a field or a dropdown at each blank.
 *
 * Controlled — the host owns the answer and autosaves it. A dropdown stores the
 * CANONICAL option index as a decimal string (decision D4), so the shuffled
 * order on screen never changes what was stored.
 *
 * With an `answerKey` (a teacher's preview, "Show answers", #554) each blank
 * shows its expected answer inside its own field, in the success tone: as the
 * placeholder of a text field, as the empty option of a dropdown. Nothing is
 * added around the field, so the text (a table above all) keeps the layout it
 * has without the key.
 */
import type { PlayerProps, StringOverrides } from "@quiz/core/client";
import { resolveStrings } from "@quiz/core/client";
import type { ClozeAnswer, ClozeSolution, ClozeStudent } from "./schema.js";
import { clozePlayerStrings, type ClozePlayerStringKey } from "./strings.js";
import { ClozeFallbackText, type ClozeTextRenderer } from "./text.js";
import { caption, cx, inputClass, isLocked } from "@quiz/ui";

type ClozePlayerProps = PlayerProps<ClozeStudent, ClozeAnswer, ClozeSolution> & {
  /** Alias of `readOnly`, for hosts that speak in disabled controls. */
  disabled?: boolean;
  strings?: StringOverrides<ClozePlayerStringKey>;
  /** The host's markdown pipeline; a small built-in one is used when absent. */
  renderText?: ClozeTextRenderer;
};

/** The stored answer always has one slot per blank, so an index never shifts. */
function withBlank(
  blanks: readonly (string | null)[],
  count: number,
  index: number,
  value: string,
): ClozeAnswer {
  const next = Array.from({ length: count }, (_, i) => blanks[i] ?? null);
  next[index] = value;
  return { blanks: next };
}

export function ClozePlayer({
  student,
  answer,
  onChange,
  readOnly,
  answerKey,
  disabled,
  strings,
  renderText,
}: ClozePlayerProps) {
  const s = resolveStrings(clozePlayerStrings, strings);
  const locked = isLocked(readOnly, disabled);
  const given = answer?.blanks ?? [];
  const count = student.blanks.length;
  const expected = new Map(answerKey?.blanks.map((blank) => [blank.index, blank.expected]) ?? []);

  const renderField = (index: number) => {
    const blank = student.blanks.find((b) => b.index === index);
    if (blank === undefined) return null;
    const label = `${s.blank} ${index + 1}`;
    const value = given[index] ?? "";
    const key = expected.get(index);
    const title = key === undefined ? undefined : `${s.expected}: ${key}`;
    const keyClass = key !== undefined && "!border-success/60 placeholder:font-mono placeholder:!text-success";

    if (blank.kind === "select") {
      return (
        <select
          aria-label={label}
          title={title}
          className={cx(
            inputClass,
            "mx-0.5 h-8 align-baseline",
            keyClass,
            key !== undefined && value === "" && "font-mono !text-success",
          )}
          value={value}
          disabled={locked}
          onChange={(e) => onChange(withBlank(given, count, index, e.target.value))}
        >
          <option value="">{key ?? s.choose}</option>
          {blank.options.map((option) => (
            <option key={option.id} value={String(option.id)}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        type="text"
        aria-label={label}
        inputMode={blank.numeric ? "decimal" : undefined}
        autoComplete="off"
        spellCheck={false}
        size={Math.max(6, value.length + 2, (key?.length ?? 0) + 2)}
        maxLength={200}
        placeholder={key}
        title={title}
        className={cx(inputClass, "mx-0.5 h-8 align-baseline", keyClass)}
        value={value}
        disabled={locked}
        onChange={(e) => onChange(withBlank(given, count, index, e.target.value))}
      />
    );
  };

  const Text = renderText ?? ClozeFallbackText;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        <Text template={student.template} renderBlank={renderField} />
      </div>
      <p className={caption}>{s.hint}</p>
    </div>
  );
}
