import { describe, expect, it } from "vitest";

import type { NotificationPayload } from "@quiz/contracts";

import {
  activityParameters,
  escapeHtml,
  mailLocale,
  notificationPath,
  renderNotification,
  renderTestMail,
} from "./templates.js";

const POOL = "11111111-1111-4111-8111-111111111111";
const EVAL = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const CLASSROOM = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";
const project = { projectId: PROJECT, projectTitle: "Lab 1 — pointers" };

const shared: NotificationPayload = {
  kind: "pool_shared",
  poolId: POOL,
  poolName: "Programmation C",
  role: "contributor",
  byName: "Ada Lovelace",
};
const released: NotificationPayload = {
  kind: "results_released",
  evaluationId: EVAL,
  evaluationTitle: "Test 0 — bases du C",
  attemptId: ATTEMPT,
};

describe("renderNotification", () => {
  it("speaks the recipient's language, in every part of the message", () => {
    const en = renderNotification(released, "en", "https://quiz.test");
    expect(en.subject).toBe("Results available: Test 0 — bases du C");
    expect(en.text).toContain("See my results: https://quiz.test/attempts/" + ATTEMPT + "/feedback");
    expect(en.text).toContain("https://quiz.test/settings");

    const fr = renderNotification(released, "fr", "https://quiz.test");
    expect(fr.subject).toBe("Résultats disponibles : Test 0 — bases du C");
    expect(fr.html).toContain("Voir mes résultats");
    expect(fr.html).toContain("Réglages des notifications");
    expect(fr.preview).toBe("Les résultats de « Test 0 — bases du C » sont disponibles.");

    const role = renderNotification(shared, "fr", "https://quiz.test");
    expect(role.text).toContain("avec vous comme contributeur");
    expect(role.text).toContain("https://quiz.test/pools/" + POOL);
  });

  it("covers every kind in both languages", () => {
    const ownership: NotificationPayload = {
      kind: "pool_ownership",
      poolId: POOL,
      poolName: "Électronique",
      fromName: "Grace Hopper",
    };
    const joined: NotificationPayload = {
      kind: "student_joined",
      classroomId: CLASSROOM,
      classroomName: "PRG1-2026",
      count: 3,
    };
    const conflict: NotificationPayload = { ...joined, kind: "roster_conflict", count: 1 };
    const ready: NotificationPayload = {
      kind: "grading_ready",
      evaluationId: EVAL,
      evaluationTitle: "Test 0",
      count: 4,
    };
    const added: NotificationPayload = {
      kind: "pool_question_added",
      poolId: POOL,
      poolName: "Programmation C",
      count: 2,
    };
    for (const payload of [
      shared,
      released,
      ownership,
      joined,
      conflict,
      { ...joined, count: 1 },
      ready,
      { ...ready, count: 1 },
      added,
      { ...added, count: 1 },
      { kind: "activity_scheduled", classroomId: CLASSROOM, classroomName: "PRG1-2026", count: 16 },
      { kind: "activity_scheduled", classroomId: CLASSROOM, classroomName: "PRG1-2026", count: 1 },
      { kind: "activity_available", activityKind: "evaluation", activityId: EVAL, activityTitle: "Série 3" },
      { kind: "deadline_approaching", evaluationId: EVAL, evaluationTitle: "Série 4" },
      { kind: "project_published", ...project },
      { kind: "project_deadline_reminder", ...project },
      { kind: "project_repo_invited", ...project },
      { kind: "project_grade_final", ...project },
      { kind: "project_deadline_applied", ...project, count: 12 },
      { kind: "project_deadline_applied", ...project, count: 1 },
      { kind: "project_provision_failed", ...project, count: 2, reason: "github_error" },
      { kind: "project_provision_failed", ...project, count: 1, reason: "repo_name_taken" },
      { kind: "github_org_lost", classroomId: CLASSROOM, classroomName: "PRG1-2026", orgLogin: "heig-prg1" },
    ] satisfies NotificationPayload[]) {
      for (const locale of ["en", "fr"] as const) {
        const out = renderNotification(payload, locale, "https://quiz.test");
        for (const part of [out.subject, out.text, out.html, out.preview]) {
          expect(part).not.toMatch(/\{\w+\}/);
          expect(part.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it("counts a folded kind, with a singular sentence of its own, and names no student", () => {
    const joined = { kind: "student_joined", classroomId: CLASSROOM, classroomName: "PRG1-2026" } as const;
    expect(renderNotification({ ...joined, count: 3 }, "en", "https://quiz.test").subject).toBe(
      "3 students joined PRG1-2026",
    );
    expect(renderNotification({ ...joined, count: 1 }, "fr", "https://quiz.test").subject).toBe(
      "Un étudiant a rejoint PRG1-2026",
    );
    const conflict = renderNotification(
      { ...joined, kind: "roster_conflict", count: 2 },
      "fr",
      "https://quiz.test",
    );
    expect(conflict.subject).toBe("2 entrées de la liste de PRG1-2026 demandent votre décision");
    expect(conflict.text).toContain(`https://quiz.test/classrooms/${CLASSROOM}?tab=roster`);
    expect(conflict.topic).toBe("PRG1-2026");
  });

  it("escapes every user-provided value in the HTML parts", () => {
    const hostile: NotificationPayload = {
      ...shared,
      poolName: `<script>alert("x")</script>`,
      byName: `Eve " onmouseover='y'`,
    };
    const out = renderNotification(hostile, "en", "https://quiz.test");
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(out.html).toContain("Eve &quot; onmouseover=&#39;y&#39;");
    // The plain-text parts are text: they carry the name as typed (Teams
    // renders a preview as text).
    expect(out.text).toContain(`<script>alert("x")</script>`);
    expect(out.preview).toContain(`<script>alert("x")</script>`);
  });

  it("keeps the subject on one line", () => {
    const out = renderNotification(
      { ...released, evaluationTitle: "Line one\r\nBcc: someone@evil.test" },
      "en",
      "https://quiz.test",
    );
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.subject).toBe("Results available: Line one Bcc: someone@evil.test");
    expect(out.preview).not.toMatch(/[\r\n]/);
  });

  it("carries ids and a title, never a grade", () => {
    const out = renderNotification(released, "en", "https://quiz.test");
    expect(JSON.stringify(out)).not.toMatch(/grade|points/i);
  });
});

describe("helpers", () => {
  it("falls back to English for an unset or unknown locale", () => {
    expect(mailLocale("fr")).toBe("fr");
    expect(mailLocale("en")).toBe("en");
    expect(mailLocale(null)).toBe("en");
    expect(mailLocale("de")).toBe("en");
  });

  it("opens the same page as the bell", () => {
    expect(notificationPath(shared)).toBe(`/pools/${POOL}`);
    expect(notificationPath(released)).toBe(`/attempts/${ATTEMPT}/feedback`);
  });

  it("escapes the five characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

/*
 * The counted kinds of #198 (steps 5 and 6): where each one sends, its
 * subject for several in English, and its singular sentence in French.
 */
describe("the counted kinds of #198", () => {
  it.each([
    {
      payload: { kind: "grading_ready", evaluationId: EVAL, evaluationTitle: "Test 0" },
      path: `/evaluations/${EVAL}/grading`,
      several: [3, "3 proposals to validate: Test 0"],
      one: "Une proposition à valider : Test 0",
    },
    {
      payload: { kind: "pool_question_added", poolId: POOL, poolName: "PRG" },
      path: `/pools/${POOL}`,
      several: [5, "5 questions published in PRG"],
      one: "Une question publiée dans PRG",
    },
    {
      payload: { kind: "activity_scheduled", classroomId: CLASSROOM, classroomName: "PRG1-2026" },
      path: "/",
      several: [16, "16 exercises scheduled in PRG1-2026"],
      one: "Un exercice planifié dans PRG1-2026",
    },
  ] as const)("sends $payload.kind to its page, counted", ({ payload, path, several: [count, subject], one }) => {
    const of = (n: number) => ({ ...payload, count: n }) as NotificationPayload;
    expect(notificationPath(of(count))).toBe(path);
    expect(renderNotification(of(count), "en", "https://quiz.test").subject).toBe(subject);
    expect(renderNotification(of(1), "fr", "https://quiz.test").subject).toBe(one);
  });
});

describe("activity_available (#198 step 6)", () => {
  it("sends activity_available to the page that lets the student in", () => {
    const available = { kind: "activity_available", activityKind: "evaluation", activityId: EVAL, activityTitle: "Série 3" } as const;
    expect(notificationPath(available)).toBe(`/take/${EVAL}`);
    const out = renderNotification(available, "fr", "https://quiz.test");
    expect(out.subject).toBe("Exercice ouvert : Série 3");
    expect(out.text).toContain(`https://quiz.test/take/${EVAL}`);
    // The kind-neutral payload keeps the Teams template parameter the
    // installed app declares (ADR-030, addendum 2026-09-30).
    expect(out.topic).toBe("Série 3");
    expect(activityParameters(available)).toEqual({ evaluationTitle: "Série 3" });
  });
});

describe("deadline_approaching (#198 step 7)", () => {
  it("sends the reminder to the attempt, with no date to render", () => {
    const reminder = { kind: "deadline_approaching", evaluationId: EVAL, evaluationTitle: "Série 4" } as const;
    expect(notificationPath(reminder)).toBe(`/take/${EVAL}`);
    expect(renderNotification(reminder, "en", "https://quiz.test").subject).toBe(
      "Closes within 24 hours: Série 4",
    );
    const out = renderNotification(reminder, "fr", "https://quiz.test");
    expect(out.subject).toBe("Se termine dans les 24 heures : Série 4");
    expect(out.text).toContain("moins de 24 heures");
    expect(out.text).toContain(`https://quiz.test/take/${EVAL}`);
  });
});

describe("the project kinds (F-NOTIF-13, M3-09b)", () => {
  it("open the project, and the classroom's Settings for a lost organization", () => {
    for (const kind of [
      "project_published",
      "project_deadline_reminder",
      "project_repo_invited",
      "project_grade_final",
    ] as const) {
      expect(notificationPath({ kind, ...project })).toBe(`/projects/${PROJECT}`);
    }
    expect(notificationPath({ kind: "project_deadline_applied", ...project, count: 3 })).toBe(`/projects/${PROJECT}`);
    expect(notificationPath({ kind: "project_provision_failed", ...project, count: 1, reason: "github_error" })).toBe(`/projects/${PROJECT}`);
    expect(
      notificationPath({ kind: "github_org_lost", classroomId: CLASSROOM, classroomName: "PRG1-2026", orgLogin: "heig-prg1" }),
    ).toBe(`/classrooms/${CLASSROOM}/settings`);
  });

  it("names the cause of a failed provisioning, in the recipient's language, with a singular of its own", () => {
    const taken = { kind: "project_provision_failed", ...project, count: 1, reason: "repo_name_taken" } as const;
    const en = renderNotification(taken, "en", "https://quiz.test");
    expect(en.subject).toBe("A repository could not be created: Lab 1 — pointers");
    expect(en.text).toContain("a repository of that name exists already");
    const fr = renderNotification({ ...taken, count: 3, reason: "github_error" }, "fr", "https://quiz.test");
    expect(fr.subject).toBe("3 dépôts n'ont pas pu être créés : Lab 1 — pointers");
    expect(fr.preview).toContain("Dernière cause : GitHub a échoué ou refusé");
    expect(fr.topic).toBe("Lab 1 — pointers");
  });

  it("tells a student the scores are out, and says nothing of the score", () => {
    const out = renderNotification({ kind: "project_grade_final", ...project }, "en", "https://quiz.test");
    expect(out.subject).toBe("Scores released: Lab 1 — pointers");
    expect(out.text).toContain(`https://quiz.test/projects/${PROJECT}`);
    expect(out.text).not.toMatch(/\d+\s*\/\s*\d+/);
    const lost = renderNotification(
      { kind: "github_org_lost", classroomId: CLASSROOM, classroomName: "PRG1-2026", orgLogin: "heig-prg1" },
      "fr",
      "https://quiz.test",
    );
    expect(lost.subject).toBe("Organisation GitHub perdue : PRG1-2026");
    expect(lost.text).toContain("heig-prg1");
    expect(lost.topic).toBe("PRG1-2026");
  });
});

describe("system_alert (ADR-055 §5)", () => {
  const failing: NotificationPayload = { kind: "system_alert", state: "failing", checks: ["disk", "runner"] };

  it("names the platform and the checks, and links to the System status for the rest", () => {
    const en = renderNotification(failing, "en", "https://quiz.heig-vd.ch");
    expect(en.subject).toBe("quiz.heig-vd.ch: health checks failing");
    expect(en.text).toContain("Health checks of quiz.heig-vd.ch failed on two runs in a row: Disk space, Code runner.");
    expect(en.text).toContain("Open the system status: https://quiz.heig-vd.ch/admin?tab=system");
    expect(notificationPath(failing)).toBe("/admin?tab=system");

    const fr = renderNotification(failing, "fr", "https://quiz.heig-vd.ch");
    expect(fr.subject).toBe("quiz.heig-vd.ch : contrôles de santé en échec");
    expect(fr.text).toContain("Espace disque, Exécuteur de code");
    expect(fr.text).toContain("Ouvrir l'état du système");
  });

  it("has a sentence per state, in both languages", () => {
    for (const state of ["failing", "still_failing", "recovered"] as const) {
      for (const locale of ["en", "fr"] as const) {
        const out = renderNotification({ kind: "system_alert", state, checks: ["backup"] }, locale, "https://quiz.test");
        for (const part of [out.subject, out.text, out.html]) expect(part).not.toMatch(/\{\w+\}/);
      }
    }
  });
});

describe("the test e-mail (ADR-055 §6)", () => {
  it("names the platform, links back to the System status, and has no notification footer", () => {
    for (const locale of ["en", "fr"] as const) {
      const mail = renderTestMail(locale, "https://quiz.heig-vd.ch");
      expect(mail.subject).toContain("quiz.heig-vd.ch");
      expect(mail.text).toContain("https://quiz.heig-vd.ch/admin?tab=system");
      for (const part of [mail.subject, mail.text, mail.html]) expect(part).not.toMatch(/\{\w+\}/);
      // Not a notification: no preference chose it.
      expect(mail.text).not.toContain("/settings");
      expect(mail.html).not.toContain("/settings");
    }
    expect(renderTestMail("fr", "https://quiz.test").text).toContain("Retour à l'état du système");
  });
});
