/**
 * The error types the question-type contract may raise (PLAN-MVP §1).
 *
 * Every one carries a stable machine `code`: the API maps it to an HTTP status
 * and the grading worker branches on it (a `runner_unavailable` grading is
 * stored as `proposed`, never lost — decision D14).
 */

/** Base class, so an `instanceof QuizCoreError` check covers all of them. */
export abstract class QuizCoreError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** No question type is registered under this id (registry lookup failure). */
export class UnknownQuestionType extends QuizCoreError {
  readonly code = "unknown_question_type";

  constructor(readonly id: string) {
    super(`unknown question type: ${id}`);
  }
}

/** A stored config cannot be raised to the current `configVersion`. */
export class ConfigMigrationError extends QuizCoreError {
  readonly code = "config_migration_failed";

  constructor(
    readonly typeId: string,
    readonly fromVersion: number,
    readonly toVersion: number,
    readonly reason: string,
  ) {
    super(`cannot migrate ${typeId} config from v${fromVersion} to v${toVersion}: ${reason}`);
  }
}

/** No runner engine is configured or healthy (the MVP default, decision D14). */
export class RunnerUnavailable extends QuizCoreError {
  readonly code = "runner_unavailable";

  constructor(readonly reason: string = "not_configured") {
    super(`runner unavailable: ${reason}`);
  }
}

/** The runner answered 429: its queues are full. Retried by the job, never by the request path. */
export class RunnerBusy extends QuizCoreError {
  readonly code = "runner_busy";

  constructor(readonly retryAfterMs: number | null = null) {
    super("runner busy");
  }
}
