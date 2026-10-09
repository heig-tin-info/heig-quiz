/**
 * Refresh hints of the `group` module (ADR-005, ADR-070 §9): no data, the
 * client re-reads its own authorized routes. To the course's staff, and —
 * when the set reaches the students (open, or named by a published project,
 * M3-17) — to the `user:` topic of each claimed student of the classroom.
 * NEVER to `classroom:<id>`, where every student of the classroom listens,
 * whatever the set (N-SEC-20).
 */
import * as bus from "../realtime/bus.js";

/** A set of a classroom of course `courseId` changed: its staff re-read, and `userIds` (its students, when they read it). */
export function groupsChanged(courseId: string, userIds: readonly string[] = []): void {
  bus.staffAndStudentsHint("groups", courseId, userIds);
}
