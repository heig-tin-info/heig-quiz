// Renders the PNG icons of the web app manifest and of iOS from
// public/favicon.svg. A development tool: run it after changing the mark,
// commit the PNGs it writes. Never imported by the app, never runs in CI.
//
//   node apps/web/scripts/icons.mjs
//
// Every icon is the red Q bubble on an opaque square: iOS rounds the corners
// of apple-touch-icon itself and fills transparency with black, and Android
// crops a `maskable` icon to its own shape, so the mark stays inside the
// central safe zone (a circle of 80% of the side) and nothing important
// touches an edge.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "public");
const mark = fs.readFileSync(path.join(publicDir, "favicon.svg"), "utf8");

/** The light `--canvas` of src/style.css: the icon sits on the app's own paper. */
const BACKGROUND = "#f6f5f2";
/** Share of the side the mark occupies; 0.6 keeps it inside the safe zone. */
const MARK_RATIO = 0.6;

const ICONS = [
  { file: "apple-touch-icon.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { file, size } of ICONS) {
    const inner = Math.round(size * MARK_RATIO);
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${BACKGROUND}">` +
        `<div style="width:${inner}px;height:${inner}px">${mark.replace(
          "<svg ",
          '<svg width="100%" height="100%" ',
        )}</div></body>`,
    );
    await page.screenshot({ path: path.join(publicDir, file), omitBackground: false });
    console.log(`wrote public/${file} (${size}×${size})`);
  }
} finally {
  await browser.close();
}
