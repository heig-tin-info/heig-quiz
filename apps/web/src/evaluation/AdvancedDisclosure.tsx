import { CategorizePolicy, categorizePolicyOf, McqPolicy, negativeMarkingOf, retakesOf, type EvaluationSettings, type FeedbackPolicy } from "@quiz/contracts";
import {
  allowedFeedbackWhen,
  CALCULATOR_MODES,
  calculatorAllowedFor,
  calculatorOn,
  partialRetakesOn,
  clockChoiceOf,
  feedbackWhenFor,
  isInClass,
  liveLobbies,
  NOTEPAD_MODES,
  notepadAllowedFor,
  notepadOn,
  type FeedbackWhen,
  type LobbyName,
} from "@quiz/domain";

import { usePublicConfig } from "../api";
import type { Dict } from "../i18n";
import { useT } from "../i18n";
import { Disclosure, Segmented, Select, SettingRow, Switch } from "../ui";
import { AllowedDevices } from "./AllowedDevices";
import type { ConfigPatch, ConfigView } from "./editTarget";

/**
 * `body`, a patch that sets the waiting room, with the feedback brought back
 * in the SAME patch when that room forbids the policy in force: a waiting
 * room makes the evaluation sat in class, where `immediate` is not allowed
 * (#78), and the server refuses the pair rather than fixing it. The one
 * writer of a lobby change, here and in the clock mode (`ConfigSettings`).
 */
export function withFeedbackFallback<B extends { settings: { lobby: LobbyName } }>(
  config: Pick<ConfigView, "mode" | "feedbackPolicy">,
  body: B,
): B & { feedbackPolicy?: { when: FeedbackWhen } } {
  const when = feedbackWhenFor({ mode: config.mode, lobby: body.settings.lobby }, config.feedbackPolicy.when);
  return when === config.feedbackPolicy.when ? body : { ...body, feedbackPolicy: { when } };
}

/**
 * Everything docs/spec/08 §8.2 puts under "Options avancées": the eight
 * settings a teacher who knows what they want reaches for, and which a novice
 * must never have to read to run their first quiz.
 *
 * Folded by default and not persisted (`Disclosure`): a header row that names
 * what is inside, so the teacher who wants one of these settings knows which
 * card to open without opening it.
 *
 * It reads and writes the configuration an evaluation and a template share
 * (`ConfigView`, `ConfigPatch`).
 */
export function AdvancedDisclosure({
  config,
  patch,
  disabled,
  feedbackDisabled,
  holdsCategorize = false,
}: {
  config: ConfigView;
  patch: ConfigPatch;
  /** The structural settings: frozen by an attempt, or by the run (#86). */
  disabled: boolean;
  /**
   * The feedback policy, as `isConfigFieldWritable` says: it outlives an
   * attempt (it may change until the release) and the run too, so a forgotten
   * answer key can be hidden mid-exam (#86).
   */
  feedbackDisabled: boolean;
  /**
   * The item list holds a `categorize` question: only then is its policy
   * row shown (docs/spec/08, a setting nobody needs is a setting nobody
   * reads). A poll never holds one.
   */
  holdsCategorize?: boolean;
}) {
  const t = useT();
  const { settings, feedbackPolicy, mode, mcqPolicy } = config;
  // ADR-051: the kiosk path exists on this platform (`KIOSK_ATTESTATION`).
  const kioskOffered = usePublicConfig().data?.kiosk != null;

  const set = (next: Partial<EvaluationSettings>) => patch.mutate({ settings: next });
  const feedback = (next: Partial<FeedbackPolicy>) => patch.mutate({ feedbackPolicy: next });
  const inClass = isInClass({ mode, lobby: settings.lobby });
  const clock = clockChoiceOf(settings);
  const calculator = calculatorOn(mode, settings.calculator);
  const notepad = notepadOn(mode, settings.notepad);
  // ADR-090: a retake of the questions to review needs free navigation, so
  // the navigation stays put while it is on (`422 retake_scope_navigation`).
  const partialRetake = partialRetakesOn(mode, retakesOf(settings));
  // ADR-026: negative marking replaces both policies below; each row says so
  // while it is on, so a teacher never tunes a policy nothing reads.
  const policyDesc = (desc: string) =>
    negativeMarkingOf(settings) && mode !== "poll" ? `${desc} ${t("eval.policy.overridden")}` : desc;

  return (
    <Disclosure title={t("eval.advanced")} desc={t("eval.advanced.desc")}>
      <SettingRow
        title={t("eval.navigation")}
        desc={
          partialRetake
            ? `${t(`eval.navigation.desc.${settings.navigation}` as keyof Dict)} ${t("eval.navigation.partialRetake")}`
            : t(`eval.navigation.desc.${settings.navigation}` as keyof Dict)
        }
      >
        <Segmented
          name="navigation"
          value={settings.navigation}
          disabled={disabled || partialRetake}
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

      {/* ADR-086: a Live evaluation's waiting room; a Scheduled one has
          none, its mode says so. */}
      {clock.mode === "live" ? (
        <SettingRow
          title={t("eval.lobby")}
          desc={t(`eval.lobby.desc.${settings.lobby}` as keyof Dict)}
        >
          <Segmented
            name="lobby"
            value={settings.lobby}
            disabled={disabled}
            onChange={(lobby) => {
              patch.mutate(withFeedbackFallback(config, { settings: { lobby } }));
            }}
            options={liveLobbies(clock.limited).map((value) => ({
              value,
              label: t(`eval.lobby.${value}`),
            }))}
          />
        </SettingRow>
      ) : null}

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
      {/* ADR-069: the calculator the student's screen provides. A poll has
          nothing to compute. */}
      {calculatorAllowedFor(mode) ? (
        <SettingRow title={t("eval.calculator")} desc={t(`eval.calculator.desc.${calculator}`)}>
          <Segmented
            name="calculator"
            label={t("eval.calculator")}
            value={calculator}
            disabled={disabled}
            onChange={(calculator) => set({ calculator })}
            options={CALCULATOR_MODES.map((value) => ({
              value,
              label: t(`eval.calculator.${value}`),
            }))}
          />
        </SettingRow>
      ) : null}
      {/* ADR-090: its sibling, the notepad — on the same modes. */}
      {notepadAllowedFor(mode) ? (
        <SettingRow title={t("eval.notepad")} desc={t(`eval.notepad.desc.${notepad}`)}>
          <Segmented
            name="notepad"
            label={t("eval.notepad")}
            value={notepad}
            disabled={disabled}
            onChange={(notepad) => set({ notepad })}
            options={NOTEPAD_MODES.map((value) => ({
              value,
              label: t(`eval.notepad.${value}`),
            }))}
          />
        </SettingRow>
      ) : null}

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

      {/* ADR-027, ADR-051 §2: where an exam may be sat — its two trusted
          clients, chosen as one. */}
      {mode === "exam" ? (
        <AllowedDevices settings={settings} kioskOffered={kioskOffered} disabled={disabled} onChange={set} />
      ) : null}
    </Disclosure>
  );
}
