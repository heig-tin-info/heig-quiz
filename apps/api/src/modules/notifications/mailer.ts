/**
 * Transactional e-mail through Scaleway TEM, ported from heig-classroom's
 * `mailer.ts` (docs/spec/07, "Mailer"): the same provider, the same
 * configuration (`SCW_SECRET_KEY`, `SCW_DEFAULT_PROJECT_ID`, `MAIL_FROM`,
 * `MAIL_FROM_NAME`, `MAIL_REGION`) and the same DRY-RUN — without both
 * credentials an e-mail is logged and never sent.
 *
 * This is the transport only. It is called from the delivery job
 * (`jobs.ts`), never from a request: a failure throws, and the job system is
 * what retries it.
 *
 * `fetch` is injected, so the unit tests see every call without a network.
 */
import { mailEnabled, type AppConfig } from "../../config.js";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  /** `sent` once Scaleway accepted it; `dry_run` when it was only logged. */
  send(mail: Mail): Promise<"sent" | "dry_run">;
}

type MailConfig = Pick<
  AppConfig,
  "SCW_SECRET_KEY" | "SCW_DEFAULT_PROJECT_ID" | "MAIL_FROM" | "MAIL_FROM_NAME" | "MAIL_REGION"
>;

interface Log {
  info(obj: object, msg: string): void;
}

export function createMailer(config: MailConfig, log: Log, fetchImpl: typeof fetch = fetch): Mailer {
  const enabled = mailEnabled(config);
  const endpoint = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${encodeURIComponent(config.MAIL_REGION)}/emails`;
  return {
    async send(mail) {
      if (!enabled) {
        // The address and the subject only: the body is the product's words,
        // and a development log is no place for somebody's inbox.
        log.info({ to: mail.to, subject: mail.subject }, "email dry-run (no SCW credentials)");
        return "dry_run";
      }
      const res = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "X-Auth-Token": config.SCW_SECRET_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: { email: config.MAIL_FROM, name: config.MAIL_FROM_NAME },
          to: [{ email: mail.to }],
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          project_id: config.SCW_DEFAULT_PROJECT_ID,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        // Thrown, so the job is retried with backoff.
        throw new Error(`Scaleway TEM ${res.status}: ${body.slice(0, 300)}`);
      }
      return "sent";
    },
  };
}
