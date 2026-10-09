/**
 * "Generate answers" for a sorting question (ADR-059): the model proposes
 * columns and the cards each one takes, plus distractors that belong to
 * none. The merge keeps the teacher's columns and cards where they are: a
 * proposed column joins the teacher's column of the same label, else takes
 * an unlabelled one, else is added; a card the draft already holds is never
 * added again nor moved. Ids are the merge's, never the model's.
 */
import { z } from "zod";

import { newId } from "@quiz/core/id";
import type { AnswerGenerator } from "@quiz/core/server";

import {
  CATEGORIZE_CARD_MAX,
  CATEGORIZE_LABEL_MAX,
  CATEGORIZE_MAX_CARDS,
  CATEGORIZE_MAX_COLUMNS,
  type CategorizeCard,
  type CategorizeColumn,
  type CategorizeConfig,
} from "./schema.js";

const CategorizeProposal = z.object({
  columns: z.array(z.object({ label: z.string(), cards: z.array(z.string()) })),
  distractors: z.array(z.string()),
});
type CategorizeProposal = z.infer<typeof CategorizeProposal>;

const norm = (text: string | undefined) => (text ?? "").trim().toLowerCase().replace(/\s+/g, " ");

export function mergeCategorize(config: CategorizeConfig, proposal: CategorizeProposal): CategorizeConfig {
  const list = <T,>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  const columns: CategorizeColumn[] = list(config.columns).map((c) => ({ ...c, cards: [...list(c.cards)] }));
  const cards: CategorizeCard[] = [...list(config.cards)];
  const known = new Set(cards.map((c) => norm(c.text)));
  const claimed = new Set<CategorizeColumn>();

  /** A new card, unless the draft holds it already or is full; its id, or null. */
  const addCard = (text: string): string | null => {
    const t = text.trim().slice(0, CATEGORIZE_CARD_MAX);
    if (!t || known.has(norm(t)) || cards.length >= CATEGORIZE_MAX_CARDS) return null;
    known.add(norm(t));
    const card = { id: newId(), text: t };
    cards.push(card);
    return card.id;
  };

  for (const proposed of proposal.columns) {
    const label = proposed.label.trim().slice(0, CATEGORIZE_LABEL_MAX);
    if (!label) continue;
    let target = columns.find((c) => !claimed.has(c) && norm(c.label) === norm(label));
    if (!target) {
      target = columns.find((c) => !claimed.has(c) && norm(c.label) === "");
      if (target) target.label = label;
    }
    if (!target && columns.length < CATEGORIZE_MAX_COLUMNS) {
      target = { id: newId(), label, cards: [] };
      columns.push(target);
    }
    if (!target) continue;
    claimed.add(target);
    for (const text of proposed.cards) {
      const id = addCard(text);
      if (id) target.cards.push(id);
    }
  }
  for (const text of proposal.distractors) addCard(text);
  return { ...config, columns, cards };
}

export const categorizeGenerator: AnswerGenerator<CategorizeConfig, CategorizeProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question asks the student to sort cards into columns (categories).",
    "Propose `columns`, each with its `label` and the `cards` (short texts) that belong in it, and a few",
    "`distractors`: cards that belong in no column. Keep the labels of the columns the teacher already named,",
    "and name the unnamed ones. Between 2 and 6 columns, at most 30 cards in all, each card a few words.",
    "Never repeat a card the draft holds, and never contradict where the teacher placed one.",
  ].join(" "),
  proposalSchema: CategorizeProposal,
  merge: mergeCategorize,
};
