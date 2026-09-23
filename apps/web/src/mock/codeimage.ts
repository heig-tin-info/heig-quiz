/**
 * The `codeimage` question of the mock (docs/spec/04 §4.9, ADR-021): one
 * config, the student view `toStudent` would publish, and the picture a run
 * "prints" — there is no runner here, so the mock draws what the C program
 * below draws, with the same function written in TypeScript.
 *
 * The student view is written out field by field rather than taken from
 * `@quiz/qt-code/server`: that entry point carries the grader, which reads
 * `node:crypto`, and this file runs in the browser.
 */
import { splitTemplate } from "@quiz/domain";
import type { RunnerOutcome } from "@quiz/core/server";
import {
  encodeImage,
  type CodeImageDetails,
  type CodeImageStudent,
  type ImageSpec,
} from "@quiz/qt-code/client";

export const IMAGE_TEMPLATE =
  "// @@lock\n#include <stdio.h>\n\n" +
  "/* La couleur de la cellule (x, y) : un indice de 0 à 15. */\n" +
  "int couleur(int x, int y);\n\n" +
  "int main(void) {\n" +
  "    for (int y = 0; y < 16; y++) {\n" +
  "        for (int x = 0; x < 16; x++) printf(\"%d \", couleur(x, y));\n" +
  "        printf(\"\\n\");\n" +
  "    }\n" +
  "    return 0;\n" +
  "}\n// @@endlock\n\n" +
  "int couleur(int x, int y) {\n    // votre code ici\n    return 0;\n}\n";

export const IMAGE_REFERENCE =
  "int couleur(int x, int y) {\n" +
  "    int bord = x < y ? x : y;\n" +
  "    if (15 - x < bord) bord = 15 - x;\n" +
  "    if (15 - y < bord) bord = 15 - y;\n" +
  "    return 9 + bord % 7;\n" +
  "}\n";

/** What the reference solution prints, cell by cell: concentric squares. */
export function concentric(spec: ImageSpec): number[] {
  const max = spec.palette === "bw" ? 1 : spec.palette === "color16" ? 15 : 255;
  const out: number[] = [];
  for (let y = 0; y < spec.height; y += 1) {
    for (let x = 0; x < spec.width; x += 1) {
      const ring = Math.min(x, y, spec.width - 1 - x, spec.height - 1 - y);
      out.push(
        spec.palette === "color16"
          ? 9 + (ring % 7)
          : spec.palette === "bw"
            ? ring % 2
            : Math.min(max, ring * 32),
      );
    }
  }
  return out;
}

/**
 * The student's attempt as the mock runs it: the squares, off by one ring
 * in the middle — close enough for the difference view to have something
 * red and green to show.
 */
export function studentAttemptStdout(spec: ImageSpec): string {
  const pixels = concentric(spec).map((v, i) => {
    const x = i % spec.width;
    const y = Math.floor(i / spec.width);
    const ring = Math.min(x, y, spec.width - 1 - x, spec.height - 1 - y);
    return ring >= 5 ? 1 : v;
  });
  const rows: string[] = [];
  for (let y = 0; y < spec.height; y += 1) {
    rows.push(pixels.slice(y * spec.width, (y + 1) * spec.width).join(" "));
  }
  return `${rows.join("\n")}\n`;
}

const SPEC: ImageSpec = { width: 16, height: 16, palette: "color16" };

export function codeimageConfig(): Record<string, unknown> {
  return {
    configVersion: 1,
    prompt:
      "Complétez `couleur` pour que le programme dessine des **carrés concentriques** : " +
      "la couleur d'une cellule ne dépend que de sa distance au bord le plus proche. " +
      "Comparez votre image à la cible, puis passez à la vue différence.",
    language: "c",
    runtime: "backend",
    template: IMAGE_TEMPLATE,
    files: [],
    action: "run",
    compileArgs: "-Wall",
    limits: { timeMs: 2000, memoryMb: 128, outputKb: 128 },
    runsPerMinute: 10,
    referenceSolution: IMAGE_REFERENCE,
    image: SPEC,
    target: { ...SPEC, pixels: encodeImage(concentric(SPEC), SPEC.palette) },
  };
}

/** `toStudent`, field by field: the target travels, the reference does not. */
export function codeimageStudentView(config: Record<string, unknown>): CodeImageStudent {
  return {
    prompt: String(config.prompt ?? ""),
    language: "c",
    runtime: config.runtime === "runno" ? "runno" : "backend",
    segments: splitTemplate(String(config.template ?? ""), "c"),
    limits: config.limits as CodeImageStudent["limits"],
    runsPerMinute: Number(config.runsPerMinute ?? 10),
    filesPreview: [],
    image: config.image as ImageSpec,
    target: (config.target ?? null) as CodeImageStudent["target"],
  };
}

/** The raw outcome of a student's run, as `POST /attempts/:id/simulate` answers it. */
export function codeimageRunOutcome(spec: ImageSpec = SPEC): RunnerOutcome {
  return {
    compile: { ok: true, stdout: "", stderr: "", ms: 180 },
    cases: [
      {
        exitCode: 0,
        stdout: studentAttemptStdout(spec),
        stderr: "",
        ms: 4,
        timedOut: false,
        oom: false,
        truncated: false,
      },
    ],
  };
}

/**
 * `POST /questions/:id/try` for the teacher's reference: the grading's
 * details carry the picture, which the editor offers to "Use as target".
 */
export function codeimageTryDetails(config: Record<string, unknown>): CodeImageDetails {
  const spec = config.image as ImageSpec;
  const pixels = concentric(spec);
  // A target captured for another size or palette is no target (ADR-021).
  const stored = config.target as (ImageSpec & { pixels: string }) | null | undefined;
  const fits =
    stored != null &&
    stored.width === spec.width &&
    stored.height === spec.height &&
    stored.palette === spec.palette;
  const target = fits ? stored.pixels : "";
  const image = encodeImage(pixels, spec.palette);
  const width = spec.palette === "gray256" ? 2 : 1;
  let matching = 0;
  for (let i = 0; i < pixels.length; i += 1) {
    if (target.slice(i * width, i * width + width) === image.slice(i * width, i * width + width)) {
      matching += 1;
    }
  }
  return {
    runner: "ok",
    compile: { ok: true, stderr: "", ms: 180 },
    run: { exitCode: 0, timedOut: false, oom: false, truncated: false, ms: 4 },
    image,
    matching,
    pixelCount: pixels.length,
    warnings: [],
    sourceSha256: null,
  };
}
