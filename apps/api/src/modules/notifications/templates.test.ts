import { describe, expect, it } from "vitest";

import type { NotificationPayload } from "@quiz/contracts";

import { escapeHtml, mailLocale, notificationPath, renderNotification } from "./templates.js";

const POOL = "11111111-1111-4111-8111-111111111111";
const EVAL = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";

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
    expect(fr.teams).toContain("Voir mes résultats");

    const role = renderNotification(shared, "fr", "https://quiz.test/");
    expect(role.text).toContain("avec vous comme contributeur");
    // A trailing slash on the base does not double in the link.
    expect(role.text).toContain("https://quiz.test/pools/" + POOL);
  });

  it("covers every kind in both languages", () => {
    const ownership: NotificationPayload = {
      kind: "pool_ownership",
      poolId: POOL,
      poolName: "Électronique",
      fromName: "Grace Hopper",
    };
    for (const payload of [shared, released, ownership]) {
      for (const locale of ["en", "fr"] as const) {
        const out = renderNotification(payload, locale, "https://quiz.test");
        for (const part of [out.subject, out.text, out.html, out.teams]) {
          expect(part).not.toMatch(/\{\w+\}/);
          expect(part.length).toBeGreaterThan(10);
        }
      }
    }
  });

  it("escapes every user-provided value in the HTML parts", () => {
    const hostile: NotificationPayload = {
      ...shared,
      poolName: `<script>alert("x")</script>`,
      byName: `Eve " onmouseover='y'`,
    };
    const out = renderNotification(hostile, "en", "https://quiz.test");
    for (const html of [out.html, out.teams]) {
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
      expect(html).toContain("Eve &quot; onmouseover=&#39;y&#39;");
    }
    // The plain-text part is text: it carries the name as typed.
    expect(out.text).toContain(`<script>alert("x")</script>`);
  });

  it("keeps the subject on one line", () => {
    const out = renderNotification(
      { ...released, evaluationTitle: "Line one\r\nBcc: someone@evil.test" },
      "en",
      "https://quiz.test",
    );
    expect(out.subject).not.toMatch(/[\r\n]/);
    expect(out.subject).toBe("Results available: Line one Bcc: someone@evil.test");
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
