/**
 * Registers one of Quiz's GitHub Apps from its manifest (merge task M2-06,
 * docs/development/github-app.md), through GitHub's App Manifest flow:
 *
 *   pnpm github:app --url https://quiz.dev.chevallier.io --name heig-quiz-staging \
 *     --org <test organization> --key-out ~/heig-quiz-staging.pem --env-out ~/heig-quiz-staging.env
 *
 * It serves a one-shot page on 127.0.0.1 that posts the manifest
 * (`src/github/manifest.ts`) to GitHub; the operator, signed in to GitHub as
 * an owner of the organization (`--personal`: their own account), confirms
 * the name; GitHub redirects back to 127.0.0.1 with a code, exchanged here
 * for the App's id, slug, OAuth client, webhook secret and private key.
 *
 * Invariant 15 and ADR-010: the secrets never land in a repository and are
 * never logged. The private key goes to `--key-out` (mode 0600, a new file
 * outside any git working tree), never to the terminal; the `GITHUB_*` lines
 * go to `--env-out` (the same rules), or to stdout with `--env-out -`. What
 * is printed otherwise is public: the id, the slug, the links.
 *
 * Exit status: 0 created; 1 refused or failed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { Octokit } from "octokit";

import { GITHUB_WEBHOOK_SECRET_MIN } from "../src/config.js";
import { appManifest, envLines } from "../src/github/manifest.js";
import { escapeHtml } from "../src/modules/notifications/templates.js";

const USAGE =
  "usage: github-app --url <https://host> --name <App name> (--org <login> | --personal) " +
  "--key-out <file> --env-out <file | -> [--public] [--port <n>]";
/** The code GitHub hands back is valid for an hour; the page waits less. */
const WAIT_MS = 15 * 60_000;

/** Inside a git working tree (a `.git` directory or file above it, links followed): a secret must never land there. */
export function insideGitTree(path: string): boolean {
  for (let dir = realpathSync(dirname(resolve(path))); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (dirname(dir) === dir) return false;
  }
}

/** A secret's destination: absolute, new, outside any repository. Relative paths are the caller's (pnpm runs us in apps/api). */
function secretPath(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} is required\n${USAGE}`);
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), value);
  if (existsSync(path)) throw new Error(`${flag}: ${path} exists; refusing to overwrite it`);
  if (!existsSync(dirname(path))) throw new Error(`${flag}: no directory ${dirname(path)}`);
  if (insideGitTree(path)) throw new Error(`${flag}: ${path} is inside a git working tree; secrets stay out of repositories (ADR-010)`);
  return path;
}

function options() {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      name: { type: "string" },
      org: { type: "string" },
      personal: { type: "boolean" },
      public: { type: "boolean" },
      "key-out": { type: "string" },
      "env-out": { type: "string" },
      port: { type: "string" },
    },
  });
  const url = new URL(values.url ?? "invalid:");
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search !== "") {
    throw new Error(`--url must be an https origin, such as https://quiz.dev.chevallier.io\n${USAGE}`);
  }
  const name = values.name?.trim() ?? "";
  if (name === "") throw new Error(`--name is required\n${USAGE}`);
  if (Boolean(values.org) === Boolean(values.personal)) throw new Error(`one of --org <login> or --personal\n${USAGE}`);
  if (values.org && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(values.org)) throw new Error("--org: not a GitHub login");
  const envOut = values["env-out"] === "-" ? "-" : secretPath("--env-out", values["env-out"]);
  return {
    origin: url.origin,
    name,
    org: values.org,
    public: values.public ?? false,
    keyOut: secretPath("--key-out", values["key-out"]),
    envOut,
    port: Number(values.port ?? 0),
  };
}

const page = (body: string) =>
  `<!doctype html><meta charset="utf-8"><title>Quiz GitHub App</title><body style="font-family:sans-serif;max-width:40em;margin:3em auto">${body}</body>`;

/**
 * GitHub's generated webhook secret, checked against config.ts: a shorter
 * one would make the process refuse to start. Never printed, only its length.
 */
function checkWebhookSecret(secret: string | null): void {
  const length = secret?.length ?? 0;
  if (length >= GITHUB_WEBHOOK_SECRET_MIN) {
    console.log(`webhook secret: ${length} characters (config.ts asks for at least ${GITHUB_WEBHOOK_SECRET_MIN})`);
    return;
  }
  console.error(
    `webhook secret: GitHub's has ${length} characters, under the ${GITHUB_WEBHOOK_SECRET_MIN} config.ts asks for: ` +
      "set a new one on the App (openssl rand -hex 32) and in GITHUB_WEBHOOK_SECRET (docs/development/github-app.md)",
  );
}

async function main() {
  const opts = options();
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise<void>((done) => server.listen(opts.port, "127.0.0.1", done));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const manifest = appManifest({ url: opts.origin, name: opts.name, public: opts.public, redirectUrl: `${local}/created` });
  const action = opts.org
    ? `https://github.com/organizations/${opts.org}/settings/apps/new?state=${state}`
    : `https://github.com/settings/apps/new?state=${state}`;

  const created = new Promise<string>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("no answer from GitHub within 15 minutes")), WAIT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", local);
      res.setHeader("content-type", "text/html; charset=utf-8");
      // Only this machine's browser, by this address: no page rebinding a name onto it.
      if (req.headers.host !== new URL(local).host) {
        res.statusCode = 421;
        res.end(page("<p>Open the address the terminal printed.</p>"));
        return;
      }
      if (url.pathname === "/") {
        res.end(
          page(
            `<p>Sending the manifest of <b>${escapeHtml(opts.name)}</b> to GitHub…</p>` +
              `<form id="m" method="post" action="${escapeHtml(action)}">` +
              `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
              `<button>Continue to GitHub</button></form><script>document.getElementById("m").submit()</script>`,
          ),
        );
        return;
      }
      const code = url.searchParams.get("code");
      if (url.pathname !== "/created" || url.searchParams.get("state") !== state || !code) {
        res.statusCode = 404;
        res.end(page("<p>Not this page.</p>"));
        return;
      }
      res.end(page("<p>GitHub created the App. Back to the terminal; this tab can be closed.</p>"));
      clearTimeout(timer);
      done(code);
    });
  });

  console.log(`Open ${local}/ in a browser signed in to GitHub as ${opts.org ? `an owner of ${opts.org}` : "yourself"}.`);
  try {
    const code = await created;
    const { data: app } = await new Octokit().request("POST /app-manifests/{code}/conversions", { code });
    // The App asked for, not another one a code was obtained for.
    const owner = app.owner && "login" in app.owner ? app.owner.login : "";
    if (opts.org && owner.toLowerCase() !== opts.org.toLowerCase()) {
      throw new Error(`GitHub created an App owned by '${owner}', not ${opts.org}: nothing written`);
    }
    // The key first: whatever fails next, it is not lost (GitHub shows it once).
    writeFileSync(opts.keyOut, app.pem, { mode: 0o600, flag: "wx" });
    checkWebhookSecret(app.webhook_secret);
    const serverKey = `secrets/${app.slug}.private-key.pem`;
    const lines = Object.entries(envLines(app, serverKey))
      .map(([key, value]) => `${key}=${value}\n`)
      .join("");
    if (opts.envOut === "-") process.stdout.write(lines);
    else writeFileSync(opts.envOut, lines, { mode: 0o600, flag: "wx" });
    console.log(
      [
        `created ${app.slug} (App id ${app.id}): ${app.html_url}`,
        `private key: ${opts.keyOut} (0600); on the server: ${serverKey}`,
        opts.envOut === "-" ? "GITHUB_* lines: above" : `GITHUB_* lines: ${opts.envOut} (0600)`,
        `install it: https://github.com/apps/${app.slug}/installations/new`,
      ].join("\n"),
    );
  } finally {
    server.close();
  }
}

// Run, not imported (the test imports `insideGitTree`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`github-app: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
