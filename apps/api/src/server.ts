import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";
import { MIGRATIONS_DIR } from "./paths.js";

const config = loadConfig();

// Migrations applied at startup (ADR-009), for both drivers. Drizzle
// serializes them with a database lock, safe even with concurrent startups.
if (config.MIGRATE_ON_START) {
  const handle = createDb(config.DATABASE_URL);
  await handle.migrate(MIGRATIONS_DIR);
  await handle.close();
}

const app = await buildApp({ config });

// ADR-001: in `worker` mode the process does not listen; it only runs the
// job queue and the ticker.
if (config.WORKER_MODE !== "worker") {
  await app.listen({ host: config.HOST, port: config.PORT });
}

app.log.info({ workerMode: config.WORKER_MODE }, "quiz-api started");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
