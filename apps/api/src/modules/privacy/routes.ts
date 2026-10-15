/**
 * HTTP surface of the `privacy` module (N-DATA-04, ADR-112): the personal
 * data export, one synchronous download built in the request and stored
 * nowhere.
 */
import type { FastifyInstance } from "fastify";

import { PERSONAL_DATA_EXPORT_PATH } from "@quiz/contracts";

import { tracer } from "../../audit.js";
import type { AppConfig } from "../../config.js";
import { FixedWindowLimiter } from "../../limiter.js";
import { codespaceOn } from "../codespace/service.js";
import { callerOf, ownSessionGuard } from "../guards.js";
import { rateLimited, readerLang } from "../http.js";
import { exportCounts, personalDataExport } from "./service.js";

/** ADR-112 §8: five files per person and hour, per process (best effort). */
export const EXPORTS_PER_HOUR = 5;

export async function privacyPlugin(app: FastifyInstance, opts: { config: AppConfig }) {
  const exports = new FixedWindowLimiter(EXPORTS_PER_HOUR, 3_600_000);
  const trace = tracer(app);

  /**
   * The caller's own portal session only (`ownSessionGuard`): never an
   * impersonation, a `seb` or `kiosk` session, nor a Bearer token. A failure
   * of any section is a 500, never a partial file.
   */
  app.get(PERSONAL_DATA_EXPORT_PATH, { preHandler: ownSessionGuard(app) }, async (req, reply) => {
    const now = app.clock.now();
    const caller = callerOf(req);
    const wait = exports.hit(caller.id, now.getTime());
    if (wait !== null) return rateLimited(reply, wait);
    const file = await personalDataExport(
      app.db,
      { caller, user: req.user! },
      now,
      { lang: readerLang(req), codespace: codespaceOn(opts.config) },
    );
    await trace(req, "privacy.export", "user", caller.id, exportCounts(file));
    return reply
      .type("application/json; charset=utf-8")
      .header("content-disposition", `attachment; filename="quiz-data-${file.generatedAt.slice(0, 10)}.json"`)
      .header("cache-control", "no-store")
      .send(JSON.stringify(file));
  });
}
