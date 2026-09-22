import { RunnerLanguage } from "@quiz/core/server";

import type { RunnerConfig } from "./config.js";

/**
 * The languages of the contract, in its own order; an image may exist for any
 * subset.
 *
 * Taken from the schema rather than written out again: this list and
 * `RunnerLanguage` must agree, and a language added to the contract with no
 * image simply reports as unavailable — which is the behaviour anyway
 * (`availableLanguages` below), and better than a request the service accepts
 * and cannot serve.
 */
export const LANGUAGES: readonly RunnerLanguage[] = RunnerLanguage.options;

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
