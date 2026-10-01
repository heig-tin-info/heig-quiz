/**
 * "Generate answers" for a multiple-choice question (ADR-059): the model
 * proposes choices, the merge keeps every choice the teacher wrote — text and
 * tick — fills the empty rows in place, then appends the rest.
 */
import { z } from "zod";

import type { AnswerGenerator } from "@quiz/core/server";

import { MCQ_MAX_CHOICES, type McqChoice, type McqConfig } from "./schema.js";

const ProposedChoice = z.object({ text: z.string(), correct: z.boolean() });
type ProposedChoice = z.infer<typeof ProposedChoice>;

const McqProposal = z.object({ choices: z.array(ProposedChoice) });
type McqProposal = z.infer<typeof McqProposal>;

const blank = (text: string | undefined) => (typeof text === "string" ? text : "").trim() === "";
/** A draft's choices, whatever the draft holds (D16). */
const choicesOf = (config: McqConfig): McqChoice[] => (Array.isArray(config.choices) ? config.choices : []);
const same = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * The ticks a proposed choice may carry: in `single` mode, one correct
 * choice in all, the teacher's first. `taken` says whether the key already
 * has its correct choice.
 */
function tick(config: McqConfig, proposed: boolean, taken: boolean): boolean {
  return config.mode === "single" ? proposed && !taken : proposed;
}

export function mergeMcq(config: McqConfig, proposal: McqProposal): McqConfig {
  const choices = choicesOf(config);
  const seen = new Set(choices.filter((c) => !blank(c.text)).map((c) => same(c.text)));
  const fresh = proposal.choices.filter((c) => {
    if (blank(c.text) || seen.has(same(c.text))) return false;
    seen.add(same(c.text));
    return true;
  });
  let taken = choices.some((c) => !blank(c.text) && c.correct);
  const take = (): McqChoice | null => {
    const next = fresh.shift();
    if (!next) return null;
    const correct = tick(config, next.correct, taken);
    taken ||= correct;
    return { text: next.text.trim(), correct };
  };
  // The empty rows first, where the teacher left them; an empty row the
  // proposal cannot fill stays as it was.
  const filled = choices.map((c) => (blank(c.text) ? (take() ?? c) : c));
  const added: McqChoice[] = [];
  while (filled.length + added.length < MCQ_MAX_CHOICES) {
    const next = take();
    if (!next) break;
    added.push(next);
  }
  return { ...config, choices: [...filled, ...added] };
}

export const mcqGenerator: AnswerGenerator<McqConfig, McqProposal, ProposedChoice> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question is a multiple-choice question.",
    "Propose its choices: the correct answer or answers, and plausible distractors that a student who",
    "misunderstood would pick; 4 or 5 choices in all, counting the teacher's own.",
    "`mode: single` means exactly one choice is correct; `multiple`, any number.",
    "Return ONLY choices the draft does not hold yet: never repeat one of the teacher's, and never",
    "contradict the choices the teacher already ticked. Keep each choice short; Markdown is allowed.",
  ].join(" "),
  proposalSchema: McqProposal,
  merge: mergeMcq,
  item: {
    instructions: [
      "Propose ONE new choice for the empty row: a plausible distractor, or a missing correct answer",
      "when the key is incomplete. It must differ from every choice already written.",
    ].join(" "),
    schema: ProposedChoice,
    accepts: (config, index) => index < choicesOf(config).length && blank(choicesOf(config)[index]?.text),
    place(config, index, item) {
      const taken = choicesOf(config).some((c, i) => i !== index && !blank(c.text) && c.correct);
      const choices = choicesOf(config).map((c, i) =>
        i === index ? { text: item.text.trim(), correct: tick(config, item.correct, taken) } : c,
      );
      return { ...config, choices };
    },
  },
};
