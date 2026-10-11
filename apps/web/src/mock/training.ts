/**
 * Section 13 — the training course (ADR-105): the caller's status and the
 * provisioning. The flags pick the state the card and the home's offer show:
 *
 *  - none          — the content is installed, the teacher has no course yet:
 *                    the empty home's line (`?empty=1`), the menu's entry;
 *  - `training`    — PRG1-2026 (`r1`) is the teacher's training classroom:
 *                    the card with every mission to do, the fourth one
 *                    unavailable (no LLM, no OAuth client);
 *  - `trainingdone` — the same, missions 1 to 3 done: the complete state;
 *  - `notraining`  — the content is not installed: no line, no entry.
 *
 * Provisioning from the mock names `r1` as well, so the three doors land on
 * the classroom the card is drawn on.
 */
import type { TrainingProvisionResponse, TrainingStatus } from "@quiz/contracts";

import { EVAL_ROOM, evaluations, makeEvaluation } from "./evaluation";
import { D, H, flags, iso, MockError, on, role } from "./runtime";

/** The mock's course and classroom ids are not uuids; the client never parses them. */
const COURSE = { id: "c1", classroomId: EVAL_ROOM };

let provisioned = flags.training || flags.trainingdone;

/* The two quizzes of ADR-105 §3, in the training classroom, in their states. */
if (provisioned && !flags.empty) {
  evaluations.push(
    makeEvaluation(EVAL_ROOM, "Le quiz d'accueil", "scheduled", 7, {
      mode: "exercise",
      durationS: null,
      opensAt: iso(-2 * H),
      closesAt: iso(120 * D),
    }),
    makeEvaluation(EVAL_ROOM, "Le quiz en direct", "draft", 2),
  );
}

const teacherOnly = () => {
  if (role === "student") throw new MockError(403, "forbidden");
};

on("GET", "/app/api/training", (): TrainingStatus => {
  teacherOnly();
  const done = flags.trainingdone;
  return {
    installed: !flags.notraining,
    course: provisioned ? COURSE : null,
    missions: [
      { key: "student", state: done ? "done" : "todo" },
      { key: "run", state: done ? "done" : "todo" },
      { key: "own", state: done ? "done" : "todo" },
      { key: "tools", state: done ? "todo" : "unavailable" },
    ],
  };
});

on("POST", "/app/api/training", (): TrainingProvisionResponse => {
  teacherOnly();
  if (flags.notraining) throw new MockError(409, "training_not_installed");
  const created = !provisioned;
  provisioned = true;
  return { courseId: COURSE.id, classroomId: COURSE.classroomId, created };
});
