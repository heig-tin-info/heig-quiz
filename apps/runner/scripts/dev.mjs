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

// `.env` at the root belongs to the API, and its PORT is the API's. Node's
// `--env-file` never overrides a variable that is already set, so pinning it
// here is what keeps the runner on 3200 while the API keeps 3000.
const port = process.env.RUNNER_PORT ?? "3200";

console.log(`[runner] Podman socket ${socket} — starting on :${port}`);
const child = spawn("tsx", ["watch", "--env-file-if-exists=../../.env", "src/server.ts"], {
  stdio: "inherit",
  env: { ...process.env, PODMAN_SOCKET: socket, PORT: port },
});
child.on("exit", (code) => process.exit(code ?? 0));
