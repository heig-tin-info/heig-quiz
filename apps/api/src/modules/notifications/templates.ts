/**
 * The words of a notification that leaves the platform (ADR-030): the e-mail
 * and the Teams message, rendered on the server in the RECIPIENT's language
 * (`users.locale`, English when unset), never the sender's.
 *
 * One typed dictionary, the web app's rule mirrored: `fr` is
 * `Record<keyof typeof en, string>`, so a missing French sentence is a
 * compile error. The bell is NOT rendered here — the web app turns the same
 * payload into its own sentence (`NotificationPanel.tsx`).
 *
 * Every value that comes from a user (a pool name, a title, a display name)
 * is escaped before it lands in HTML, and the subject line is flattened to
 * one line. The payload carries ids and titles only: nothing here can leak a
 * grade or question content, because nothing of the kind is ever passed in.
 */
import type { NotificationKind, NotificationPayload } from "@quiz/contracts";

export type MailLocale = "en" | "fr";

const en = {
  "results_released.subject": "Results available: {evaluationTitle}",
  "results_released.body": "The results of “{evaluationTitle}” are available.",
  "results_released.action": "See my results",
  "pool_shared.subject": "A pool was shared with you: {poolName}",
  "pool_shared.body": "{byName} shared the pool “{poolName}” with you as {role}.",
  "pool_shared.action": "Open the pool",
  "pool_ownership.subject": "You now own the pool {poolName}",
  "pool_ownership.body": "You are now the owner of the pool “{poolName}” (from {fromName}).",
  "pool_ownership.action": "Open the pool",
  "role.reader": "reader",
  "role.contributor": "contributor",
  "role.owner": "owner",
  footer: "You receive this message from HEIG Quiz. Choose which notifications reach you, and where, in your settings:",
  "footer.link": "Notification settings",
} as const;

type Key = keyof typeof en;

const fr: Record<Key, string> = {
  "results_released.subject": "Résultats disponibles : {evaluationTitle}",
  "results_released.body": "Les résultats de « {evaluationTitle} » sont disponibles.",
  "results_released.action": "Voir mes résultats",
  "pool_shared.subject": "Une banque a été partagée avec vous : {poolName}",
  "pool_shared.body": "{byName} a partagé la banque « {poolName} » avec vous comme {role}.",
  "pool_shared.action": "Ouvrir la banque",
  "pool_ownership.subject": "Vous êtes propriétaire de la banque {poolName}",
  "pool_ownership.body": "Vous êtes désormais propriétaire de la banque « {poolName} » (de {fromName}).",
  "pool_ownership.action": "Ouvrir la banque",
  "role.reader": "lecteur",
  "role.contributor": "contributeur",
  "role.owner": "propriétaire",
  footer: "Vous recevez ce message de HEIG Quiz. Choisissez quelles notifications vous parviennent, et où, dans vos réglages :",
  "footer.link": "Réglages des notifications",
};

const DICTS: Record<MailLocale, Record<Key, string>> = { en, fr };

/** The five characters that matter in text and in a quoted attribute. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `{name}` placeholders; `encode` is applied to the template AND each value. */
function fill(
  template: string,
  vars: Record<string, string>,
  encode: (s: string) => string,
): string {
  return encode(template).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? encode(vars[name]!) : whole,
  );
}

const plain = (s: string) => s;

/** One line, no control character: a subject is a header once it is sent. */
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** The values a kind's sentences read, and the page its link opens. */
function varsOf(payload: NotificationPayload, t: Record<Key, string>): Record<string, string> {
  switch (payload.kind) {
    case "results_released":
      return { evaluationTitle: payload.evaluationTitle };
    case "pool_shared":
      return { poolName: payload.poolName, byName: payload.byName, role: t[`role.${payload.role}`] };
    case "pool_ownership":
      return { poolName: payload.poolName, fromName: payload.fromName };
  }
}

/**
 * Where a notification takes its reader in the app, the same page the bell
 * opens (`notificationRoute` in the web app).
 */
export function notificationPath(payload: NotificationPayload): string {
  switch (payload.kind) {
    case "results_released":
      return `/attempts/${payload.attemptId}/feedback`;
    case "pool_shared":
    case "pool_ownership":
      return `/pools/${payload.poolId}`;
  }
}

export interface RenderedNotification {
  subject: string;
  /** The plain-text part of the e-mail. */
  text: string;
  /** The HTML part of the e-mail. */
  html: string;
  /** The Teams message, in the small HTML subset Teams renders (`textFormat: xml`). */
  teams: string;
}

/** Narrows `users.locale` (null, or a value this dictionary lacks) to a language. */
export function mailLocale(locale: string | null | undefined): MailLocale {
  return locale === "fr" ? "fr" : "en";
}

/**
 * Renders one notification for one recipient. `webUrl` is where a browser
 * reaches the SPA (`WEB_URL`, which defaults to `PUBLIC_URL`).
 */
export function renderNotification(
  payload: NotificationPayload,
  locale: MailLocale,
  webUrl: string,
): RenderedNotification {
  const t = DICTS[locale];
  const kind: NotificationKind = payload.kind;
  const vars = varsOf(payload, t);
  const base = webUrl.replace(/\/+$/, "");
  const link = `${base}${notificationPath(payload)}`;
  const settings = `${base}/settings`;

  const subject = oneLine(fill(t[`${kind}.subject`], vars, plain));
  const body = fill(t[`${kind}.body`], vars, plain);
  const action = t[`${kind}.action`];

  const text = [body, "", `${action}: ${link}`, "", "--", `${t.footer} ${settings}`].join("\n");

  const bodyHtml = fill(t[`${kind}.body`], vars, escapeHtml);
  const html = `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#18181b">
  <p style="font-size:13px;font-weight:600;letter-spacing:.02em;color:#71717a;margin:0 0 16px">HEIG Quiz</p>
  <p style="font-size:15px;line-height:1.6;margin:0 0 20px">${bodyHtml}</p>
  <p style="margin:0 0 28px"><a href="${escapeHtml(link)}" style="background:#18181b;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;font-weight:500">${escapeHtml(action)}</a></p>
  <p style="font-size:12px;line-height:1.5;color:#71717a;border-top:1px solid #e4e4e7;padding-top:12px;margin:0">${escapeHtml(t.footer)} <a href="${escapeHtml(settings)}" style="color:#71717a">${escapeHtml(t["footer.link"])}</a></p>
</div>`;

  const teams = `<p>${bodyHtml}</p><p><a href="${escapeHtml(link)}">${escapeHtml(action)}</a></p>`;

  return { subject, text, html, teams };
}
