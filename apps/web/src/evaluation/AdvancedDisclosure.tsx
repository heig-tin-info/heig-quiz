import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { McqPolicy, type EvaluationDetail, type EvaluationSettings, type FeedbackPolicy } from "@quiz/contracts";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { Button, Card, cx, inputClass, inputSize, Segmented, Select, SettingRow, Switch } from "../ui";
import type { useEvaluationPatch } from "./usePatch";

/**
 * Everything docs/spec/08 §8.2 puts under "Options avancées": the eight
 * settings a teacher who knows what they want reaches for, and which a novice
 * must never have to read to run their first quiz.
 *
 * Folded by default and not persisted. A disclosure that remembers being open
 * is a disclosure that is always open, and then it is not a disclosure.
 */
export function AdvancedDisclosure({
  detail,
  patch,
  disabled,
}: {
  detail: EvaluationDetail;
  patch: ReturnType<typeof useEvaluationPatch>;
  disabled: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { settings, feedbackPolicy, accessCode, mode, mcqPolicy } = detail.evaluation;
  const [code, setCode] = useState(accessCode ?? "");

  const set = (next: Partial<EvaluationSettings>) => patch.mutate({ settings: next });
  const feedback = (next: Partial<FeedbackPolicy>) => patch.mutate({ feedbackPolicy: next });

  if (!open) {
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <ChevronDown /> {t("eval.advanced")}
      </Button>
    );
  }

  return (
    <div className="space-y-3">
      <Button variant="secondary" onClick={() => setOpen(false)}>
        <ChevronUp /> {t("eval.advanced.hide")}
      </Button>
      <Card className="divide-y divide-line px-4">
        <SettingRow
          title={t("eval.navigation")}
          desc={t(`eval.navigation.desc.${settings.navigation}` as keyof Dict)}
        >
          <Segmented
            name="navigation"
            value={settings.navigation}
            disabled={disabled}
            onChange={(navigation) => set({ navigation })}
            options={[
              { value: "free", label: t("eval.navigation.free") },
              { value: "forward_only", label: t("eval.navigation.forward_only") },
              { value: "milestones", label: t("eval.navigation.milestones") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("eval.presentation")} desc={t("eval.presentation.desc")}>
          <Segmented
            name="presentation"
            value={settings.presentation}
            disabled={disabled}
            onChange={(presentation) => set({ presentation })}
            options={[
              { value: "zen", label: t("eval.presentation.zen") },
              { value: "continuous", label: t("eval.presentation.continuous") },
              // F-EVAL-08: only offered when navigation is free.
              ...(settings.navigation === "free"
                ? [
                    {
                      value: "student_choice" as const,
                      label: t("eval.presentation.student_choice"),
                    },
                  ]
                : []),
            ]}
          />
        </SettingRow>

        <SettingRow
          title={t("eval.lobby")}
          desc={t(`eval.lobby.desc.${settings.lobby}` as keyof Dict)}
        >
          <Segmented
            name="lobby"
            value={settings.lobby}
            disabled={disabled}
            onChange={(lobby) => set({ lobby })}
            options={[
              { value: "skip", label: t("eval.lobby.skip") },
              { value: "auto", label: t("eval.lobby.auto") },
              { value: "manual", label: t("eval.lobby.manual") },
            ]}
          />
        </SettingRow>

        <SettingRow title={t("eval.shuffleItems")} desc={t("eval.shuffleItems.desc")}>
          <Switch
            checked={settings.shuffleItems}
            disabled={disabled}
            label={t("eval.shuffleItems")}
            onChange={(shuffleItems) => set({ shuffleItems })}
          />
        </SettingRow>
        <SettingRow title={t("eval.shuffleChoices")} desc={t("eval.shuffleChoices.desc")}>
          <Switch
            checked={settings.shuffleChoices}
            disabled={disabled}
            label={t("eval.shuffleChoices")}
            onChange={(shuffleChoices) => set({ shuffleChoices })}
          />
        </SettingRow>
        <SettingRow title={t("eval.showProgressBar")} desc={t("eval.showProgressBar.desc")}>
          <Switch
            checked={settings.showProgressBar}
            disabled={disabled}
            label={t("eval.showProgressBar")}
            onChange={(showProgressBar) => set({ showProgressBar })}
          />
        </SettingRow>
        <SettingRow title={t("eval.logVisibility")} desc={t("eval.logVisibility.desc")}>
          <Switch
            checked={settings.logVisibility}
            disabled={disabled}
            label={t("eval.logVisibility")}
            onChange={(logVisibility) => set({ logVisibility })}
          />
        </SettingRow>
        <SettingRow title={t("eval.requireFullscreen")} desc={t("eval.requireFullscreen.desc")}>
          <Switch
            checked={settings.requireFullscreen}
            disabled={disabled}
            label={t("eval.requireFullscreen")}
            onChange={(requireFullscreen) => set({ requireFullscreen })}
          />
        </SettingRow>

        <SettingRow
          title={t("eval.feedback")}
          desc={t(`eval.feedback.desc.${feedbackPolicy.when}` as keyof Dict)}
        >
          <Segmented
            name="feedback"
            value={feedbackPolicy.when}
            onChange={(when) => feedback({ when })}
            options={[
              { value: "none", label: t("eval.feedback.none") },
              { value: "on_release", label: t("eval.feedback.on_release") },
              // F-EVAL-11: immediate feedback is for exercises and polls.
              ...(mode === "exam"
                ? []
                : [{ value: "immediate" as const, label: t("eval.feedback.immediate") }]),
            ]}
          />
        </SettingRow>
        <SettingRow title={t("eval.feedback.showKey")}>
          <Switch
            checked={feedbackPolicy.showKey}
            label={t("eval.feedback.showKey")}
            onChange={(showKey) => feedback({ showKey })}
          />
        </SettingRow>
        <SettingRow title={t("eval.feedback.showExplanation")}>
          <Switch
            checked={feedbackPolicy.showExplanation}
            label={t("eval.feedback.showExplanation")}
            onChange={(showExplanation) => feedback({ showExplanation })}
          />
        </SettingRow>

        {/* docs/04 §4.4: what every mcq item of this evaluation that says
            "inherited" is scored with. A question that names its own policy
            overrides it, and a single-answer question is always all or
            nothing. Frozen once an attempt exists, like the rest of what
            decides a score. */}
        <SettingRow
          title={t("mcq.policy.title")}
          desc={t(`mcq.policy.desc.${mcqPolicy}` as keyof Dict)}
          help="mcq-policies"
        >
          <Select
            value={mcqPolicy}
            disabled={disabled}
            size="sm"
            width="w-52"
            aria-label={t("mcq.policy.title")}
            onChange={(e) => patch.mutate({ mcqPolicy: e.target.value as McqPolicy })}
          >
            {McqPolicy.options.map((policy) => (
              <option key={policy} value={policy}>
                {t(`mcq.policy.${policy}` as keyof Dict)}
              </option>
            ))}
          </Select>
        </SettingRow>

        <SettingRow title={t("eval.accessCode")} desc={t("eval.accessCode.desc")}>
          <input
            aria-label={t("eval.accessCode")}
            placeholder={t("eval.accessCodePlaceholder")}
            className={cx(inputClass, inputSize.sm, "w-44")}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onBlur={() => {
              const next = code.trim();
              if (next === (accessCode ?? "")) return;
              // F-EVAL-12: three characters is the schema's floor; an empty
              // field means "no code at all", which is a null and not a "".
              if (next !== "" && next.length < 3) return;
              patch.mutate({ accessCode: next === "" ? null : next });
            }}
          />
        </SettingRow>

        <SettingRow
          title={t("eval.scale")}
          desc={
            detail.evaluation.gradingScale.kind === "linear"
              ? t("eval.scale.desc.linear")
              : t("eval.scale.desc.threshold")
          }
        >
          <Segmented
            name="scale"
            value={detail.evaluation.gradingScale.kind}
            disabled={disabled}
            onChange={(kind) =>
              patch.mutate({
                gradingScale:
                  kind === "linear"
                    ? { kind: "linear", rounding: "nearest" }
                    : {
                        kind: "threshold",
                        rounding: "nearest",
                        threshold: Math.max(1, detail.totalPoints || 1),
                      },
              })
            }
            options={[
              { value: "linear", label: t("eval.scale.linear") },
              { value: "threshold", label: t("eval.scale.threshold") },
            ]}
          />
        </SettingRow>
      </Card>
    </div>
  );
}
