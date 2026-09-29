import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

import { CategorizePolicy, categorizePolicyOf, McqPolicy, negativeMarkingOf, safeExamBrowserOf, type EvaluationPatch, type EvaluationSettings, type FeedbackPolicy } from "@quiz/contracts";
import { allowedFeedbackWhen, feedbackWhenFor, isInClass } from "@quiz/domain";

import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { Button, Card, cx, inputClass, inputSize, Segmented, Select, SettingRow, Switch } from "../ui";
import type { ConfigPatch, ConfigView } from "./editTarget";
import type { ConfigWriter } from "./usePatch";

/**
 * Everything docs/spec/08 §8.2 puts under "Options avancées": the eight
 * settings a teacher who knows what they want reaches for, and which a novice
 * must never have to read to run their first quiz.
 *
 * Folded by default and not persisted. A disclosure that remembers being open
 * is a disclosure that is always open, and then it is not a disclosure.
 *
 * It reads and writes the configuration an evaluation and a template share
 * (`ConfigView`, `ConfigPatch`); what only a run has — the access code — is
 * a row the evaluation hands in as `children`, in its place in the list.
 */
export function AdvancedDisclosure({
  config,
  totalPoints,
  patch,
  disabled,
  feedbackDisabled,
  holdsCategorize = false,
  children,
}: {
  config: ConfigView;
  /** The threshold scale's default pass mark. */
  totalPoints: number;
  patch: ConfigPatch;
  /** The structural settings: frozen by an attempt, or by the run (#86). */
  disabled: boolean;
  /**
   * The feedback policy, as `isConfigFieldWritable` says: it outlives an
   * attempt (it may change until the release) and the run too, so a forgotten
   * answer key can be hidden mid-exam (#86). The access code is never
   * disabled — a student locked out mid-exam must be let back in.
   */
  feedbackDisabled: boolean;
  /**
   * The item list holds a `categorize` question: only then is its policy
   * row shown (docs/spec/08, a setting nobody needs is a setting nobody
   * reads). A poll never holds one.
   */
  holdsCategorize?: boolean;
  /** The rows of a run's own (the access code), before the grade scale. */
  children?: ReactNode;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const { settings, feedbackPolicy, mode, mcqPolicy, gradingScale } = config;

  const set = (next: Partial<EvaluationSettings>) => patch.mutate({ settings: next });
  const feedback = (next: Partial<FeedbackPolicy>) => patch.mutate({ feedbackPolicy: next });
  const inClass = isInClass({ mode, lobby: settings.lobby });
  // ADR-026: negative marking replaces both policies below; each row says so
  // while it is on, so a teacher never tunes a policy nothing reads.
  const policyDesc = (desc: string) =>
    negativeMarkingOf(settings) && mode !== "poll" ? `${desc} ${t("eval.policy.overridden")}` : desc;

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
            onChange={(lobby) => {
              // A waiting room makes the evaluation sat in class, where
              // `immediate` is not allowed (#78): the policy falls back in
              // the SAME patch, since the server refuses the pair otherwise.
              const when = feedbackWhenFor({ mode, lobby }, feedbackPolicy.when);
              patch.mutate({
                settings: { lobby },
                ...(when === feedbackPolicy.when ? {} : { feedbackPolicy: { when } }),
              });
            }}
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

        {/* F-EVAL-11 and #78: `immediate` is hidden, not disabled, for an
            evaluation sat in class (an exam, or an exercise with a waiting
            room) — the same treatment as `student_choice` above. The row
            then says why, so the missing choice is not a mystery. */}
        <SettingRow
          title={t("eval.feedback")}
          desc={
            <>
              {t(`eval.feedback.desc.${feedbackPolicy.when}` as keyof Dict)}
              {inClass ? (
                <span className="mt-0.5 block text-fg-faint">{t("eval.feedback.inClassHint")}</span>
              ) : null}
            </>
          }
        >
          <Segmented
            name="feedback"
            value={feedbackPolicy.when}
            disabled={feedbackDisabled}
            onChange={(when) => feedback({ when })}
            options={allowedFeedbackWhen({ mode, lobby: settings.lobby }).map((when) => ({
              value: when,
              label: t(`eval.feedback.${when}` as keyof Dict),
            }))}
          />
        </SettingRow>
        <SettingRow title={t("eval.feedback.showKey")}>
          <Switch
            checked={feedbackPolicy.showKey}
            disabled={feedbackDisabled}
            label={t("eval.feedback.showKey")}
            onChange={(showKey) => feedback({ showKey })}
          />
        </SettingRow>
        <SettingRow title={t("eval.feedback.showExplanation")}>
          <Switch
            checked={feedbackPolicy.showExplanation}
            disabled={feedbackDisabled}
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
          desc={policyDesc(t(`mcq.policy.desc.${mcqPolicy}` as keyof Dict))}
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

        {/* ADR-036: the same, for the categorize items that say "inherited",
            shown only while the evaluation holds one. */}
        {holdsCategorize ? (
          <SettingRow
            title={t("eval.categorizePolicy")}
            desc={policyDesc(t(`eval.categorizePolicy.desc.${categorizePolicyOf(settings)}`))}
          >
            <Segmented
              name="categorizePolicy"
              label={t("eval.categorizePolicy")}
              value={categorizePolicyOf(settings)}
              disabled={disabled}
              onChange={(categorizePolicy) => set({ categorizePolicy })}
              options={CategorizePolicy.options.map((policy) => ({
                value: policy,
                label: t(`eval.categorizePolicy.${policy}`),
              }))}
            />
          </SettingRow>
        ) : null}

        {/* ADR-026: negative marking, beside the policies it overrides. For
            the whole evaluation, never per question, and frozen with the
            rest of what decides a score. A poll has no score to penalise. */}
        {mode === "poll" ? null : (
          <SettingRow title={t("eval.negativeMarking")} desc={t("eval.negativeMarking.desc")}>
            <Switch
              checked={negativeMarkingOf(settings)}
              disabled={disabled}
              label={t("eval.negativeMarking")}
              onChange={(negativeMarking) => set({ negativeMarking })}
            />
          </SettingRow>
        )}

        {/* ADR-027: an exam sat in Safe Exam Browser only. */}
        {mode === "exam" ? (
          <SettingRow title={t("eval.seb")} desc={t("eval.seb.desc")}>
            <Switch
              checked={safeExamBrowserOf(settings)}
              disabled={disabled}
              label={t("eval.seb")}
              onChange={(safeExamBrowser) => set({ safeExamBrowser })}
            />
          </SettingRow>
        ) : null}

        {children}

        <SettingRow
          title={t("eval.scale")}
          desc={
            gradingScale.kind === "linear"
              ? t("eval.scale.desc.linear")
              : t("eval.scale.desc.threshold")
          }
        >
          <Segmented
            name="scale"
            value={gradingScale.kind}
            disabled={disabled}
            onChange={(kind) =>
              patch.mutate({
                gradingScale:
                  kind === "linear"
                    ? { kind: "linear", rounding: "nearest" }
                    : {
                        kind: "threshold",
                        rounding: "nearest",
                        threshold: Math.max(1, totalPoints || 1),
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

/**
 * The access code (F-EVAL-12), a row of the advanced options that only a run
 * has: a template leaves it to each evaluation made from it.
 */
export function AccessCodeRow({
  accessCode,
  patch,
}: {
  accessCode: string | null;
  patch: ConfigWriter<EvaluationPatch>;
}) {
  const t = useT();
  const [code, setCode] = useState(accessCode ?? "");
  return (
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
  );
}
