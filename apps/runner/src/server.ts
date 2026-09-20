import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const app = await buildApp({ config });

await app.listen({ host: config.HOST, port: config.PORT });
app.log.info(
  { concurrency: config.RUNNER_CONCURRENCY, queueMax: config.RUNNER_QUEUE_MAX },
  "quiz-runner started",
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, "shutting down");
    void app.close().then(() => process.exit(0));
  });
}
