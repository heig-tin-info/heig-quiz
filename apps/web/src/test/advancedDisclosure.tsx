/**
 * The shared harness of the `AdvancedDisclosure` tests: the disclosure of one
 * evaluation, wired to the real patch hook, and the click that unfolds it.
 */
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { EvaluationDetail, EvaluationSettings } from "@quiz/contracts";

import { EVALUATION_ID, makeEvaluationDetail } from "./live-fixtures";
import { AdvancedDisclosure } from "../evaluation/AdvancedDisclosure";
import { evaluationTarget } from "../evaluation/editTarget";
import { useConfigPatch } from "../evaluation/usePatch";

/** The fixture evaluation, in `mode`, with `settings` laid over its own. */
export const withMode = (
  mode: EvaluationDetail["evaluation"]["mode"],
  settings: Partial<EvaluationSettings> = {},
): EvaluationDetail => {
  const detail = makeEvaluationDetail();
  return {
    ...detail,
    evaluation: { ...detail.evaluation, mode, settings: { ...detail.evaluation.settings, ...settings } },
  };
};

export function Harness({
  detail,
  disabled = false,
  holdsCategorize = false,
}: {
  detail: EvaluationDetail;
  disabled?: boolean;
  holdsCategorize?: boolean;
}) {
  const patch = useConfigPatch(evaluationTarget(EVALUATION_ID));
  return (
    <AdvancedDisclosure
      config={detail.evaluation}
      patch={patch}
      disabled={disabled}
      feedbackDisabled={false}
      holdsCategorize={holdsCategorize}
    />
  );
}

export const PATCH = `PATCH /app/api/evaluations/${EVALUATION_ID}`;

export async function open() {
  await userEvent.click(screen.getByRole("button", { name: /^advanced options$/i }));
}
