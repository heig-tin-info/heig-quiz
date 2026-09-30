/**
 * Refresh hints of the `journal` module (ADR-005): no data, the client
 * re-reads its own authorized journal routes, so the student reads the
 * student payload and the staff theirs (F-JRN-05, "open readers see a change
 * without a reload"; F-JRN-08, a page appearing when its date passes).
 *
 * Addressed to `classroom:<id>`, where the course's staff and the students
 * with a claimed seat listen: both read the journal. A hint says only that
 * something of the journal changed, never what.
 */
import * as bus from "../realtime/bus.js";

/** These classrooms' journal copies changed: a synchronisation, a rename, a page now visible. */
export function journalChanged(classroomIds: readonly string[]): void {
  bus.hint(
    "journal",
    [...new Set(classroomIds)].map((id) => `classroom:${id}` as const),
  );
}
