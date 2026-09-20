/** The runner every unit test gets: the one that refuses (decision D14). */
import { RunnerUnavailable, type RunnerHealth, type RunnerService } from "@quiz/core/server";

export class UnavailableRunnerStub implements RunnerService {
  run(): Promise<never> {
    return Promise.reject(new RunnerUnavailable("not_configured"));
  }
  health(): Promise<RunnerHealth> {
    return Promise.resolve({
      ok: false,
      languages: [],
      queued: 0,
      avgMs: null,
      reason: "not_configured",
    });
  }
}
