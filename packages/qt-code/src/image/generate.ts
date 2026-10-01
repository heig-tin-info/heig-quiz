/**
 * "Generate answers" for a picture question (ADR-059 §7): the model writes
 * the reference program; the TARGET is the picture that program draws, run
 * on the runner (`settle`), never drawn by the model. A reference the
 * teacher wrote, and a target they already chose, are kept.
 */
import { z } from "zod";

import type { AnswerGenerator, RunnerService } from "@quiz/core/server";

import { mergeReference, REFERENCE_RULES, runnableReference, usableRun } from "../generate.js";
import { assembleCodeSource } from "../grade.js";
import { buildImageRequest } from "./grade.js";
import { encodeImage, parseImageOutput } from "./pixels.js";
import { makeTarget, type CodeImageConfig } from "./schema.js";

const CodeImageProposal = z.object({ referenceSolution: z.string() });
type CodeImageProposal = z.infer<typeof CodeImageProposal>;

/**
 * Runs the reference and makes what it draws the target, when the draft has
 * none. A run cut short, or a picture with an invalid or a missing pixel, is
 * no target: the result says `partial`, and the teacher decides in Try.
 */
export async function settleCodeImage(
  config: CodeImageConfig,
  runner: RunnerService,
): Promise<{ config: CodeImageConfig; incomplete?: "compile_failed" | "partial" }> {
  const regions = runnableReference(config);
  if (regions === null || config.target != null) return { config };
  const outcome = await runner.run(buildImageRequest(config, assembleCodeSource(config, { regions }), "interactive"));
  if (!outcome.compile.ok) return { config, incomplete: "compile_failed" };
  const run = outcome.cases[0];
  if (!usableRun(run)) return { config, incomplete: "partial" };
  const parsed = parseImageOutput(run.stdout, config.image);
  if (parsed.invalid > 0 || parsed.missing > 0) return { config, incomplete: "partial" };
  return { config: { ...config, target: makeTarget(config.image, encodeImage(parsed.pixels, config.image.palette)) } };
}

export const codeimageGenerator: AnswerGenerator<CodeImageConfig, CodeImageProposal> = {
  statement: (config) => config.prompt ?? "",
  instructions: [
    "The question asks for a program that DRAWS a picture by printing its pixels on stdout: `image.width`",
    "times `image.height` integers separated by whitespace, row by row from the top left; `image.palette` says",
    "their range: `bw` 0 (black) or 1 (white), `color16` 0 to 15 (the CGA colours), `gray256` 0 to 255.",
    "Propose `referenceSolution`, the program that draws exactly the picture the statement describes.",
    REFERENCE_RULES,
  ].join(" "),
  proposalSchema: CodeImageProposal,
  merge: (config, proposal) => mergeReference(config, proposal.referenceSolution),
  settle: settleCodeImage,
};
