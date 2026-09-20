import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  // `drizzle-kit generate` only reads the schema; the credentials matter to
  // `drizzle-kit migrate`, which is the real-Postgres path (the embedded
  // development database migrates itself at startup, see db/client.ts).
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://quiz:quiz@localhost:5432/quiz",
  },
});
