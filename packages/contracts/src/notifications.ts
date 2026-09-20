/**
 * Notification catalogue shared by the API (emitters) and the web app
 * (toasts). One definition: adding a kind on one side without the other is
 * a compile error.
 */

/** Real-time toast kinds carried by SSE notices (events.ts AppNotice). */
export type NoticeKind = "student_joined" | "roster_conflict";
