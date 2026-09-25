import { describe, expect, it } from "vitest";

import { DICTS, type Locale, type TFunction } from "../i18n";
import { makeEvaluationDetail } from "../test/live-fixtures";
import { presetSummary } from "./presetSummary";

/** The real dictionaries: a missing `fr` fragment fails here, not silently. */
function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = DICTS[locale][key as string] ?? String(key);
    return vars ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
  };
}

const date = (iso: string) => `<${iso.slice(0, 10)}>`;

function evaluation(over: {
  settings?: Partial<ReturnType<typeof makeEvaluationDetail>["evaluation"]["settings"]>;
  durationS?: number | null;
  closesAt?: string | null;
  when?: "none" | "on_release" | "immediate";
}) {
  const base = makeEvaluationDetail().evaluation;
  return {
    ...base,
    settings: { ...base.settings, ...over.settings },
    durationS: over.durationS === undefined ? base.durationS : over.durationS,
    closesAt: over.closesAt === undefined ? base.closesAt : over.closesAt,
    feedbackPolicy: { ...base.feedbackPolicy, when: over.when ?? base.feedbackPolicy.when },
  };
}

describe("presetSummary (#87)", () => {
  it("says the duration in force, not the preset's 45 minutes", () => {
    const e = evaluation({
      settings: { timing: "duration", lobby: "manual", navigation: "free" },
      durationS: 30 * 60,
      when: "on_release",
    });
    expect(presetSummary(e, makeT("en"), date)).toBe(
      "30 minutes each, waiting room opened by you, free navigation, results released afterwards.",
    );
    expect(presetSummary(e, makeT("fr"), date)).toBe(
      "30 minutes par étudiant, salle d'attente que vous ouvrez, navigation libre, résultats publiés ensuite.",
    );
  });

  it("follows every setting it names", () => {
    const e = evaluation({
      settings: { timing: "duration", lobby: "manual", navigation: "forward_only" },
      durationS: 60,
      when: "none",
    });
    expect(presetSummary(e, makeT("en"), date)).toBe(
      "1 minute each, waiting room opened by you, no going back, no feedback to students.",
    );
  });

  it("names the common deadline, or says it is missing", () => {
    const e = evaluation({
      settings: { timing: "deadline", lobby: "skip", navigation: "milestones" },
      closesAt: "2026-10-02T08:00:00.000Z",
      when: "immediate",
    });
    expect(presetSummary(e, makeT("en"), date)).toBe(
      "Open until <2026-10-02>, no waiting room, no going back past a milestone, feedback as each question is validated.",
    );
    expect(presetSummary({ ...e, closesAt: null }, makeT("fr"), date)).toMatch(
      /^Date limite commune pas encore fixée, pas de salle d'attente, /,
    );
  });

  it("says a duration is missing rather than inventing one", () => {
    const e = evaluation({ settings: { timing: "duration", lobby: "auto" }, durationS: null });
    expect(presetSummary(e, makeT("en"), date)).toMatch(
      /^Duration not set yet, starts once everyone is in, /,
    );
  });
});
