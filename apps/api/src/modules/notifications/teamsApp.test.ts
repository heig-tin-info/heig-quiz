/**
 * The Teams app package (ADR-030): a zip holding a manifest that declares
 * our bot and its two icons, the same bytes on every build, and nothing read
 * from disk to make it.
 */
import * as fs from "node:fs";

import { unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";

import { TEAMS_APP_VERSION, teamsAppPackage } from "./teamsApp.js";

vi.mock("node:fs", { spy: true });

/** Width and height of a PNG, from its IHDR. */
function pngSize(png: Uint8Array): [number, number] {
  const buf = Buffer.from(png);
  expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

const OPTS = { appId: "5f0c0a2e-0000-4000-8000-000000000001", publicUrl: "https://quiz.chevallier.io/" };

describe("the Teams app package", () => {
  it("holds a manifest for our bot, in the personal scope, and its two icons", () => {
    const files = unzipSync(teamsAppPackage(OPTS));
    expect(Object.keys(files)).toEqual(["manifest.json", "color.png", "outline.png"]);
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]!).toString("utf8"));
    expect(manifest).toMatchObject({
      manifestVersion: "1.17",
      version: TEAMS_APP_VERSION,
      id: OPTS.appId,
      developer: { name: "HEIG-VD", websiteUrl: "https://quiz.chevallier.io" },
      name: { short: "HEIG Quiz" },
      icons: { color: "color.png", outline: "outline.png" },
      bots: [{ botId: OPTS.appId, scopes: ["personal"], supportsFiles: false, isNotificationOnly: false }],
      validDomains: ["quiz.chevallier.io"],
    });
    expect(manifest.$schema).toContain("/v1.17/MicrosoftTeams.schema.json");
    expect(manifest.name.short.length).toBeLessThanOrEqual(30);
    expect(manifest.description.short.length).toBeLessThanOrEqual(80);
    expect(manifest.description.full.length).toBeLessThanOrEqual(4000);
    expect(manifest.accentColor).toMatch(/^#[0-9A-F]{6}$/i);
    expect(pngSize(files["color.png"]!)).toEqual([192, 192]);
    expect(pngSize(files["outline.png"]!)).toEqual([32, 32]);
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
