/**
 * The Web Worker the student's program actually runs in.
 *
 * A thin shim, deliberately: everything it does lives in `engine.ts`, which
 * holds no worker global and is therefore testable outside a browser. The
 * worker exists for ONE reason — a WebAssembly instance cannot be interrupted,
 * so the only stop button is `terminate()` on the thread it runs on, and that
 * thread must not be the one drawing the page.
 */
/// <reference lib="webworker" />
import { runJob } from "./engine";
import type { RunnoJob, WorkerMessage } from "./protocol";

const post = (message: WorkerMessage) => {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(message);
};

self.onmessage = (event: MessageEvent<RunnoJob>) => {
  void runJob(event.data, { emit: post }).catch((error: unknown) => {
    post({ type: "fatal", message: error instanceof Error ? error.message : String(error) });
  });
};
