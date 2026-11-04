/**
 * `circuit` and `logic` on paper (ADR-126 §8–§9, 05 §5.7): the hand-out side
 * — the statement and the frame, from `toStudent` — holds no secret of a
 * full configuration in any of its three forms (the block tree, the Typst
 * source, the Markdown); the key side holds them, so the search above finds
 * nothing for the right reason.
 */
import { describe, expect, it } from "vitest";

import { LABELS, labelled, scopeZones, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";
import type { QuestionTypeServer } from "@quiz/core/server";

import { CIRCUIT_LIBRARY } from "./canvas/circuitLibrary.js";
import { atCellScale, schematicFigure } from "./canvas/figure.js";
import { circuitServer, logicServer } from "./server.js";
import {
  circuitConfig,
  circuitLeakFixture,
  logicConfig,
  logicLeakFixture,
  logicReferenceConfig,
  logicReferenceLeakFixture,
  logicSequentialConfig,
  logicSequentialLeakFixture,
  SECRET_REFERENCE_GATES,
  SECRET_REFERENCE_NAME,
} from "./testing.js";

const view = { seed: 0, itemId: "item-1", shuffle: false };
const PROVENANCE = { kind: "test", version: 1, source: {}, attempts: [], generatedAt: "2026-11-04T10:00:00.000Z", app: null };
const LANGS: readonly Lang[] = ["en", "fr"];

/**
 * The three forms of a list of blocks: its tree, its Typst body (escapes
 * undone) and its Markdown. A figure's path data and transforms are left
 * out of the search: geometry drawn from the library's constants, whose
 * digits (`a4 4 0 1 0 8 0`, a negation bubble) would match a vector's line.
 */
function forms(blocks: readonly Block[], lang: Lang): Record<"tree" | "typst" | "markdown", string> {
  const { source } = renderTypst({ provenance: PROVENANCE, lang, blocks });
  return {
    tree: JSON.stringify(blocks, (key, value: unknown) => (key === "d" || key === "transform" ? undefined : value)),
    typst: source
      .slice(source.indexOf("<provenance>"))
      .replace(/\\(.)/g, "$1")
      .replace(/ (d|transform)="[^"]*"/g, ""),
    markdown: markdownBody({ lang, blocks }),
  };
}

// The hooks are typed per type; the test reads them through the common contract.
type AnyServer = QuestionTypeServer<unknown, unknown, unknown, unknown, unknown>;

const handout = (type: AnyServer, config: unknown, lang: Lang): Block[] => {
  const student = type.toStudent(config, view);
  return scopeZones("item-1", [...type.statementDoc!(student, LABELS[lang]), ...type.answerZone!(student)]);
};

const key = (type: AnyServer, config: unknown): Block[] =>
  type.solutionDoc!(type.toSolution(config, view), type.toStudent(config, view), LABELS.en);

const CASES = [
  { name: "circuit", type: circuitServer, fixture: circuitLeakFixture, keyShows: [SECRET_REFERENCE_NAME, "123.4k", "Csecret"] },
  { name: "logic, expressions", type: logicServer, fixture: logicLeakFixture, keyShows: ["m = a \\cdot b", "p = a \\oplus b"] },
  { name: "logic, reference", type: logicServer, fixture: logicReferenceLeakFixture, keyShows: SECRET_REFERENCE_GATES },
  { name: "logic, vectors", type: logicServer, fixture: logicSequentialLeakFixture, keyShows: ["| C | 1 | 1 |", "| C | 0 | 0 |"] },
] as const;

describe.each(CASES)("$name on paper", ({ type, fixture, keyShows }) => {
  const server = type as unknown as AnyServer;
  // What the key shows as text is a secret of the hand-out too, beside the fixture's.
  const secrets = [...fixture.secrets, ...keyShows, "\\cdot", "\\oplus"];

  it.each(LANGS)("prints a hand-out with no secret in its tree, its Typst source or its Markdown (%s)", (lang) => {
    const blocks = handout(server, fixture.config, lang);
    expect(blocks.some((b) => b.kind === "answerZone" && b.zone === "free" && b.ruling?.kind === "grid")).toBe(true);
    for (const [form, text] of Object.entries(forms(blocks, lang))) {
      expect(secrets.filter((secret) => text.includes(secret)), form).toEqual([]);
    }
  });

  it("prints the key: the positive control of the search above", () => {
    const blocks = key(server, fixture.config);
    const { tree, markdown } = forms(blocks, "en");
    for (const shown of keyShows) {
      expect(markdown).toContain(shown);
      // A designator is a text of the figure, in the tree as it is.
      if (/^[\w.]+$/.test(shown)) expect(tree).toContain(shown);
    }
  });
});

describe("the circuit statement", () => {
  it("names the parts, the supplies, the ground and the visible stimuli, and counts the hidden ones", () => {
    const config = circuitConfig({ supplies: { vcc: 12, vee: null }, palette: { kinds: ["R", "C", "VCC", "VEE"], maxComponents: 6 } });
    const text = markdownBody({ lang: "en", blocks: circuitServer.statementDoc!(circuitServer.toStudent(config, view), LABELS.en) });
    // VEE is in the palette, but no rail powers it: the student is not offered it.
    expect(text).toContain("Parts: R, C, VCC\n");
    // Once: the palette figure's alt text names the list, not its content again.
    expect(text.split("Parts: ")).toHaveLength(2);
    expect(text).toContain("Parts at most: 6");
    expect(text).toContain("Supplies: VCC = 12 V");
    expect(text).toContain("in− and out− are the ground.");
    expect(text).toContain("| 10 kHz sine | Sine 1 V, 10kHz, Rs = 50 Ω | 10k Ω | 1 ms | 1 |");
    expect(text).toContain("Hidden stimuli: 1 (2 pt)");
  });

  it("frames a squared zone of the box's size, its ruling on the editor's grid", () => {
    const [zone] = circuitServer.answerZone!(circuitServer.toStudent(circuitConfig(), view));
    // The starter is the empty box and its ports, from the library's constants alone.
    expect(zone).toEqual({
      kind: "answerZone",
      zone: "free",
      heightMm: 108,
      ruling: { kind: "grid", pitchMm: 4 },
      underlay: atCellScale(schematicFigure({ components: [], wires: [] }, CIRCUIT_LIBRARY)),
    });
  });

  it("prints no key when the question has no reference", () => {
    expect(key(circuitServer as unknown as AnyServer, circuitConfig({ reference: null, grading: { mode: "manual" } }))).toEqual([]);
  });

  it("draws a student's own schematic in their copy, and says so when the box is empty", () => {
    const student = circuitServer.toStudent(circuitConfig(), view);
    const answer = circuitLeakFixture.answers![0] as Parameters<NonNullable<typeof circuitServer.studentAnswerDoc>>[1];
    const drawn = circuitServer.studentAnswerDoc!(student, answer, null, LABELS.fr);
    expect(drawn).toMatchObject([{ kind: "drawing", alt: labelled(LABELS.fr, "Schéma", "R1 1k, C1 100n, GND") }]);
    const empty = circuitServer.studentAnswerDoc!(student, { schematic: { components: [], wires: [] } }, null, LABELS.fr);
    expect(markdownBody({ lang: "fr", blocks: empty })).toContain("Pas de réponse.");
  });
});

describe("the logic statement", () => {
  it("names the declared signals, the symbols and the gates, never the mode", () => {
    for (const config of [logicConfig(), logicSequentialConfig(), logicReferenceConfig({ symbols: "ansi" })]) {
      const student = logicServer.toStudent(config, view);
      const text = markdownBody({ lang: "fr", blocks: logicServer.statementDoc!(student, LABELS.fr) });
      const fr = (label: string, value: string) => labelled(LABELS.fr, label, value);
      expect(text).toContain(fr("Entrées", config.inputs.join(", ")));
      expect(text).toContain(fr("Sorties", config.outputs.map((o) => o.name).join(", ")));
      expect(text).toContain(fr("Symboles", config.symbols === "ansi" ? "ANSI" : "IEC 60617"));
      expect(text).not.toMatch(/sequential|séquentiel|combinational|combinatoire/i);
    }
  });

  it("starts the frame with the declared terminals, as the editor does", () => {
    const [zone] = logicServer.answerZone!(logicServer.toStudent(logicConfig(), view));
    if (zone?.kind !== "answerZone" || zone.underlay === undefined) throw new Error("no underlay");
    const texts = JSON.stringify(zone.underlay).match(/"text":"[^"]*"/g);
    expect(texts?.sort()).toEqual(['"text":"a"', '"text":"b"', '"text":"c"', '"text":"m"', '"text":"p"']);
  });
});
