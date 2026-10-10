/**
 * `pnpm dev` at the root starts the runner too — but only on a machine that
 * has a Podman socket. Everywhere else this prints one line and exits 0, so
 * the development loop of someone without a container engine is untouched
 * (decision D14: the API keeps working with RUNNER_MODE=stub).
 *
 * The socket detection is the same rule as src/config.ts, deliberately
 * duplicated in four lines rather than imported: this file must run before
 * anything is compiled.
 */
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const configured = process.env.PODMAN_SOCKET?.trim();
const candidates =
  configured !== undefined && configured !== ""
    ? [configured]
    : [`/run/user/${process.getuid?.() ?? 1000}/podman/podman.sock`, "/run/podman/podman.sock"];
const socket = candidates.find((path) => existsSync(path));

if (socket === undefined) {
  console.log(
    `[runner] no Podman socket (${candidates.join(", ")}) — skipped. ` +
      "The API keeps working with RUNNER_MODE=stub.",
  );
  process.exit(0);
}

// `.env` at the root belongs to the API, and its PORT and HOST are the API's
// (HOST=0.0.0.0 there). Node's `--env-file` never overrides a variable that
// is already set, so pinning both here is what keeps the runner on
// 127.0.0.1:3200 while the API keeps 0.0.0.0:3000. A public bind needs a
// RUNNER_TOKEN, or the runner refuses to start (config.ts, audit L13).
const port = process.env.RUNNER_PORT ?? "3200";
const host = process.env.RUNNER_HOST ?? "127.0.0.1";

console.log(`[runner] Podman socket ${socket} — starting on ${host}:${port}`);
const child = spawn("tsx", ["watch", "--env-file-if-exists=../../.env", "src/server.ts"], {
  stdio: "inherit",
  env: { ...process.env, PODMAN_SOCKET: socket, PORT: port, HOST: host },
});
child.on("exit", (code) => process.exit(code ?? 0));
