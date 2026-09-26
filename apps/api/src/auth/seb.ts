/**
 * Safe Exam Browser launch (ADR-027, #139): the `.seb` file a student
 * downloads from the portal, and the route it starts on, which trades the
 * one-time ticket in its URL for a `seb` session confined to one evaluation.
 *
 * The file format and the Config Key are ported from
 * `heig-classroom/apps/codespace/src/seb/` (itself a port of Moodle's
 * `quizaccess_seb`), cut down to the plist subset this file uses: strings,
 * booleans, integers, arrays, dictionaries. No `<data>`, `<real>`, `<date>`,
 * no `originatorVersion`, no empty dictionary — so none of the rules the
 * sibling carries for them.
 */
import { createHash, timingSafeEqual } from "node:crypto";

import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";

import { IdParam } from "@quiz/contracts";

import { audit, tracer } from "../audit.js";
import type { AppConfig } from "../config.js";
import { users } from "../db/schema.js";
import { sebSeat } from "../modules/live/service.js";
import { consumeLaunchTicket, issueLaunchTicket } from "./launch.js";

/** Where the `.seb` starts; the ticket secret is the last segment. */
const LAUNCH_PATH = "/app/auth/seb/";

/** The launch URL with its secret masked, for the request log. */
export const redactLaunchUrl = (url: string): string =>
  url.startsWith(LAUNCH_PATH) ? `${LAUNCH_PATH}…` : url;

// --- The file --------------------------------------------------------------

type Plist = string | boolean | number | readonly Plist[] | { readonly [key: string]: Plist };

/**
 * The configuration of one launch. Every key comes from a real SEB
 * configuration (see the sibling's `sebFile.ts`); `sendBrowserExamKey` is
 * what makes SEB send the Config Key header the start route checks.
 */
export function sebConfig(startUrl: string): Plist {
  const host = new URL(startUrl).host;
  return {
    startURL: startUrl,
    allowQuit: true,
    URLFilterEnable: true,
    URLFilterEnableContentFilter: true,
    URLFilterRulesAsRegex: false,
    URLFilterRules: [{ action: 1, active: true, expression: host, regex: false }],
    allowDownUploads: false,
    downloadAndOpenSebConfig: false,
    downloadPDFFiles: false,
    enablePrivateClipboard: true,
    browserViewMode: 1,
    enableBrowserWindowToolbar: false,
    hideBrowserWindowToolbar: true,
    showMenuBar: false,
    showTaskBar: false,
    allowBrowsingBackForward: false,
    allowPreferencesWindow: false,
    allowSwitchToApplications: false,
    allowVirtualMachine: false,
    allowSpellCheck: false,
    blockPopUpWindows: true,
    createNewDesktop: true,
    killExplorerShell: false,
    sendBrowserExamKey: true,
  };
}

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function plistValue(value: Plist, pad: string): string {
  if (typeof value === "string") return `${pad}<string>${escapeXml(value)}</string>`;
  if (typeof value === "boolean") return `${pad}<${value}/>`;
  if (typeof value === "number") return `${pad}<integer>${value}</integer>`;
  const inner = `${pad}  `;
  if (Array.isArray(value)) {
    const items: readonly Plist[] = value;
    return `${pad}<array>\n${items.map((v) => plistValue(v, inner)).join("\n")}\n${pad}</array>`;
  }
  const entries = Object.entries(value).map(
    ([key, v]) => `${inner}<key>${escapeXml(key)}</key>\n${plistValue(v, inner)}`,
  );
  return `${pad}<dict>\n${entries.join("\n")}\n${pad}</dict>`;
}

/** An unencrypted `.seb`: a bare XML plist, as `quizaccess_seb` serves it. */
export function toPlistXml(root: Plist): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple Computer//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    plistValue(root, ""),
    "</plist>",
    "",
  ].join("\n");
}

// --- The Config Key ----------------------------------------------------------

/** Unicode collation, root order: `allowWlan` before `allowWLAN` (not ASCII). */
const COLLATOR = new Intl.Collator("en", { sensitivity: "variant", caseFirst: "false" });

/** A JSON string; a VALUE keeps its backslashes raw, as the reference does. */
const quote = (text: string, raw: boolean) =>
  raw ? JSON.stringify(text).replace(/\\\\/g, "\\") : JSON.stringify(text);

/**
 * The "SEB-JSON" of a configuration: no whitespace, keys sorted by the
 * collator at every level, an empty dictionary written `[]` (PHP's
 * `json_encode` of an empty array). Not valid JSON once a value holds a
 * backslash — which is what the specification wants.
 */
export function sebJson(value: Plist): string {
  if (typeof value === "string") return quote(value, true);
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return `[${(value as readonly Plist[]).map(sebJson).join(",")}]`;
  const dict = value as { readonly [key: string]: Plist };
  const keys = Object.keys(dict).sort(COLLATOR.compare);
  if (keys.length === 0) return "[]";
  return `{${keys.map((k) => `${quote(k, false)}:${sebJson(dict[k]!)}`).join(",")}}`;
}

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const configKey = (config: Plist): string => sha256(sebJson(config));

/** The header SEB sends on every request: `sha256(absolute URL + Config Key)`. */
export const CONFIG_KEY_HEADER = "x-safeexambrowser-configkeyhash";

/** What SEB sends on the launch that starts at `url` (the tests send it too). */
export const configKeyHeaderFor = (url: string): string => sha256(url + configKey(sebConfig(url)));

/** Whether `header` is the Config Key hash of the launch that starts at `url`. */
export function configKeyMatches(url: string, header: unknown): boolean {
  if (typeof header !== "string") return false;
  // Digests of both sides: equal lengths, so the comparison never short-circuits.
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(configKeyHeaderFor(url)), digest(header.toLowerCase()));
}

// --- The routes ----------------------------------------------------------------

export async function sebRoutes(app: FastifyInstance, config: AppConfig) {
  const trace = tracer(app);
  /**
   * The `.seb` of one evaluation, for a student holding a seat in it. A
   * portal session only (the route declares no other kind): a `seb` session
   * cannot mint the next ticket. A GET, like the CSV export, so the card is a
   * plain download link; forcing one from another site only revokes an
   * unused file, which the student downloads again.
   */
  app.get(
    "/app/api/evaluations/:id/seb",
    { preHandler: (req, reply) => app.requireSession(req, reply) },
    async (req, reply) => {
      const params = IdParam.safeParse(req.params);
      const evaluation = params.success && (await sebSeat(app.db, req.user!.id, params.data.id));
      if (!evaluation) return reply.code(404).send({ error: "not_found" });
      const secret = await issueLaunchTicket(
        app.db,
        { kind: "seb", userId: req.user!.id, actorUserId: null, evaluationId: evaluation.id },
        app.clock.now(),
      );
      await trace(req, "auth.seb_launch", "evaluation", evaluation.id);
      const startUrl = new URL(`${LAUNCH_PATH}${secret}`, config.PUBLIC_URL).href;
      return reply
        .header("content-type", "application/seb")
        .header("content-disposition", 'attachment; filename="exam.seb"')
        .header("cache-control", "no-store")
        .send(toPlistXml(sebConfig(startUrl)));
    },
  );

  /**
   * The start URL of the `.seb`. The Config Key header is checked BEFORE the
   * ticket is consumed: a copied file opened in an ordinary browser is
   * refused and leaves the ticket for SEB. Every refusal looks the same to
   * the client; the audit log keeps the reason.
   */
  app.get<{ Params: { secret: string } }>(`${LAUNCH_PATH}:secret`, async (req, reply) => {
    const refuse = async (reason: string, ticketId = "unknown") => {
      await audit(app.db, {
        actorType: "system",
        action: "auth.seb_refused",
        subjectType: "launch_ticket",
        subjectId: ticketId,
        payload: { reason, ip: req.ip },
      });
      return reply.redirect("/?seb=invalid", 303);
    };
    const now = app.clock.now();
    const url = new URL(req.url, config.PUBLIC_URL).href;
    if (!configKeyMatches(url, req.headers[CONFIG_KEY_HEADER])) return refuse("config_key");
    const ticket = await consumeLaunchTicket(app.db, req.params.secret, now);
    if (!ticket) return refuse("ticket");
    // The ticket is a few minutes old: the seat, and the requirement, are checked again now.
    const evaluation = await sebSeat(app.db, ticket.userId, ticket.auth.evaluationId!);
    const [user] = await app.db.select().from(users).where(eq(users.id, ticket.userId));
    if (!evaluation || !user) return refuse("seat", ticket.id);
    await app.openSession(reply, user, ticket.auth);
    await audit(app.db, {
      actorUserId: ticket.auth.actorUserId ?? user.id,
      actorType: "user",
      action: "auth.seb_login",
      subjectType: "evaluation",
      subjectId: evaluation.id,
      payload: { ticketId: ticket.id },
    });
    return reply.redirect(`/take/${evaluation.id}`, 303);
  });
}
