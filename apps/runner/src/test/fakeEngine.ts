import type {
  CreateOptions,
  Engine,
  EngineCapabilities,
  ExecOptions,
  ExecResult,
} from "../engine.js";

/**
 * An engine that starts no container.
 *
 * Every unit test of the runner runs against this: the queue, the truncation,
 * the timeout arithmetic and the mapping to a `RunnerOutcome` are ours, and
 * they are testable without Podman. What needs a real engine — the hardening
 * itself — is in `*.int.test.ts`.
 */

export interface FakeCall {
  container: string;
  argv: string[];
  stdin: string | Uint8Array;
  timeoutMs: number;
  maxBytes: number;
}

export type FakeHandler = (call: FakeCall) => Partial<ExecResult>;

export interface FakeEngine extends Engine {
  readonly calls: FakeCall[];
  readonly created: CreateOptions[];
  readonly removed: string[];
  /** One entry per `pruneOrphans()`: the reaping happens at boot, exactly once. */
  readonly pruned: number[];
  images: string[];
}

export const FAKE_CAPABILITIES: EngineCapabilities = {
  version: "podman version 0.0.0-fake",
  rootless: true,
  remote: true,
  usernsAuto: true,
  runtime: "crun",
  cgroupVersion: "v2",
};

export function createFakeEngine(handler: FakeHandler = () => ({})): FakeEngine {
  const calls: FakeCall[] = [];
  const created: CreateOptions[] = [];
  const removed: string[] = [];
  const pruned: number[] = [];
  const engine: FakeEngine = {
    capabilities: FAKE_CAPABILITIES,
    calls,
    created,
    removed,
    pruned,
    images: ["localhost/quiz-runner-c:latest", "quiz-runner-python:latest"],
    containerArgs: () => [],
    async create(options: CreateOptions) {
      created.push(options);
    },
    async exec(container: string, options: ExecOptions): Promise<ExecResult> {
      const call: FakeCall = { container, ...options };
      calls.push(call);
      const answer = handler(call);
      const stdout = answer.stdout ?? "";
      return {
        exitCode: 0,
        stderr: "",
        ms: 1,
        timedOut: false,
        truncated: false,
        containerGone: false,
        ...answer,
        stdout,
        // The raw bytes follow the text unless the handler gave bytes of its own.
        stdoutBytes: answer.stdoutBytes ?? Buffer.from(stdout),
      };
    },
    async remove(name: string) {
      removed.push(name);
    },
    async pruneOrphans() {
      pruned.push(Date.now());
      return 0;
    },
    async listImages() {
      return engine.images;
    },
  };
  return engine;
}
