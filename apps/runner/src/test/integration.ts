import { execFileSync } from "node:child_process";

import type { RunnerLanguage } from "@quiz/core/server";

import { detectSocket, loadConfig, type RunnerConfig } from "../config.js";
import { createEngine, remoteArgs, type Engine } from "../engine.js";
import { availableLanguages } from "../images.js";
import { probeEngine } from "../probe.js";

/**
 * The bootstrap the three `*.int.test.ts` files share.
 *
 * Each of them used to carry its own copy: detect the socket, load the
 * configuration, ask Podman for its images inside a `try`, warn on the
 * console, then build the engine in a `beforeAll`. Three copies of the rule
 * that decides whether a suite runs at all — and one of them was a fourth
 * place spelling out `--remote --url` by hand (invariant 13).
 *
 * The skip stays exactly what it was: a machine without a reachable Podman,
 * or without the image a suite needs, reports SKIPS and not failures, so
 * `pnpm test` on a laptop with no container engine passes (decision D14).
 */

export interface IntegrationHost {
  /** Podman answered. When false, every suite of the file skips itself. */
  readonly ok: boolean;
  /** The languages this engine has an image for. */
  readonly languages: readonly RunnerLanguage[];
  readonly config: RunnerConfig;
  has(language: RunnerLanguage): boolean;
}

let cached: IntegrationHost | null = null;

/**
 * What this host can run, asked once and SYNCHRONOUSLY: a file needs the
 * answer at collection time, for `describe.skipIf`.
 */
export function integrationHost(): IntegrationHost {
  if (cached !== null) return cached;
  const socket = detectSocket();
  const config = loadConfig({
    LOG_LEVEL: "fatal",
    ...(socket === null ? {} : { PODMAN_SOCKET: socket }),
  });
  try {
    const images = execFileSync(
      config.PODMAN_BIN,
      [...remoteArgs(config.PODMAN_SOCKET), "images", "--format", "{{.Repository}}:{{.Tag}}"],
      { encoding: "utf8", timeout: 20_000 },
    );
    const languages = availableLanguages(images.split("\n"), config);
    cached = { ok: true, languages, config, has: (language) => languages.includes(language) };
  } catch {
    cached = { ok: false, languages: [], config, has: () => false };
  }
  return cached;
}

/**
 * The one line a skipped suite owes the person who ran it.
 *
 * `language` names the image the suite needs; without it the suite needs any
 * of them.
 */
export function announce(
  host: IntegrationHost,
  suite: string,
  language?: RunnerLanguage,
): void {
  if (!host.ok) {
    console.warn(`[runner] Podman is not reachable: ${suite} is skipped.`);
    return;
  }
  if (language === undefined) {
    if (host.languages.length === 0) {
      console.warn("[runner] no quiz-runner-* image: run images/build.sh first.");
    }
  } else if (!host.has(language)) {
    console.warn(
      `[runner] no quiz-runner-${language} image: run images/build.sh ${language} first.`,
    );
  }
}

/** The real engine, built exactly as `buildApp` builds it. Call it in `beforeAll`. */
export async function integrationEngine(host: IntegrationHost): Promise<Engine> {
  const probed = await probeEngine(host.config);
  return createEngine({
    podmanBin: host.config.PODMAN_BIN,
    socket: host.config.PODMAN_SOCKET,
    seccompProfile: host.config.RUNNER_SECCOMP,
    usernsAuto: probed.capabilities.usernsAuto,
    runtime: probed.capabilities.runtime,
    capabilities: probed.capabilities,
  });
}
