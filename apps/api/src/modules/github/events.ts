/**
 * Refresh hints of the `github` module (ADR-005): no data, the client
 * re-reads its own authorized `GET /classrooms/:id/github`.
 *
 * Addressed to `course:<id>`, a topic no student connection holds, never to
 * `classroom:<id>`, where every enrolled student listens (I41): what an
 * organization's installation looks like is the staff's business.
 */
import * as bus from "../realtime/bus.js";

/**
 * An organization's installation changed (the App's setup return): the
 * GitHub section of the Settings of these courses' classrooms turns green
 * without a reload (F-GH-02, 05-web §5.3).
 */
export function installationChanged(courseIds: readonly string[]): void {
  bus.hint(
    "classrooms",
    [...new Set(courseIds)].map((id) => `course:${id}` as const),
  );
}
