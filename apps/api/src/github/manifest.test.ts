/**
 * The App's manifest (M2-06) cannot drift: its events are exactly those the
 * modules register a handler for, its permissions and events are the rows
 * of docs/development/github-app.md, and the environment lines it writes
 * boot a production configuration.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";
import { ALWAYS_DELIVERED, APP_EVENTS, APP_PERMISSIONS, appManifest, envLines } from "./manifest.js";
import { appKey } from "./testing.js";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const DOC = readFileSync(new URL("../../../../docs/development/github-app.md", import.meta.url), "utf8");

/** Every `onEvent("<event>", …)` of the API's sources: whatever module registers it. */
function registeredEvents(): Set<string> {
  const events = new Set<string>();
  for (const entry of readdirSync(SRC, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const source = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const m of source.matchAll(/\bonEvent\(\s*"([a-z_]+)"/g)) events.add(m[1]!);
  }
  return events;
}

describe("the App's manifest", () => {
  const key = appKey();
  afterAll(() => key.remove());

  it("subscribes to exactly the events a handler is registered for", () => {
    const handled = registeredEvents();
    expect(handled.size).toBeGreaterThan(0);
    expect([...handled].sort()).toEqual([...Object.keys(APP_EVENTS), ...Object.keys(ALWAYS_DELIVERED)].sort());
  });

  it("is the documented one: every permission with its access, every event", () => {
    for (const [name, p] of Object.entries(APP_PERMISSIONS)) {
      expect(DOC, name).toMatch(new RegExp(`^\\| \`${name}\` \\| ${p.on} \\| ${p.access} \\|`, "m"));
    }
    for (const event of [...Object.keys(APP_EVENTS), ...Object.keys(ALWAYS_DELIVERED)]) {
      expect(DOC, event).toMatch(new RegExp(`^\\| \`${event}\` \\|`, "m"));
    }
    // And nothing the manifest does not ask for.
    const rows = [...DOC.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(rows.sort()).toEqual(
      [...Object.keys(APP_PERMISSIONS), ...Object.keys(APP_EVENTS), ...Object.keys(ALWAYS_DELIVERED)].sort(),
    );
  });

  it("points GitHub at the environment's routes", () => {
    const manifest = appManifest({
      url: "https://quiz.dev.chevallier.io",
      name: "heig-quiz-staging",
      public: false,
      redirectUrl: "http://127.0.0.1:4000/created",
    });
    expect(manifest).toMatchObject({
      hook_attributes: { url: "https://quiz.dev.chevallier.io/webhooks/github", active: true },
      callback_urls: ["https://quiz.dev.chevallier.io/app/auth/github/callback"],
      setup_url: "https://quiz.dev.chevallier.io/setup/github/installed",
      setup_on_update: true,
      request_oauth_on_install: false,
      public: false,
      redirect_url: "http://127.0.0.1:4000/created",
    });
    expect(manifest.default_permissions).toMatchObject({ administration: "write", metadata: "read", organization_secrets: "read" });
    expect(manifest.default_events).not.toContain("installation");
  });

  it("writes the GITHUB_* lines a production configuration boots with", () => {
    const lines = envLines(
      { id: 123456, slug: "heig-quiz-staging", client_id: "Iv23li", client_secret: "c".repeat(40), webhook_secret: null },
      key.pem,
      "w".repeat(64),
    );
    const config = loadConfig({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://quiz:secret@db:5432/quiz",
      OIDC_CLIENT_SECRET: "a-real-secret",
      COOKIE_SECRET: "a-real-cookie-secret-of-the-right-length",
      ...lines,
    });
    expect(config).toMatchObject({ GITHUB_APP_ID: "123456", GITHUB_APP_SLUG: "heig-quiz-staging" });
  });
});
