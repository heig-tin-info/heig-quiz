import { defaultSeccompPath, loadConfig, type RunnerConfig } from "../config.js";

/** A configuration that needs no environment and no Podman. */
export function testConfig(overrides: Partial<RunnerConfig> = {}): RunnerConfig {
  const base = loadConfig({
    PODMAN_SOCKET: "/nonexistent/podman.sock",
    RUNNER_SECCOMP: defaultSeccompPath(),
    LOG_LEVEL: "fatal",
  });
  return { ...base, ...overrides };
}
