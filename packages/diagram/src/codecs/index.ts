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
  /** The notation, in a few English words a grading prompt quotes (ADR-063). */
  form: string;
  write: (scene: Scene, measure: Measure) => string;
  read: (text: string) => Parsed;
}

/** One codec per kind; `free` has no text form. */
export const CODECS: Readonly<Record<DiagramKind, Codec | null>> = {
  class: { form: "a UML class diagram in PlantUML", write: classToText, read: (t) => parsePlantUml(t, "class") },
  usecase: {
    form: "a UML use case diagram in PlantUML",
    write: usecaseToText,
    read: (t) => parsePlantUml(t, "usecase"),
  },
  state: { form: "a state diagram in Mermaid", write: stateToText, read: parseState },
  er: { form: "an entity-relationship diagram in Mermaid", write: erToText, read: parseEr },
  flow: { form: "a flowchart in Mermaid", write: flowToText, read: parseFlow },
  automaton: {
    form: "a finite automaton in Graphviz DOT",
    write: (s) => dotToText(s, "automaton"),
    read: (t) => parseDot(t, "automaton"),
  },
  graph: {
    form: "a graph in Graphviz DOT",
    write: (s) => dotToText(s, "graph"),
    read: (t) => parseDot(t, "graph"),
  },
  free: null,
};

/** What a kind's text form is, for a reader who is not the editor; `null` for a kind without one. */
export const formOf = (kind: DiagramKind): string | null => CODECS[kind]?.form ?? null;

/** The text of a scene, or `null` for a kind without one. */
export const toText = (scene: Scene, kind: DiagramKind, measure: Measure = estimateText): string | null =>
  CODECS[kind]?.write(scene, measure) ?? null;
