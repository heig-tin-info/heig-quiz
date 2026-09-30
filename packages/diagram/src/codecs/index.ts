/**
 * The text form of each kind (ADR-046 §2): a scene serialises to it, and the
 * EDITOR parses it back. The server serialises only; it never parses a text
 * that came from a browser.
 */
import { estimateText, type Measure } from "../geometry.js";
import type { DiagramKind } from "../kinds.js";
import type { Scene } from "../scene.js";
import { dotToText, parseDot } from "./dot.js";
import { erToText, flowToText, parseEr, parseFlow, parseState, stateToText } from "./mermaid.js";
import type { Parsed } from "./parsed.js";
import { classToText, parsePlantUml, usecaseToText } from "./plantuml.js";

export interface Codec {
  write: (scene: Scene, measure: Measure) => string;
  read: (text: string) => Parsed;
}

/** One codec per kind; `free` has no text form. */
export const CODECS: Readonly<Record<DiagramKind, Codec | null>> = {
  class: { write: classToText, read: (t) => parsePlantUml(t, "class") },
  usecase: { write: usecaseToText, read: (t) => parsePlantUml(t, "usecase") },
  state: { write: stateToText, read: parseState },
  er: { write: erToText, read: parseEr },
  flow: { write: flowToText, read: parseFlow },
  automaton: { write: (s) => dotToText(s, "automaton"), read: (t) => parseDot(t, "automaton") },
  graph: { write: (s) => dotToText(s, "graph"), read: (t) => parseDot(t, "graph") },
  free: null,
};

/** The text of a scene, or `null` for a kind without one. */
export const toText = (scene: Scene, kind: DiagramKind, measure: Measure = estimateText): string | null =>
  CODECS[kind]?.write(scene, measure) ?? null;
