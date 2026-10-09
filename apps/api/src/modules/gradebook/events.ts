/**
 * Refresh hints of the `gradebook` module (ADR-005, M5-03a): no data, the
 * client re-reads its own authorized routes. To the course's staff, and to
 * the `user:` topic of the claimed students whose own cells or published
 * mean it may have changed. NEVER to `classroom:<id>`, where every student
 * of the classroom listens, whatever the cell.
 */
import * as bus from "../realtime/bus.js";

/** A classroom's gradebook of course `courseId` changed: its staff re-read, and `userIds` (the students it reaches). */
export function gradebookChanged(courseId: string, userIds: readonly string[] = []): void {
  bus.staffAndStudentsHint("gradebook", courseId, userIds);
}
