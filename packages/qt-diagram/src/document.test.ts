import { describe, expect, it } from "vitest";

import { EN_LABELS, FR_LABELS, PX_MM, scopeZones, toSvg, type AnswerZone, type Block, type Lang } from "@quiz/docexport";
import { markdownBody } from "@quiz/docexport/markdown";
import { renderTypst } from "@quiz/docexport/typst";
import { DIAGRAM_KINDS, GRID, type Scene } from "@quiz/diagram/server";

import type { DiagramConfig } from "./schema.js";
import { diagramServer } from "./server.js";
import { diagramLeakFixture, REFERENCE, SECRET_CONFIG, STARTER } from "./testing.js";

const view = { seed: 0, itemId: "item-1", shuffle: false };
const PROVENANCE = { kind: "test", version: 1, source: {}, attempts: [], generatedAt: "2026-11-04T10:00:00.000Z", app: null };
const LABELS = { en: EN_LABELS, fr: FR_LABELS } as const;

/** The hand-out's blocks of `config`: its statement and its frame, from the student view alone. */
const handout = (config: DiagramConfig, lang: Lang = "en"): Block[] => {
  const student = diagramServer.toStudent(config, view);
  return scopeZones("item-1", [...diagramServer.statementDoc!(student, LABELS[lang]), ...diagramServer.answerZone!(student)]);
};

/** The staff key's blocks of `config`: the statement, then the solution. */
const key = (config: DiagramConfig): Block[] => {
  const student = diagramServer.toStudent(config, view);
  return [...diagramServer.statementDoc!(student, EN_LABELS), ...diagramServer.solutionDoc!(diagramServer.toSolution(config, view), student, EN_LABELS)];
};

/** The three forms a document takes: its tree, its Typst source (escapes undone), its Markdown. */
const forms = (blocks: Block[], lang: Lang = "en"): Record<string, string> => ({
  tree: JSON.stringify(blocks),
  typst: renderTypst({ provenance: PROVENANCE, lang, blocks }).source.replace(/\\(.)/g, "$1"),
  markdown: markdownBody({ lang, blocks }),
});

/** The key's values a figure or a text writes: names, members, the link's name, the rubric. */
const KEY_TEXTS = ["SecretFigureRef", "SecretCircleRef", "secretOrigin", "secretArea", "secretRadius", "secretLinkName"];

const frameOf = (blocks: readonly Block[]): AnswerZone => blocks.find((b): b is AnswerZone => b.kind === "answerZone")!;

describe("the diagram on paper (ADR-126)", () => {
  it.each(["en", "fr"] as const)("hands out the prompt, the notation and a squared frame with the starter, and no key (%s)", (lang) => {
    const blocks = handout(SECRET_CONFIG, lang);
    for (const [form, text] of Object.entries(forms(blocks, lang))) {
      expect(diagramLeakFixture.secrets.filter((secret) => text.includes(secret)), form).toEqual([]);
      expect(text, form).toContain(SECRET_CONFIG.prompt);
    }
    expect(forms(blocks, lang).markdown).toContain(lang === "en" ? "Notation: UML class diagram" : "Notation : Diagramme de classes UML");
    const frame = frameOf(blocks);
    expect(frame).toMatchObject({ zone: "free", id: "item-1", ruling: { kind: "grid", pitchMm: GRID * PX_MM } });
    // The starter, drawn in grey under the frame: its class's name is in it.
    const under = toSvg(frame.underlay!, { greyed: true });
    expect(under.ok && under.svg).toContain(">Shape</text>");
    expect(under.ok && under.svg).not.toContain("#000000");
  });

  it.each(["en", "fr"] as const)("names every notation in the reader's words, each its own (%s)", (lang) => {
    const names = DIAGRAM_KINDS.map((kind) => {
      const student = diagramServer.toStudent({ ...SECRET_CONFIG, kind, starter: undefined }, view);
      const [, notation] = diagramServer.statementDoc!(student, LABELS[lang]);
      return notation?.kind === "markdown" ? notation.text : "";
    });
    expect(names.every((name) => name.startsWith("Notation"))).toBe(true);
    expect(new Set(names).size).toBe(DIAGRAM_KINDS.length);
  });

  it("sizes the frame from the starter or a default, never from the reference (ADR-126 §6)", () => {
    const huge: Scene = {
      nodes: Array.from({ length: 12 }, (_, i) => ({ id: `big${i}xx01`, t: "class" as const, x: 0, y: i * 200, name: `Big${i}` })),
      links: [],
    };
    const height = (config: DiagramConfig) => frameOf(handout(config)).heightMm;
    const base = height(SECRET_CONFIG);
    expect(height({ ...SECRET_CONFIG, reference: huge })).toBe(base);
    expect(height({ ...SECRET_CONFIG, starter: undefined })).toBe(160);
    expect(height({ ...SECRET_CONFIG, starter: undefined, reference: huge })).toBe(160);
    // A tall starter gets room under it, within the renderer's bound.
    const tall = height({ ...SECRET_CONFIG, starter: { nodes: huge.nodes.slice(0, 4), links: [] } });
    expect(tall).toBeGreaterThan(160);
    expect(tall).toBeLessThanOrEqual(240);
    // No starter, no underlay: an empty frame.
    expect(frameOf(handout({ ...SECRET_CONFIG, starter: undefined })).underlay).toBeUndefined();
  });

  it("draws the reference in the staff key, with its text form, the starter and the rubric", () => {
    const { tree, typst, markdown } = forms(key(SECRET_CONFIG));
    for (const text of KEY_TEXTS) {
      expect(tree).toContain(text);
      expect(typst).toContain(text);
      expect(markdown).toContain(text);
    }
    expect(markdown).toContain("```plantuml");
    expect(markdown).toContain("**Starting diagram**");
    expect(markdown).toContain(SECRET_CONFIG.rubric);
    expect(typst).toContain("#figsvg(");
  });

  it("gives a student under a shown key the reference, never the rubric", () => {
    const student = diagramServer.toStudent(SECRET_CONFIG, view);
    const own = diagramServer.studentSolution!(diagramServer.toSolution(SECRET_CONFIG, view), SECRET_CONFIG)!;
    const { markdown } = forms(diagramServer.solutionDoc!(own, student, FR_LABELS), "fr");
    expect(markdown).toContain("SecretFigureRef");
    expect(markdown).not.toContain(SECRET_CONFIG.rubric);
    expect(markdown).toContain("Diagramme de départ");
  });

  it("draws a free drawing with no text form, and a key of a kind with no starter", () => {
    const free: DiagramConfig = {
      ...SECRET_CONFIG,
      kind: "free",
      reference: { nodes: [{ id: "f1abcdef", t: "rect", x: 20, y: 20, w: 100, h: 60, name: "Box" }], links: [] },
      starter: undefined,
    };
    const blocks = key(free);
    expect(blocks.filter((b) => b.kind === "drawing")).toHaveLength(1);
    expect(blocks.some((b) => b.kind === "code")).toBe(false);
  });

  it("draws an answer: the staff's with its text form, the student's alone, and says when there is none", () => {
    const answer = { scene: REFERENCE };
    const staff = markdownBody({ lang: "en", blocks: diagramServer.answerDoc!(SECRET_CONFIG, answer, null) });
    expect(staff).toContain("```plantuml");
    expect(staff).toContain("SecretCircleRef");
    const student = diagramServer.toStudent(SECRET_CONFIG, view);
    const own = diagramServer.studentAnswerDoc!(student, { scene: STARTER }, null, FR_LABELS);
    expect(own).toMatchObject([{ kind: "drawing", alt: "Votre réponse" }]);
    const none = diagramServer.studentAnswerDoc!(student, { scene: { nodes: [], links: [] } }, null, FR_LABELS);
    expect(markdownBody({ lang: "fr", blocks: none })).toBe("Pas de réponse.\n");
    expect(markdownBody({ lang: "en", blocks: diagramServer.answerDoc!(SECRET_CONFIG, { scene: { nodes: [], links: [] } }, null) })).toBe(
      "No answer.\n",
    );
  });
});
