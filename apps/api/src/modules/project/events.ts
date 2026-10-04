/**
 * Refresh hints of the `project` module (ADR-005, F-PROJ-21): no data, the
 * client re-reads its own authorized routes.
 *
 * A repository's activity is addressed to the `user:` topic of each of its
 * students and to the `course:` topic of its staff — NEVER to
 * `classroom:<id>`, where every student of the classroom listens: a hint
 * there would tell a student when a classmate pushes or gets a score, and
 * make every student's client refetch on each of them (N-SEC-20, I41,
 * heig-classroom #38). The notices worded for people are M3-09's.
 */
import type { Topic } from "@quiz/contracts";

import * as bus from "../realtime/bus.js";

/**
 * Something of a project changed for its staff alone — published by the
 * ticker, locked, frozen (M3-05a): the courses' `course:` topics. The
 * students' notices of a project are M3-09b's and M3-09c's.
 */
export function projectsChanged(courseIds: readonly string[]): void {
  if (courseIds.length === 0) return;
  bus.hint("projects", [...new Set(courseIds)].map((id): Topic => `course:${id}`));
}

/** Something of a project repository changed: its students and the course's staff re-read. */
export function repoChanged(courseId: string, userIds: readonly string[]): void {
  const topics: Topic[] = [`course:${courseId}`, ...new Set(userIds.map(bus.userTopic))];
  bus.hint("projects", topics);
}
