/**
 * Refresh hints of the `group` module (ADR-005, ADR-070 §9): no data, the
 * client re-reads its own authorized routes. To the course's staff only —
 * NEVER to `classroom:<id>`, where every student of the classroom listens
 * (N-SEC-20). The students' own topics come with their view of a set
 * (lot 2, M3-17).
 */
import * as bus from "../realtime/bus.js";

/** A set of a classroom of course `courseId` changed: its staff re-read. */
export function groupsChanged(courseId: string): void {
  bus.hint("groups", [`course:${courseId}`]);
}
