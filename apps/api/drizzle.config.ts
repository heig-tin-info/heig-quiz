import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // `drizzle-kit generate` only reads the schema; the credentials matter to
  // `drizzle-kit migrate`, which is the real-Postgres path (the embedded
  // development database migrates itself at startup, see db/client.ts).
  //
  // No default URL (D-22): a `migrate` run without DATABASE_URL must stop
  // with `[x] url: undefined` rather than silently migrate whatever listens
  // on localhost:5432. The cast is what lets `generate`, which never opens a
  // connection, keep working without one.
  dbCredentials: {
    url: process.env.DATABASE_URL as string,
  },
});
