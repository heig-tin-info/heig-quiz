import { describe, expect, it } from "vitest";

import { DICTS, loadLocale, type Locale, type TFunction } from "../i18n";
import { makeEvaluationDetail } from "../test/live-fixtures";
import { clockSummary } from "./clockSummary";

await loadLocale("fr");

/** The real dictionaries: a missing `fr` fragment fails here, not silently. */
function makeT(locale: Locale): TFunction {
  return (key, vars) => {
    const raw = DICTS[locale]![key as string] ?? String(key);
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

describe("clockSummary (#87, ADR-086)", () => {
  it("says the duration in force, not a default", () => {
    const e = evaluation({
      settings: { timing: "duration", lobby: "manual", navigation: "free" },
      durationS: 30 * 60,
      when: "on_release",
    });
    expect(clockSummary(e, makeT("en"), date)).toBe(
      "30 minutes each, waiting room opened by you, free navigation, results released afterwards.",
    );
    expect(clockSummary(e, makeT("fr"), date)).toBe(
      "30 minutes par étudiant, salle d'attente que vous ouvrez, navigation libre, résultats publiés ensuite.",
    );
  });

  it("follows every setting it names", () => {
    const e = evaluation({
      settings: { timing: "duration", lobby: "manual", navigation: "forward_only" },
      durationS: 60,
      when: "none",
    });
    expect(clockSummary(e, makeT("en"), date)).toBe(
      "1 minute each, waiting room opened by you, no going back, no feedback to students.",
    );
  });

  it("names a scheduled end, or says it is missing, and no waiting room it never has", () => {
    const e = evaluation({
      settings: { timing: "deadline", lobby: "skip", navigation: "milestones" },
      closesAt: "2026-10-02T08:00:00.000Z",
      when: "immediate",
    });
    expect(clockSummary(e, makeT("en"), date)).toBe(
      "Open until <2026-10-02>, no going back past a milestone, feedback as each question is validated.",
    );
    expect(clockSummary({ ...e, closesAt: null }, makeT("fr"), date)).toMatch(
      /^Date de fin pas encore fixée, pas de retour au-delà d'un jalon, /,
    );
  });

  it("names a live evaluation's safety deadline (ADR-086)", () => {
    const e = evaluation({
      settings: { timing: "manual", lobby: "manual", navigation: "free" },
      closesAt: "2026-10-02T08:00:00.000Z",
      when: "on_release",
    });
    expect(clockSummary(e, makeT("en"), date)).toMatch(
      /^Open until you close it, <2026-10-02> at the latest, waiting room opened by you, /,
    );
    expect(clockSummary({ ...e, closesAt: null }, makeT("fr"), date)).toMatch(/^Ouvert jusqu'à ce que vous le clôturiez, salle d'attente/);
  });

  it("says a duration is missing rather than inventing one", () => {
    const e = evaluation({ settings: { timing: "duration", lobby: "auto" }, durationS: null });
    expect(clockSummary(e, makeT("en"), date)).toMatch(
      /^Duration not set yet, starts once everyone is in, /,
    );
  });
});
