/**
 * The shape of the training content (ADR-105 §2): what `content.ts` declares
 * and what the `training.install` task installs through the ordinary pool
 * services. Pure types, no data, no service call. Modelled on
 * `seed/content.ts`; gives way to `canonical` when that package lands.
 */
import type { QuestionTypeId } from "@quiz/contracts";

export interface TrainingQuestionSpec {
  /**
   * Unique inside the training pool, and the key the install is idempotent on
   * (`questions.internal_name`). Stable forever: renaming one creates a new
   * question and orphans the old.
   */
  internalName: string;
  type: QuestionTypeId;
  /** Name of the category (folder) this question lives in. */
  category: string;
  /** 1 (trivial) to 5 (hard), as `questions.difficulty` stores it. */
  difficulty: number;
  /**
   * French, like the statement: what the teacher would configure to obtain the
   * behaviour the question showed. Shown under the exercise's feedback policy.
   */
  explanation: string;
  /**
   * The type's configuration (statement included), validated by the type's own
   * schema at publish. A change here, or in `explanation`, publishes a new
   * version at the next install; the evaluations already instantiated keep
   * their frozen one and offer "Update" (F-EVAL-03).
   */
  config: unknown;
}

export interface TrainingEvaluationSpec {
  /** `welcome` (mission 1) or `live` (mission 2). */
  key: "welcome" | "live";
  /** French, as the teacher reads it in Activities. */
  title: string;
  mode: "exercise" | "exam";
  /**
   * `scheduled`: open at provisioning, closed by the ticker at the end of the
   * classroom's period. `draft`: left for the teacher to configure and open.
   */
  target: "scheduled" | "draft";
  /** `internalName`s, in the order the items must appear. */
  questions: string[];
}

export interface TrainingContent {
  pool: {
    /** French. The install finds the pool by `pools.is_training`, never by this. */
    name: string;
    description: string;
    /** A lucide icon name, as any pool's. */
    icon: string;
  };
  questions: TrainingQuestionSpec[];
  evaluations: TrainingEvaluationSpec[];
}
