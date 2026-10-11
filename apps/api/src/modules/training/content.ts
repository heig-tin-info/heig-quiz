/**
 * The training content (ADR-105 §2): the public pool, its questions and the
 * two evaluation definitions the provisioning instantiates. STUB, replaced
 * by the content PR: the pool and the two evaluations are declared, the
 * questions are not yet. Pure data, as `seed/content.ts`; `service.ts`
 * installs it through the ordinary pool services.
 */
import type { TrainingContent } from "./content-types.js";

export const TRAINING_CONTENT: TrainingContent = {
  pool: {
    name: "Prise en main de Quiz",
    description: "Les questions du cours d'initiation : chacune enseigne un geste de la plateforme.",
    icon: "graduation-cap",
  },
  questions: [],
  evaluations: [
    { key: "welcome", title: "Le quiz d'accueil", mode: "exercise", target: "scheduled", questions: [] },
    { key: "live", title: "Le quiz en direct", mode: "exam", target: "draft", questions: [] },
  ],
};
