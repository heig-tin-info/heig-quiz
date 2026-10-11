/**
 * A training content of two automatically graded questions (ADR-105 §2),
 * for the tests of the `training` module: built like `seed/content.ts`,
 * injected into `install` in place of the real `content.ts`.
 */
import type { TrainingContent, TrainingQuestionSpec } from "../modules/training/content-types.js";

export const TRAINING_MCQ: TrainingQuestionSpec = {
  internalName: "init-mcq-navigation",
  type: "mcq",
  category: "Le quiz",
  difficulty: 1,
  explanation: "La navigation libre se règle dans l'étape Modalité de l'évaluation.",
  config: {
    configVersion: 2,
    prompt: "Pouvez-vous revenir à la question précédente de ce quiz ?",
    mode: "single",
    policy: "all_or_nothing",
    shuffleChoices: true,
    choices: [
      { text: "Oui : la navigation est libre.", correct: true },
      { text: "Non : chaque question est définitive.", correct: false },
    ],
  },
};

export const TRAINING_SHORT: TrainingQuestionSpec = {
  internalName: "init-short-code",
  type: "short",
  category: "Le cours",
  difficulty: 1,
  explanation: "Le code du cours se lit dans son en-tête ; il est modifiable dans les réglages.",
  config: {
    configVersion: 2,
    prompt: "Quel préfixe porte le code du cours d'initiation ?",
    kind: "text",
    placeholder: "un préfixe",
    constraints: { maxLength: 10 },
    prefilters: { trim: true, lowercase: true },
    matchers: [{ kind: "exact", value: "init" }],
  },
};

/** The fixture, with the questions (or the explanation of one) overridden when a test changes the content. */
export function trainingFixture(questions: TrainingQuestionSpec[] = [TRAINING_MCQ, TRAINING_SHORT]): TrainingContent {
  return {
    pool: { name: "Prise en main (test)", description: "Le contenu d'initiation des tests.", icon: "graduation-cap" },
    questions,
    evaluations: [
      {
        key: "welcome",
        title: "Le quiz d'accueil",
        mode: "exercise",
        target: "scheduled",
        questions: questions.map((q) => q.internalName),
      },
      { key: "live", title: "Le quiz en direct", mode: "exam", target: "draft", questions: questions.map((q) => q.internalName) },
    ],
  };
}
