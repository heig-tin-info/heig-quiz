/**
 * ADR-051 §7: a kiosk station's session lasts as long as the attempt it
 * sits, no longer. Wherever an attempt ends — the student's submit, the
 * teacher's close, the ticker's expiry, the evaluation's close — `live`
 * hands the ended attempts here, AFTER it has emitted their
 * `attempt.closed`: the station's stream must carry that frame before the
 * session's end closes it. The station then draws its closed screen and
 * returns to `/kiosk`. A `seb` session is not ended: SEB keeps showing the
 * closed attempt (ADR-027).
 */
import { endConfinedSessions } from "../../auth/session.js";
import type { Db } from "../../db/client.js";
import type { EndedAttempt } from "./dwell.js";

/** The station sessions of these ended attempts, ended. */
export async function endStationSittings(
  db: Db,
  ended: readonly Pick<EndedAttempt, "userId" | "evaluationId">[],
): Promise<void> {
  for (const { userId, evaluationId } of ended) {
    if (userId !== null) await endConfinedSessions(db, { userId, evaluationId, kind: "kiosk" });
  }
}

/** Every station session of an evaluation that closed, whoever it seated and wherever they were. */
export async function endEvaluationStations(db: Db, evaluationId: string): Promise<void> {
  await endConfinedSessions(db, { evaluationId, kind: "kiosk" });
}
