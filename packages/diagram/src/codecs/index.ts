/**
 * The text form of each kind (ADR-041 §2): a scene serialises to it, and the
 * EDITOR parses it back. The server serialises only; it never parses a text
 * that came from a browser.
 */
import { estimateText, type Measure } from "../geometry.js";
import type { DiagramKind } from "../kinds.js";
import type { Scene } from "../scene.js";
import { dotToText, parseDot } from "./dot.js";
import { erToText, flowToText, parseEr, parseFlow, parseState, stateToText } from "./mermaid.js";
import { emptyParsed, type Parsed } from "./parsed.js";
import { classToText, parsePlantUml, usecaseToText } from "./plantuml.js";

/** The text of a scene, or `null` for a kind without one (`free`). */
export function toText(scene: Scene, kind: DiagramKind, measure: Measure = estimateText): string | null {
  switch (kind) {
    case "class":
      return classToText(scene);
    case "usecase":
      return usecaseToText(scene, measure);
    case "state":
      return stateToText(scene);
    case "er":
      return erToText(scene);
    case "flow":
      return flowToText(scene);
    case "automaton":
    case "graph":
      return dotToText(scene, kind);
    case "free":
      return null;
  }
}

export function parseText(text: string, kind: DiagramKind): Parsed {
  switch (kind) {
    case "class":
    case "usecase":
      return parsePlantUml(text, kind);
    case "state":
      return parseState(text);
    case "er":
      return parseEr(text);
    case "flow":
      return parseFlow(text);
    case "automaton":
    case "graph":
      return parseDot(text, kind);
    case "free":
      return emptyParsed();
  }
}
