// Rewrites the scene table of docs/development/screenshots.md from
// docs/assets/screenshots/manifest.json, between the two marker comments.
// Called by docs-screenshots.mjs at the end of a run; runnable alone:
//
//   node apps/web/scripts/docs-screenshots-index.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..", "..");
const MANIFEST = path.join(ROOT, "docs", "assets", "screenshots", "manifest.json");
const PAGE = path.join(ROOT, "docs", "development", "screenshots.md");
const START = "<!-- scenes:start -->";
const END = "<!-- scenes:end -->";

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

export function renderSceneTable(manifest) {
  const rows = manifest.scenes.map((s) => {
    const size = `${s.width}×${s.height}${s.fullPage ? ", full page" : ""}`;
    return `| \`${s.name}\` | ${cell(s.persona)} | \`${cell(s.path)}\` | ${cell(s.phase)} | ${cell(s.action)} | ${size} |`;
  });
  const taken = manifest.scenes[0]
    ? `Last full run: ${manifest.scenes[0].takenAt.slice(0, 10)}, commit \`${manifest.scenes[0].commit}\`, ${manifest.scenes.length} scenes.`
    : "No scene yet.";
  return [
    taken,
    "",
    "| Scene | Persona | Path | Phase | Action after load | Viewport |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export function writeSceneTable() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const page = fs.readFileSync(PAGE, "utf8");
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < 0 || b < a) throw new Error(`${PAGE}: markers ${START} / ${END} not found`);
  const next = `${page.slice(0, a + START.length)}\n${renderSceneTable(manifest)}\n${page.slice(b)}`;
  if (next !== page) fs.writeFileSync(PAGE, next);
  return manifest.scenes.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`${writeSceneTable()} scene(s) written to ${path.relative(ROOT, PAGE)}`);
}
