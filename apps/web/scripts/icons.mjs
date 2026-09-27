// Renders the PNG icons of the web app manifest and of iOS from
// public/favicon.svg. A development tool: run it after changing the mark,
// commit the PNGs it writes. Never imported by the app, never runs in CI.
//
//   node apps/web/scripts/icons.mjs
//
// Every icon is the Q bubble inverted, a white bubble and a red Q on a red
// square: one tile that holds on a light and on a dark home screen alike
// (issue #149), where the red bubble on the paper canvas vanished into a
// light wallpaper. The tab keeps favicon.svg as it is, red on transparent.
//
// The square is opaque: iOS rounds the corners
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
/** The red of the logo (apps/web/src/assets/quiz.svg), not the reading-weight `--accent`. */
const RED = "#D60008";
const WHITE = "#FFFFFF";

/** favicon.svg with its two fills swapped: the bubble white, the Q red. */
const mark = fs
  .readFileSync(path.join(publicDir, "favicon.svg"), "utf8")
  .replace(/fill="(#D60008|#FFFFFF)"/gi, (_, fill) =>
    fill.toUpperCase() === RED ? `fill="${WHITE}"` : `fill="${RED}"`,
  );

const BACKGROUND = RED;
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
