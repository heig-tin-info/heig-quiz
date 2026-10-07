/**
 * The pre-flight checklist of #152 as data, without a render: which rows a
 * detail yields, at which level, in which order, with which fix. The line
 * between `blocker` and the rest is the server's (`guardTransition`), so
 * each blocker below is one the API refuses too.
 *
 * `t` echoes the key and its variables, so an assertion names the message
 * chosen rather than its wording; one test reads the real dictionaries.
 */
import { describe, expect, it } from "vitest";

import type { EvaluationDetail } from "@quiz/contracts";

import { DICTS, loadLocale, type TFunction } from "../i18n";
import { makeEvaluationDetail, makeItemRow } from "../test/live-fixtures";
import { launchChecks, readiness, type LaunchCheck } from "./launchChecks";

await loadLocale("fr");

const t: TFunction = (key, vars) => (vars ? `${String(key)} ${JSON.stringify(vars)}` : String(key));
const date = (iso: string) => `<${iso}>`;
const NOW = Date.parse("2026-09-20T10:00:00.000Z");
const HOUR = 3_600_000;
const at = (offset: number) => new Date(NOW + offset).toISOString();

function detailWith(
  patch: Partial<EvaluationDetail["evaluation"]> = {},
  over: Partial<EvaluationDetail> = {},
  settings: Partial<EvaluationDetail["evaluation"]["settings"]> = {},
): EvaluationDetail {
  const base = makeEvaluationDetail(over);
  return {
    ...base,
    evaluation: { ...base.evaluation, ...patch, settings: { ...base.evaluation.settings, ...settings } },
  };
}

const checks = (detail: EvaluationDetail, kiosk = true) => launchChecks(detail, t, NOW, date, kiosk);
const byId = (rows: LaunchCheck[], id: LaunchCheck["id"]) => rows.filter((r) => r.id === id);
const one = (rows: LaunchCheck[], id: LaunchCheck["id"]) => {
  const found = byId(rows, id);
  expect(found).toHaveLength(1);
  return found[0]!;
};

describe("launchChecks: a ready evaluation", () => {
  it("has no blocker nor warning, and says what it holds", () => {
    const rows = checks(makeEvaluationDetail());
    expect(readiness(rows)).toEqual({ blockers: 0, warnings: 0 });
    expect(rows.map((r) => r.id)).toEqual(["items", "roster", "timing", "feedback", "rules", "access"]);

    const items = one(rows, "items");
    expect(items).toMatchObject({ level: "ok", fix: { kind: "step", step: "questions" } });
    expect(items.title).toBe('launch.items {"n":2,"points":2}');

    // Unlinked accounts are information, never a warning (nobody signed in yet).
    const roster = one(rows, "roster");
    expect(roster.level).toBe("ok");
    expect(roster.detail).toBe('launch.roster.unlinked {"n":2}');

    expect(one(rows, "timing")).toMatchObject({ level: "ok", detail: "launch.lobby.manual" });
    expect(one(rows, "feedback").level).toBe("info");
    expect(one(rows, "access")).toMatchObject({
      level: "info",
      title: "launch.access.open",
      detail: "launch.access.open.detail",
    });
  });

  it("uses the singular forms for one item, one student, one unlinked account", () => {
    const rows = checks(
      makeEvaluationDetail({
        items: [makeItemRow(0, { points: 3 })],
        roster: { enrolled: 1, unlinked: 1, conflicts: 0 },
      }),
    );
    expect(one(rows, "items").title).toBe('launch.items.one {"points":3}');
    expect(one(rows, "roster")).toMatchObject({ title: "launch.roster.one", detail: "launch.roster.unlinkedOne" });
  });

  it("says every account is linked when none is missing", () => {
    const rows = checks(makeEvaluationDetail({ roster: { enrolled: 5, unlinked: 0, conflicts: 0 } }));
    expect(one(rows, "roster").detail).toBe("launch.roster.allLinked");
  });

  it("counts each question type once, in the order the items first use it", () => {
    const rows = checks(
      makeEvaluationDetail({
        items: [
          makeItemRow(0, { type: "short" }),
          makeItemRow(1, { type: "mcq" }),
          makeItemRow(2, { type: "short" }),
        ],
      }),
    );
    const mix = one(rows, "items").detail.split(" · ");
    expect(mix).toHaveLength(2);
    expect(mix[0]).toMatch(/"n":2/);
    expect(mix[1]).toMatch(/"n":1/);
  });
});

describe("launchChecks: the blockers are the server's", () => {
  it("blocks an evaluation with no question, the fix being the questions step", () => {
    const rows = checks(makeEvaluationDetail({ items: [] }));
    expect(one(rows, "items")).toMatchObject({
      level: "blocker",
      title: "launch.items.none",
      detail: "eval.launch.needQuestions",
      fix: { kind: "step", step: "questions" },
    });
    expect(readiness(rows).blockers).toBe(1);
  });

  it("blocks an exam whose every point is a bonus (ADR-052), never a poll", () => {
    const bonusOnly = { items: [makeItemRow(0)], totalPoints: 0 };
    expect(one(checks(makeEvaluationDetail(bonusOnly)), "items")).toMatchObject({
      level: "blocker",
      title: "launch.items.noGradedPoints",
    });
    expect(one(checks(detailWith({ mode: "poll" }, bonusOnly)), "items").level).toBe("ok");
  });

  it("blocks an incomplete timing, listing what is missing, with its own status line", () => {
    const rows = checks(detailWith({ durationS: null }));
    const timing = one(rows, "timing");
    expect(timing).toMatchObject({
      level: "blocker",
      title: "launch.timing.incomplete",
      status: "eval.launch.needTiming",
      detail: "eval.missing.durationS",
      fix: { kind: "step", step: "timing" },
    });
  });

  it("blocks a common end already past (#178); scheduled, the way out is not the timing step", () => {
    const past = { opensAt: at(-2 * HOUR), closesAt: at(-HOUR), durationS: null };
    const draft = one(checks(detailWith(past, {}, { timing: "deadline" })), "timing");
    expect(draft).toMatchObject({
      level: "blocker",
      title: "launch.timing.past",
      detail: `launch.timing.past.detail {"date":"<${past.closesAt}>"}`,
      fix: { kind: "step", step: "timing" },
    });

    const scheduled = one(checks(detailWith({ ...past, state: "scheduled" }, {}, { timing: "deadline" })), "timing");
    expect(scheduled.level).toBe("blocker");
    expect(scheduled.detail).toBe(`launch.timing.past.scheduled {"date":"<${past.closesAt}>"}`);
    expect(scheduled.fix).toBeUndefined();
  });

  it("treats a common end exactly now as past, and one a millisecond ahead as fine", () => {
    const deadline = (closesAt: string) =>
      one(checks(detailWith({ opensAt: at(-HOUR), closesAt, durationS: null }, {}, { timing: "deadline" })), "timing");
    expect(deadline(at(0)).level).toBe("blocker");
    expect(deadline(at(1)).level).toBe("ok");
  });
});

describe("launchChecks: the warnings, each with its fix", () => {
  it("warns about stale versions only while the item list is editable", () => {
    const stale = makeEvaluationDetail({ staleItems: ["a", "b"] });
    expect(one(checks(stale), "stale")).toMatchObject({
      level: "warning",
      title: 'launch.stale {"n":2}',
      fix: { kind: "updateVersions" },
    });
    expect(one(checks(makeEvaluationDetail({ staleItems: ["a"] })), "stale").title).toBe("launch.stale.one");
    expect(byId(checks(makeEvaluationDetail({ staleItems: ["a"], editable: false })), "stale")).toEqual([]);
  });

  it("warns that the template moved (F-EVAL-26), only where the pull is accepted", () => {
    const moved = detailWith({ originRevision: 1 }, { templateRevision: 3 });
    expect(one(checks(moved), "template")).toMatchObject({
      level: "warning",
      title: 'launch.template {"from":1,"to":3}',
      fix: { kind: "pullTemplate" },
    });
    // Up to date, or already taken by someone: no row.
    expect(byId(checks(detailWith({ originRevision: 3 }, { templateRevision: 3 })), "template")).toEqual([]);
    const taken = detailWith({ originRevision: 1 }, { templateRevision: 3, attemptCount: 1 });
    expect(byId(checks(taken), "template")).toEqual([]);
  });

  it("warns about an empty roster instead of counting it", () => {
    const rows = checks(makeEvaluationDetail({ roster: { enrolled: 0, unlinked: 0, conflicts: 0 } }));
    expect(byId(rows, "roster")).toEqual([
      expect.objectContaining({ level: "warning", title: "launch.roster.empty", fix: { kind: "roster" } }),
    ]);
  });

  it("warns about roster conflicts beside the roster's own line", () => {
    const rows = checks(makeEvaluationDetail({ roster: { enrolled: 10, unlinked: 0, conflicts: 1 } }));
    expect(one(rows, "conflicts")).toMatchObject({ level: "warning", title: "launch.roster.conflictsOne" });
    expect(one(rows, "roster").level).toBe("ok");
    const many = checks(makeEvaluationDetail({ roster: { enrolled: 10, unlinked: 0, conflicts: 4 } }));
    expect(one(many, "conflicts").title).toBe('launch.roster.conflicts {"n":4}');
  });

  it("has no roster rows at all when the detail carries no roster", () => {
    const rows = checks(makeEvaluationDetail({ roster: null }));
    expect(byId(rows, "roster")).toEqual([]);
    expect(byId(rows, "conflicts")).toEqual([]);
  });

  it("warns about a kiosk exam on a platform without the kiosk path (ADR-051 §2)", () => {
    const kioskExam = detailWith({}, {}, { kiosk: true });
    expect(one(checks(kioskExam, false), "kiosk")).toMatchObject({
      level: "warning",
      title: "launch.kiosk.unavailable",
    });
    expect(byId(checks(kioskExam, true), "kiosk")).toEqual([]);
    expect(byId(checks(makeEvaluationDetail(), false), "kiosk")).toEqual([]);
  });
});

describe("launchChecks: the rules and access lines", () => {
  it("names the navigation, the order, one attempt, and negative marking when on", () => {
    const settings = { navigation: "free", shuffleItems: true, negativeMarking: true } as const;
    const rules = one(checks(detailWith({}, {}, settings)), "rules");
    expect(rules.level).toBe("info");
    expect(rules.title).toBe("Eval.summary.navigation.free, launch.rules.shuffled");
    expect(rules.detail).toBe("launch.rules.oneAttempt · launch.rules.negative");

    const plain = one(checks(detailWith({}, {}, { shuffleItems: false })), "rules");
    expect(plain.title).toMatch(/launch\.rules\.fixedOrder$/);
    expect(plain.detail).toBe("launch.rules.oneAttempt");
  });

  it("describes the retakes of an exercise, bounded or not; an exam ignores them", () => {
    const retakes = (maxAttempts: number | null) => ({
      retakes: { enabled: true, keep: "last" as const, maxAttempts },
    });
    expect(one(checks(detailWith({ mode: "exercise" }, {}, retakes(null))), "rules").detail).toBe(
      "launch.rules.unlimited.last",
    );
    expect(one(checks(detailWith({ mode: "exercise" }, {}, retakes(3))), "rules").detail).toBe(
      'launch.rules.upTo.last {"n":3}',
    );
    expect(one(checks(detailWith({ mode: "exam" }, {}, retakes(3))), "rules").detail).toBe("launch.rules.oneAttempt");
  });

  it("counts the announced conditions on the info line, never as a warning (ADR-079)", () => {
    const conditions = (n: number) => ({
      conditions: Array.from({ length: n }, (_, i) => ({ kind: "info" as const, text: `Line ${i}` })),
    });
    expect(one(checks(detailWith({}, {}, conditions(1))), "rules").detail).toBe(
      "launch.rules.oneAttempt · launch.rules.conditions.one",
    );
    const many = one(checks(detailWith({}, {}, conditions(3))), "rules");
    expect(many.level).toBe("info");
    expect(many.detail).toBe('launch.rules.oneAttempt · launch.rules.conditions.many {"n":3}');
  });

  it("lists the access restrictions: the IP allow-list, then SEB, then the kiosk", () => {
    const access = one(
      checks(detailWith({ ipAllowlist: ["10.0.0.0/8"] }, {}, { safeExamBrowser: true, kiosk: true })),
      "access",
    );
    expect(access.title).toBe("Launch.access.ip · eval.seb · eval.kiosk");
    expect(access.detail).toBe("launch.access.detail");
    // Trusted clients belong to exams only.
    expect(one(checks(detailWith({ mode: "exercise" }, {}, { safeExamBrowser: true })), "access").title).toBe(
      "launch.access.open",
    );
  });
});

describe("launchChecks: order and counts", () => {
  it("puts the blockers first, then the warnings, then the rest in reading order", () => {
    const rows = checks(
      detailWith(
        { durationS: null, originRevision: 1 },
        { items: [], staleItems: ["a"], templateRevision: 2, roster: { enrolled: 3, unlinked: 0, conflicts: 2 } },
      ),
    );
    expect(rows.map((r) => `${r.level}:${r.id}`)).toEqual([
      "blocker:items",
      "blocker:timing",
      "warning:stale",
      "warning:template",
      "warning:conflicts",
      "ok:roster",
      "info:feedback",
      "info:rules",
      "info:access",
    ]);
    expect(readiness(rows)).toEqual({ blockers: 2, warnings: 3 });
  });

  it("counts nothing in an empty list", () => {
    expect(readiness([])).toEqual({ blockers: 0, warnings: 0 });
  });

  it("finds every key it uses in both dictionaries", () => {
    // The real `t`, in both languages: a key missing from a dictionary would
    // come back as the key itself.
    for (const locale of ["en", "fr"] as const) {
      const real: TFunction = (key, vars) => {
        const raw = DICTS[locale]![key as string];
        expect(raw, `${locale}: ${String(key)}`).toBeDefined();
        return vars ? raw!.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? `{${k}}`)) : raw!;
      };
      const detail = detailWith(
        { ipAllowlist: ["10.0.0.0/8"], originRevision: 1 },
        { staleItems: ["a"], templateRevision: 2, roster: { enrolled: 3, unlinked: 1, conflicts: 2 } },
        { safeExamBrowser: true, kiosk: true, negativeMarking: true },
      );
      const rows = launchChecks(detail, real, NOW, date, false);
      expect(rows.length).toBeGreaterThan(8);
    }
  });
});
