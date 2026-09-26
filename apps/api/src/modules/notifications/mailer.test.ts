import { describe, expect, it, vi } from "vitest";

import { createMailer, type Mail } from "./mailer.js";

const mail: Mail = {
  to: "ada@heig.test",
  subject: "Results available: Test 0",
  text: "body",
  html: "<p>body</p>",
};

const base = {
  SCW_SECRET_KEY: "",
  SCW_DEFAULT_PROJECT_ID: "",
  MAIL_FROM: "no-reply@quiz.test",
  MAIL_FROM_NAME: "HEIG Quiz",
  MAIL_REGION: "fr-par",
};

describe("createMailer", () => {
  it("logs instead of sending without both Scaleway credentials", async () => {
    for (const config of [
      base,
      { ...base, SCW_SECRET_KEY: "secret" },
      { ...base, SCW_DEFAULT_PROJECT_ID: "project" },
    ]) {
      const fetchImpl = vi.fn();
      const info = vi.fn();
      const mailer = createMailer(config, { info }, fetchImpl as unknown as typeof fetch);
      expect(await mailer.send(mail)).toBe("dry_run");
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(info).toHaveBeenCalledWith(
        { to: "ada@heig.test", subject: "Results available: Test 0" },
        expect.stringContaining("dry-run"),
      );
      // The body is never logged.
      expect(JSON.stringify(info.mock.calls)).not.toContain("<p>body</p>");
    }
  });

  it("posts to Scaleway TEM with the configured sender and project", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const mailer = createMailer(
      { ...base, SCW_SECRET_KEY: "secret", SCW_DEFAULT_PROJECT_ID: "project" },
      { info: vi.fn() },
      fetchImpl as unknown as typeof fetch,
    );
    expect(await mailer.send(mail)).toBe("sent");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://api.scaleway.com/transactional-email/v1alpha1/regions/fr-par/emails",
    );
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["X-Auth-Token"]).toBe("secret");
    expect(JSON.parse(init.body as string)).toEqual({
      from: { email: "no-reply@quiz.test", name: "HEIG Quiz" },
      to: [{ email: "ada@heig.test" }],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      project_id: "project",
    });
  });

  it("throws on a refusal, so the job is retried", async () => {
    const fetchImpl = vi.fn(async () => new Response("quota exceeded", { status: 429 }));
    const mailer = createMailer(
      { ...base, SCW_SECRET_KEY: "secret", SCW_DEFAULT_PROJECT_ID: "project" },
      { info: vi.fn() },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(mailer.send(mail)).rejects.toThrow("Scaleway TEM 429: quota exceeded");
  });
});
