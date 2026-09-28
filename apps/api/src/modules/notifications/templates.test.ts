import { describe, expect, it } from "vitest";

import type { NotificationPayload } from "@quiz/contracts";

import { escapeHtml, mailLocale, notificationPath, renderNotification } from "./templates.js";

const POOL = "11111111-1111-4111-8111-111111111111";
const EVAL = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const CLASSROOM = "44444444-4444-4444-8444-444444444444";

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
    ]) {
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

describe("the teacher kinds of step 5 (#198)", () => {
  it("sends grading_ready to the grading page, with the count of proposals", () => {
    const ready = {
      kind: "grading_ready",
      evaluationId: EVAL,
      evaluationTitle: "Test 0",
    } as const;
    expect(notificationPath({ ...ready, count: 3 })).toBe(`/evaluations/${EVAL}/grading`);
    expect(renderNotification({ ...ready, count: 3 }, "en", "https://quiz.test").subject).toBe(
      "3 proposals to validate: Test 0",
    );
    expect(renderNotification({ ...ready, count: 1 }, "fr", "https://quiz.test").subject).toBe(
      "Une proposition à valider : Test 0",
    );
  });

  it("sends pool_question_added to the pool, counted", () => {
    const added = { kind: "pool_question_added", poolId: POOL, poolName: "PRG" } as const;
    expect(notificationPath({ ...added, count: 5 })).toBe(`/pools/${POOL}`);
    expect(renderNotification({ ...added, count: 5 }, "en", "https://quiz.test").subject).toBe(
      "5 questions published in PRG",
    );
    expect(renderNotification({ ...added, count: 1 }, "fr", "https://quiz.test").subject).toBe(
      "Une question publiée dans PRG",
    );
  });
});
