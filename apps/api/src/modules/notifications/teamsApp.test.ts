/**
 * The Teams app package (ADR-030): a zip holding a manifest that declares
 * the tab, the activity types and the resource-specific permission, its
 * French localization and its two icons — the same bytes on every build,
 * and nothing read from disk to make it.
 */
import * as fs from "node:fs";

import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { kindChannels, NOTIFICATION_KINDS } from "@quiz/contracts";

import {
  TEAMS_ACTIVITY_KINDS,
  TEAMS_ACTIVITY_TYPES,
  TEAMS_APP_VERSION,
  teamsActivity,
  teamsAppPackage,
  teamsAppStrings,
  teamsTabDeepLink,
  type TeamsPayload,
} from "./teamsApp.js";
import { placeholders, renderNotification, serverText } from "./templates.js";

vi.mock("node:fs", { spy: true });

/** Width and height of a PNG, from its IHDR. */
function pngSize(png: Uint8Array): [number, number] {
  const buf = Buffer.from(png);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const APP_ID = "31583357-0d89-48ab-8eeb-e9bc49f9e243";
const OPTS = { appId: APP_ID, publicUrl: "https://quiz.chevallier.io" };
const POOL = "11111111-1111-4111-8111-111111111111";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const CLASSROOM = "44444444-4444-4444-8444-444444444444";
const PROJECT = "55555555-5555-4555-8555-555555555555";

const PAYLOADS: TeamsPayload[] = [
  {
    kind: "results_released",
    evaluationId: "22222222-2222-4222-8222-222222222222",
    evaluationTitle: "Test 0 — bases du C",
    attemptId: ATTEMPT,
  },
  { kind: "pool_shared", poolId: POOL, poolName: "Programmation C", role: "reader", byName: "Ada Lovelace" },
  { kind: "pool_ownership", poolId: POOL, poolName: "Électronique", fromName: "Grace Hopper" },
  { kind: "student_joined", classroomId: CLASSROOM, classroomName: "PRG1-2026", count: 3 },
  { kind: "roster_conflict", classroomId: CLASSROOM, classroomName: "PRG1-2026", count: 1 },
  { kind: "project_deadline_reminder", projectId: PROJECT, projectTitle: "Lab 1" },
  { kind: "project_provision_failed", projectId: PROJECT, projectTitle: "Lab 1", count: 2, reason: "repo_name_taken" },
  { kind: "github_org_lost", classroomId: CLASSROOM, classroomName: "PRG1-2026", orgLogin: "heig-prg1" },
];

function unpack() {
  const files = unzipSync(teamsAppPackage(OPTS));
  const read = (name: string) => JSON.parse(Buffer.from(files[name]!).toString("utf8")) as Record<string, any>;
  return { files, manifest: read("manifest.json"), fr: read("fr.json") };
}

describe("the Teams app package", () => {
  it("holds a manifest for a personal tab and activity feed notifications, and no bot", () => {
    const { files, manifest } = unpack();
    expect(Object.keys(files)).toEqual(["manifest.json", "fr.json", "color.png", "outline.png"]);
    expect(manifest).toMatchObject({
      manifestVersion: "1.17",
      version: TEAMS_APP_VERSION,
      id: APP_ID,
      developer: { name: "HEIG-VD", websiteUrl: "https://quiz.chevallier.io" },
      name: { short: "HEIG Quiz" },
      icons: { color: "color.png", outline: "outline.png" },
      staticTabs: [
        {
          entityId: "home",
          contentUrl: "https://quiz.chevallier.io/teams",
          websiteUrl: "https://quiz.chevallier.io",
          scopes: ["personal"],
        },
      ],
      validDomains: ["quiz.chevallier.io"],
      webApplicationInfo: { id: APP_ID, resource: `api://quiz.chevallier.io/${APP_ID}` },
      authorization: {
        permissions: { resourceSpecific: [{ type: "Application", name: "TeamsActivity.Send.User" }] },
      },
      localizationInfo: { defaultLanguageTag: "en", additionalLanguages: [{ languageTag: "fr", file: "fr.json" }] },
    });
    expect(manifest.bots).toBeUndefined();
    expect(manifest.$schema).toContain("/v1.17/MicrosoftTeams.schema.json");
    expect(manifest.name.short.length).toBeLessThanOrEqual(30);
    expect(manifest.name.full.length).toBeLessThanOrEqual(100);
    expect(manifest.description.short.length).toBeLessThanOrEqual(80);
    expect(manifest.description.full.length).toBeLessThanOrEqual(4000);
    expect(manifest.accentColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(pngSize(files["color.png"]!)).toEqual([192, 192]);
    expect(pngSize(files["outline.png"]!)).toEqual([32, 32]);
  });

  it("declares an activity type for every kind of the catalogue, and the ones to come (ADR-030 §f)", () => {
    const { manifest } = unpack();
    const types = manifest.activities.activityTypes as { type: string; description: string; templateText: string }[];
    expect(types.map((a) => a.type)).toEqual(TEAMS_ACTIVITY_KINDS.map((k) => TEAMS_ACTIVITY_TYPES[k]));
    // The list runs ahead of the catalogue, never behind it — for every kind
    // Teams may carry (`KIND_CHANNELS` keeps `system_alert` out of it).
    for (const kind of NOTIFICATION_KINDS) {
      if (kindChannels(kind).includes("teams")) expect(TEAMS_ACTIVITY_KINDS, kind).toContain(kind);
      else expect(TEAMS_ACTIVITY_KINDS, kind).not.toContain(kind);
    }
    // The one bump of #198 step 4: every kind of steps 4 to 8 is declared.
    expect(TEAMS_ACTIVITY_KINDS).toEqual(
      expect.arrayContaining([
        "student_joined",
        "roster_conflict",
        "grading_ready",
        "pool_question_added",
        "activity_scheduled",
        "activity_available",
        "deadline_approaching",
        "results_updated",
      ]),
    );
    // The one bump of M3-09b: the seven project kinds of F-NOTIF-13, at 2.2.0.
    expect(TEAMS_ACTIVITY_KINDS).toEqual(
      expect.arrayContaining([
        "project_published",
        "project_deadline_reminder",
        "project_repo_invited",
        "project_grade_final",
        "project_deadline_applied",
        "project_provision_failed",
        "github_org_lost",
      ]),
    );
    expect(TEAMS_APP_VERSION).toBe("2.2.0");
    // Semver, as Teams wants it; the value itself is bumped by hand.
    expect(TEAMS_APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(new Set(types.map((a) => a.type)).size).toBe(types.length);
    for (const a of types) {
      expect(a.type).toMatch(/^[a-z][A-Za-z]+$/);
      expect(a.description.length).toBeLessThanOrEqual(128);
      expect(a.templateText.length).toBeLessThanOrEqual(128);
    }
  });

  it("localizes every string of the manifest in fr.json, under the same keys", () => {
    const { manifest, fr } = unpack();
    const { $schema, ...strings } = fr;
    expect($schema).toContain("/v1.17/MicrosoftTeams.Localization.schema.json");
    expect(Object.keys(strings)).toEqual(Object.keys(teamsAppStrings("en")));
    for (const key of ["name.short", "name.full", "description.short", "description.full"]) {
      expect(strings[key], key).toBeTruthy();
    }
    // Each key names a string of the manifest, and the manifest holds the English one.
    const en = teamsAppStrings("en");
    const at = (path: string) =>
      path.split(/\.|\[(\d+)\]/).filter(Boolean).reduce<any>((node, part) => node?.[part], manifest);
    for (const [key, value] of Object.entries(en)) expect(at(key), key).toBe(value);
    expect(strings["staticTabs[0].name"]).toBe("Accueil");
    for (const [key, value] of Object.entries(strings)) {
      if (key.startsWith("activities.")) expect((value as string).length, key).toBeLessThanOrEqual(128);
    }
    expect((strings["description.short"] as string).length).toBeLessThanOrEqual(80);
  });

  it("uses the same template parameters in both languages", () => {
    for (const kind of TEAMS_ACTIVITY_KINDS) {
      const key = `activity.${kind}.template` as const;
      expect(placeholders(serverText("fr")[key]).sort(), kind).toEqual(placeholders(serverText("en")[key]).sort());
    }
  });

  it("is the same bytes on every build", () => {
    expect(teamsAppPackage(OPTS).equals(teamsAppPackage(OPTS))).toBe(true);
  });

  it("reads no file: a volume mounted over the image cannot hide its icons", () => {
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.existsSync).mockClear();
    teamsAppPackage(OPTS);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(fs.existsSync).not.toHaveBeenCalled();
  });
});

describe("an activity of the app", () => {
  it("fills every placeholder of its type's template, in both languages", () => {
    for (const payload of PAYLOADS) {
      const activity = teamsActivity(APP_ID, payload, renderNotification(payload, "fr", "https://quiz.test"));
      expect(activity.activityType).toBe(TEAMS_ACTIVITY_TYPES[payload.kind]);
      for (const locale of ["en", "fr"] as const) {
        const template = serverText(locale)[`activity.${payload.kind}.template`];
        expect(Object.keys(activity.templateParameters).sort()).toEqual(placeholders(template).sort());
      }
      for (const value of Object.values(activity.templateParameters)) expect(value).not.toBe("");
      expect(activity.previewText.length).toBeLessThanOrEqual(150);
      expect(activity.topic.length).toBeGreaterThan(0);
    }
  });

  it("previews the sentence of the recipient's language, cut to what Teams shows", () => {
    const [released] = PAYLOADS;
    const fr = teamsActivity(APP_ID, released!, renderNotification(released!, "fr", "https://quiz.test"));
    expect(fr.previewText).toBe("Les résultats de « Test 0 — bases du C » sont disponibles.");
    expect(fr.topic).toBe("Test 0 — bases du C");
    const long = { ...released!, evaluationTitle: "x".repeat(400) } as TeamsPayload;
    const cut = teamsActivity(APP_ID, long, renderNotification(long, "en", "https://quiz.test"));
    expect(cut.previewText).toHaveLength(150);
    expect(cut.previewText.endsWith("…")).toBe(true);
    expect(cut.topic).toHaveLength(150);
  });

  it("links to the tab, carrying the path the bell opens", () => {
    const [released, shared] = PAYLOADS;
    for (const [payload, path] of [
      [released!, `/attempts/${ATTEMPT}/feedback`],
      [shared!, `/pools/${POOL}`],
    ] as const) {
      const url = new URL(teamsTabDeepLink(APP_ID, payload));
      expect(url.origin).toBe("https://teams.microsoft.com");
      expect(url.pathname).toBe(`/l/entity/${APP_ID}/home`);
      const context = JSON.parse(url.searchParams.get("context")!) as { subEntityId: string };
      expect(context.subEntityId).toBe(path);
    }
  });
});
