/**
 * Development persona picker (`AUTH_DEV_LOGIN=1`).
 *
 * The OIDC path is the real one and stays untouched: a dev Keycloak is a
 * real identity provider and that is what the production code must exercise.
 * But standing a Keycloak up needs a container engine, and a laptop without
 * one still has to be able to open the application. So: a server-rendered
 * page of personas, a POST per persona, and the SAME session the OIDC
 * callback opens — no second notion of "signed in".
 *
 * `config.ts` throws when this flag is set under NODE_ENV=production, and
 * `plugin.ts` only registers these routes when it is off.
 */
import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";

import { audit } from "../audit.js";
import type { AppConfig } from "../config.js";
import { users } from "../db/schema.js";
import { claimEnrollments } from "../modules/roster.js";
import { syncUserEmails } from "./claims.js";
import type { SessionUser } from "./plugin.js";

export interface Persona {
  key: string;
  givenName: string;
  familyName: string;
  email: string;
  role: "student" | "teacher" | "admin";
}

/** The demo cast. `pnpm seed` builds a course and a classroom around it. */
export const PERSONAS: Persona[] = [
  { key: "teacher", givenName: "Prof", familyName: "Démo", email: "teacher@heig-vd.ch", role: "teacher" },
  { key: "admin", givenName: "Admin", familyName: "Démo", email: "admin@heig-vd.ch", role: "admin" },
  { key: "lea", givenName: "Léa", familyName: "Rochat", email: "lea.rochat@heig-vd.ch", role: "student" },
  { key: "noah", givenName: "Noah", familyName: "Bovet", email: "noah.bovet@heig-vd.ch", role: "student" },
  { key: "emma", givenName: "Emma", familyName: "Favre", email: "emma.favre@heig-vd.ch", role: "student" },
  { key: "louis", givenName: "Louis", familyName: "Perrin", email: "louis.perrin@heig-vd.ch", role: "student" },
  { key: "chloe", givenName: "Chloé", familyName: "Monnier", email: "chloe.monnier@heig-vd.ch", role: "student" },
  { key: "gabriel", givenName: "Gabriel", familyName: "Dubois", email: "gabriel.dubois@heig-vd.ch", role: "student" },
];

/** Stable subject per persona, so re-running the seed keeps the same rows. */
export function devSub(persona: Persona): string {
  return `dev:${persona.key}`;
}

/**
 * Upserts the persona's account through the ordinary identity code path
 * (`users` + `user_emails` + roster claim), so a dev session is in every
 * respect an ordinary session.
 */
export async function upsertPersona(
  app: FastifyInstance,
  persona: Persona,
): Promise<SessionUser> {
  const now = new Date();
  const [row] = await app.db
    .insert(users)
    .values({
      id: randomUUID(),
      oidcSub: devSub(persona),
      email: persona.email,
      emailVerified: true,
      givenName: persona.givenName,
      familyName: persona.familyName,
      role: persona.role,
      lastLoginAt: now,
    })
    .onConflictDoUpdate({
      target: users.oidcSub,
      set: {
        email: persona.email,
        givenName: persona.givenName,
        familyName: persona.familyName,
        // The persona IS the role here: a demo teacher must not be demoted
        // to student by the absence of a grant.
        role: persona.role,
        lastLoginAt: now,
      },
    })
    .returning();
  if (!row) throw new Error("Persona upsert returned no row");
  await syncUserEmails(app.db, row.id, { email: persona.email }, true);
  await claimEnrollments(app.db, { id: row.id });
  const [fresh] = await app.db.select().from(users).where(eq(users.id, row.id)).limit(1);
  return fresh ?? row;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

function page(): string {
  const card = (p: Persona) => `
    <form method="post" action="/app/auth/dev">
      <input type="hidden" name="persona" value="${escapeHtml(p.key)}" />
      <button type="submit">
        <span class="name">${escapeHtml(`${p.givenName} ${p.familyName}`)}</span>
        <span class="mail">${escapeHtml(p.email)}</span>
        <span class="role role-${escapeHtml(p.role)}">${escapeHtml(p.role)}</span>
      </button>
    </form>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Quiz — development login</title>
<style>
  :root { color-scheme: light dark; --line:#e5e3df; --fg:#1b1a19; --muted:#6b6763; --accent:#d2262c; --surface:#fff; --canvas:#faf9f7; }
  @media (prefers-color-scheme: dark) { :root { --line:#2e2c2a; --fg:#f2f0ed; --muted:#a29d98; --surface:#1b1a19; --canvas:#121110; } }
  body { margin:0; min-height:100dvh; display:flex; align-items:center; justify-content:center; padding:2rem;
         background:var(--canvas); color:var(--fg); font:16px/1.5 system-ui, sans-serif; }
  main { width:100%; max-width:34rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; letter-spacing:-.02em; }
  p.sub { margin:0 0 1.5rem; color:var(--muted); font-size:.9rem; }
  .list { display:grid; gap:.5rem; }
  form { margin:0; }
  button { width:100%; display:flex; align-items:center; gap:.75rem; text-align:left; cursor:pointer;
           background:var(--surface); color:inherit; border:1px solid var(--line); border-radius:12px;
           padding:.75rem 1rem; font:inherit; }
  button:hover { border-color:var(--accent); }
  .name { font-weight:600; }
  .mail { color:var(--muted); font-size:.85rem; flex:1; }
  .role { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; border:1px solid var(--line);
          border-radius:999px; padding:.1rem .5rem; color:var(--muted); }
  .role-teacher, .role-admin { color:var(--accent); border-color:var(--accent); }
  footer { margin-top:1.5rem; font-size:.8rem; color:var(--muted); }
  a { color:var(--accent); }
</style></head>
<body><main>
  <h1>Development login</h1>
  <p class="sub">Pick a persona. This page does not exist in production.</p>
  <div class="list">${PERSONAS.map(card).join("")}</div>
  <footer>The real path is <a href="/app/auth/login">OIDC sign-in</a>.</footer>
</main></body></html>`;
}

export async function devLoginRoutes(app: FastifyInstance, _config: AppConfig) {
  app.get("/app/auth/dev", async (_req, reply) => reply.type("text/html; charset=utf-8").send(page()));

  app.post("/app/auth/dev", async (req, reply) => {
    const body = (req.body ?? {}) as { persona?: unknown };
    const key = typeof body.persona === "string" ? body.persona : "";
    const persona = PERSONAS.find((p) => p.key === key);
    if (!persona) return reply.code(400).send({ error: "unknown_persona" });
    const user = await upsertPersona(app, persona);
    await app.openSession(reply, user);
    await audit(app.db, {
      actorUserId: user.id,
      actorType: "user",
      action: "auth.dev_login",
      subjectType: "user",
      subjectId: user.id,
      payload: { persona: persona.key },
    });
    return reply.redirect("/", 302);
  });
}
