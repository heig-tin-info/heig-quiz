import type { EvaluationMode } from "@quiz/contracts";

import { useT } from "../i18n";
import { Segmented } from "../ui";

/** The two modes a new evaluation or a new template can take: a poll is neither. */
export type CreatedMode = Exclude<EvaluationMode, "poll">;

/**
 * The mode of a new evaluation or a new template, with the sentence that
 * says what it implies. The mode also names the preset the creation sends
 * (`preset: mode`), so what the sentence promises is what the server sets.
 * One control for the two creation dialogs, so they cannot word it apart.
 */
export function ModeChoice({
  value,
  onChange,
}: {
  value: CreatedMode;
  onChange: (mode: CreatedMode) => void;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <span className="text-[13px] font-medium">{t("eval.mode")}</span>
      <div>
        <Segmented
          name="eval-mode"
          label={t("eval.mode")}
          value={value}
          onChange={onChange}
          options={[
            { value: "exam", label: t("eval.mode.exam") },
            { value: "exercise", label: t("eval.mode.exercise") },
          ]}
        />
      </div>
      <p className="text-[13px] text-fg-muted">{t(`eval.mode.desc.${value}`)}</p>
    </div>
  );
}
