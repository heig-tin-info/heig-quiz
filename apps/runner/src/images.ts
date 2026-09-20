import type { RunnerLanguage } from "@quiz/core/server";

import type { RunnerConfig } from "./config.js";
import type { Engine } from "./engine.js";

/** The five languages of the contract; an image may exist for any subset. */
export const LANGUAGES: readonly RunnerLanguage[] = ["c", "cpp", "python", "js", "rust"];

/** `quiz-runner-c:latest` — what images/build.sh tags. */
export function imageRef(config: RunnerConfig, language: RunnerLanguage): string {
  return `${config.RUNNER_IMAGE_PREFIX}-${language}:${config.RUNNER_IMAGE_TAG}`;
}

/**
 * Which languages this engine can actually serve.
 *
 * Podman prints its local images as `localhost/quiz-runner-c:latest` but
 * accepts the short name on the command line, so the comparison is on the
 * suffix. A language without an image is not offered by `GET /health` and
 * `POST /run` refuses it with 400 rather than failing a whole grading pass on
 * a pull that cannot happen (the runner never pulls: it has no registry
 * credentials and, in production, no route to a registry).
 */
export function availableLanguages(
  refs: readonly string[],
  config: RunnerConfig,
): RunnerLanguage[] {
  return LANGUAGES.filter((language) => {
    const ref = imageRef(config, language);
    return refs.some((candidate) => candidate === ref || candidate.endsWith(`/${ref}`));
  });
}

/** Asks the engine, once per call; `GET /health` caches it for a few seconds. */
export async function listAvailableLanguages(
  engine: Engine,
  config: RunnerConfig,
): Promise<RunnerLanguage[]> {
  return availableLanguages(await engine.listImages(), config);
}
