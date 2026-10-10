import "./festive.css";

import type { FestiveId } from "./calendar";

/**
 * The drawings of the festive touches (ADR-092), a chunk of its own: fetched
 * on a festive day only, so an ordinary day costs nothing but the calendar.
 *
 * An accessory is an SVG fragment in the logo's user units (viewBox
 * 227.2 × 60.1), slipped into one bubble's group so it dances with it.
 * Like the logo's, its colours are a drawing's, outside the token scale; the
 * ambient sprites take theirs from the `--fx-*` pastels (festive.css).
 */

export type Bubble = "q" | "u" | "i" | "z";

export interface Accessory {
  bubble: Bubble;
  /** Drawn under the bubble (ears behind the U) rather than over it. */
  behind?: boolean;
  /** Entrance animation (`festive-enter-*` in festive.css). */
  enter: "drop" | "pop" | "fade" | "slide" | "land" | "type" | "ignite";
  svg: string;
  /** Its hit box in logo units, [x, y, width, height]: where the info button sits. */
  box: readonly [number, number, number, number];
}

export interface Ambient {
  /** fall from the top, drift across, or burst out of the logo (over the page, once). */
  mode: "fall" | "drift" | "burst";
  /** HTML of each sprite, picked at random. */
  sprites: readonly string[];
  /** The sprite's own motion while it travels. */
  motion: "sway" | "waddle" | "flutter" | "spin" | "twinkle" | "none";
  colors: readonly string[];
  count: number;
  /** Sprite size in px, [min, max]. */
  size: readonly [number, number];
}

export interface FestiveArt {
  accessory: Accessory;
  ambient: Ambient;
}

// --- Drawings ---

/** Tux standing with its feet at (x, y). */
const tux = (x: number, y: number) => `
  <ellipse cx="${x - 7.2}" cy="${y - 8.5}" rx="2.2" ry="6" transform="rotate(15 ${x - 7.2} ${y - 8.5})" fill="#1a1917"/>
  <ellipse cx="${x + 7.2}" cy="${y - 8.5}" rx="2.2" ry="6" transform="rotate(-15 ${x + 7.2} ${y - 8.5})" fill="#1a1917"/>
  <ellipse cx="${x}" cy="${y - 9}" rx="7.5" ry="9.5" fill="#1a1917" stroke="#fff" stroke-opacity=".5" stroke-width=".6"/>
  <ellipse cx="${x}" cy="${y - 7}" rx="5" ry="7" fill="#fff"/>
  <circle cx="${x}" cy="${y - 19.5}" r="6" fill="#1a1917" stroke="#fff" stroke-opacity=".5" stroke-width=".6"/>
  <circle cx="${x - 2}" cy="${y - 20.5}" r="1.6" fill="#fff"/><circle cx="${x + 2}" cy="${y - 20.5}" r="1.6" fill="#fff"/>
  <circle cx="${x - 1.6}" cy="${y - 20.3}" r=".8" fill="#1a1917"/><circle cx="${x + 2.4}" cy="${y - 20.3}" r=".8" fill="#1a1917"/>
  <path d="M${x - 2.2},${y - 17.5}L${x + 2.2},${y - 17.5}L${x},${y - 15.1}Z" fill="#f4a300"/>
  <ellipse cx="${x - 3.5}" cy="${y}" rx="3" ry="1.6" fill="#f4a300"/><ellipse cx="${x + 3.5}" cy="${y}" rx="3" ry="1.6" fill="#f4a300"/>`;

/** A moth centred on (x, y); its wings flap as one group. */
const moth = (x: number, y: number) => `
  <g class="festive-wings" fill="#cbb89c" stroke="#8a7660" stroke-width=".5">
    <ellipse cx="${x - 4.5}" cy="${y - 2}" rx="5" ry="3.2" transform="rotate(-25 ${x - 4.5} ${y - 2})"/>
    <ellipse cx="${x + 4.5}" cy="${y - 2}" rx="5" ry="3.2" transform="rotate(25 ${x + 4.5} ${y - 2})"/>
    <ellipse cx="${x - 3.5}" cy="${y + 2.5}" rx="3.5" ry="2.4" transform="rotate(20 ${x - 3.5} ${y + 2.5})"/>
    <ellipse cx="${x + 3.5}" cy="${y + 2.5}" rx="3.5" ry="2.4" transform="rotate(-20 ${x + 3.5} ${y + 2.5})"/>
  </g>
  <ellipse cx="${x}" cy="${y}" rx="1.4" ry="5" fill="#6b5a45"/>
  <path d="M${x - 0.5},${y - 4.5}q-1.5,-3 -3.5,-3.5M${x + 0.5},${y - 4.5}q1.5,-3 3.5,-3.5" stroke="#6b5a45" stroke-width=".5" fill="none"/>`;

/** A gear of n teeth (outer radius R, root radius r) with a hole in the middle. */
function gear(cx: number, cy: number, R: number, r: number, n: number) {
  const w = Math.PI / (2 * n);
  const points: string[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k * 2 * Math.PI) / n;
    for (const [radius, da] of [[r, -1.6 * w], [R, -0.8 * w], [R, 0.8 * w], [r, 1.6 * w]] as const)
      points.push(`${(cx + radius * Math.cos(a + da)).toFixed(2)},${(cy + radius * Math.sin(a + da)).toFixed(2)}`);
  }
  const h = r * 0.32;
  return `M${points.join("L")}Z M${cx + h},${cy} a${h},${h} 0 1 0 ${-2 * h},0 a${h},${h} 0 1 0 ${2 * h},0`;
}

/** Monospace text typed in (`--n` characters), its caret blinking a few times then gone. */
const typed = (x: number, y: number, s: string) =>
  `<text class="festive-text" x="${x}" y="${y}" style="--n:${s.length}">${s}<tspan class="festive-caret">▋</tspan></text>`;

// --- Sprites (HTML, sized by --s, coloured by currentColor) ---

const svg = (viewBox: string, body: string) => `<svg viewBox="${viewBox}">${body}</svg>`;
const glyph = (s: string) => `<span class="festive-glyph">${s}</span>`;
const SNOW = svg(
  "-12 -12 24 24",
  `<g stroke="currentColor" stroke-width="1.7" stroke-linecap="round" fill="none"><path d="M0-10V10M-8.7-5 8.7 5M-8.7 5 8.7-5"/><path d="M-3-8 0-5.5 3-8M-3 8 0 5.5 3 8"/></g>`,
);
const EGG = svg(
  "-10 -12 20 24",
  `<path d="M0-11C6-11 9-2 9 3 9 8 5 11 0 11-5 11-9 8-9 3-9-2-6-11 0-11Z" fill="currentColor"/><path d="M-8.6 0q2.15-2.5 4.3 0t4.3 0 4.3 0 4.3 0" stroke="#fff" stroke-width="1.5" fill="none" opacity=".85"/>`,
);
const SPARKLE = svg("-10 -10 20 20", `<path d="M0-10Q1.2-1.2 10 0Q1.2 1.2 0 10Q-1.2 1.2-10 0Q-1.2-1.2 0-10Z" fill="currentColor"/>`);
const GEAR = svg("-12 -12 24 24", `<path d="${gear(0, 0, 11, 8.2, 10)}" fill="currentColor" fill-rule="evenodd"/>`);
const PASTELS = ["var(--fx-pink)", "var(--fx-blue)", "var(--fx-yellow)", "var(--fx-green)", "var(--fx-lilac)"];

export const ART: Record<FestiveId, FestiveArt> = {
  programmers: {
    accessory: { bubble: "i", enter: "type", svg: typed(126, -4, "0x100"), box: [124, -15, 44, 15] },
    ambient: {
      mode: "burst",
      sprites: ["{", "}", ";", "</>", "0x100", "&&", "=>", "[ ]", "//"].map((s) => glyph(s.replace("<", "&lt;"))),
      motion: "none",
      colors: PASTELS,
      count: 40,
      size: [13, 22],
    },
  },
  ada: {
    accessory: {
      bubble: "q",
      behind: true,
      enter: "fade",
      svg:
        `<path class="festive-spin" style="--turn:-300deg" d="${gear(12.5, 9, 8, 6, 9)}" fill="#9aa0a8" fill-rule="evenodd"/>` +
        `<path class="festive-spin" style="--turn:380deg" d="${gear(20.8, 0.4, 5.8, 4.2, 7)}" fill="#b5bac1" fill-rule="evenodd"/>`,
      box: [3, -7, 26, 18],
    },
    ambient: { mode: "drift", sprites: [GEAR], motion: "spin", colors: ["var(--fx-ink)"], count: 9, size: [24, 46] },
  },
  hopper: {
    accessory: { bubble: "z", enter: "land", svg: moth(206, 6.5), box: [195, -6, 22, 16] },
    ambient: { mode: "drift", sprites: [svg("-11 -11 22 20", moth(0, 0))], motion: "flutter", colors: ["var(--fg)"], count: 8, size: [22, 34] },
  },
  xmas: {
    accessory: {
      bubble: "q",
      enter: "drop",
      svg: `<g transform="rotate(-12 32 8)">
        <path d="M17,7C19,-12 39,-23 55,-11C49,-10 46,-3 47,7Z" fill="#b3000a"/>
        <rect x="14" y="3.5" width="36" height="8" rx="4" fill="#fff" stroke="#d3cfc7" stroke-width=".6"/>
        <circle cx="55.5" cy="-10" r="4.4" fill="#fff" stroke="#d3cfc7" stroke-width=".6"/></g>`,
      box: [12, -22, 50, 30],
    },
    ambient: { mode: "fall", sprites: [SNOW], motion: "sway", colors: ["var(--fx-snow)"], count: 34, size: [10, 22] },
  },
  torvalds: {
    accessory: { bubble: "i", enter: "drop", svg: tux(152.5, 8.6), box: [143, -18, 20, 28] },
    ambient: { mode: "drift", sprites: [svg("-11 -26 22 28", tux(0, 0))], motion: "waddle", colors: ["var(--fg)"], count: 7, size: [30, 44] },
  },
  kernighan: {
    accessory: { bubble: "q", enter: "type", svg: typed(4, -4, "hello, world"), box: [2, -15, 90, 15] },
    ambient: {
      mode: "burst",
      sprites: [`<i class="festive-confetti"></i>`],
      motion: "none",
      colors: PASTELS,
      count: 60,
      size: [8, 13],
    },
  },
  pi: {
    accessory: {
      bubble: "i",
      enter: "fade",
      svg: `<rect x="134.4" y="17.6" width="19.6" height="3.8" rx="1.2" fill="#fff"/><path d="M147.6,21h4.2v16.5c0,1.6,0.6,2.2,1.8,2.2v1.6c-3.6,0.3-6-0.8-6-4.4z" fill="#fff"/>`,
      box: [133, 16, 22, 26],
    },
    ambient: {
      mode: "fall",
      sprites: [..."3.14159265358979"].map(glyph),
      motion: "sway",
      colors: ["var(--fx-blue)", "var(--fx-ink)"],
      count: 30,
      size: [14, 24],
    },
  },
  easter: {
    accessory: {
      bubble: "u",
      behind: true,
      enter: "pop",
      svg: [81, 96]
        .map(
          (x, k) =>
            `<g transform="rotate(${k ? 16 : -14} ${x} 9)"><ellipse cx="${x}" cy="-5" rx="5.6" ry="13" fill="#fff" stroke="#e3af00" stroke-width="1.4"/><ellipse cx="${x}" cy="-4" rx="2.6" ry="9" fill="#f5b3c6"/></g>`,
        )
        .join(""),
      box: [74, -19, 29, 25],
    },
    ambient: { mode: "fall", sprites: [EGG], motion: "sway", colors: PASTELS, count: 24, size: [16, 26] },
  },
  starwars: {
    accessory: {
      bubble: "i",
      enter: "ignite",
      svg: `<rect class="festive-blade" x="140.6" y="-17" width="2.8" height="44" rx="1.4" fill="#f2fff6"/>
        <g class="festive-hilt"><rect x="139.1" y="26" width="5.8" height="15" rx="1" fill="#c4c8cf"/><rect x="139.1" y="29" width="5.8" height="1.6" fill="#3a3d42"/><rect x="139.1" y="33.4" width="5.8" height="1.6" fill="#3a3d42"/><rect x="144.9" y="30.8" width="1.3" height="3.2" rx=".4" fill="#3a3d42"/></g>`,
      box: [136, -18, 12, 59],
    },
    ambient: {
      mode: "drift",
      sprites: [SPARKLE],
      motion: "twinkle",
      colors: ["var(--fx-yellow)", "var(--fx-ink)"],
      count: 16,
      size: [8, 18],
    },
  },
  turing: {
    accessory: {
      bubble: "z",
      enter: "slide",
      svg:
        [0, 1, 1, 0, 1, 0]
          .map(
            (bit, k) =>
              `<rect class="festive-tape" x="${177 + k * 7}" y="-9" width="7" height="8"/><text class="festive-bit" x="${180.5 + k * 7}" y="-3">${bit}</text>`,
          )
          .join("") + `<path d="M191.5,-16h6l-3,4.4z" fill="currentColor"/>`,
      box: [176, -17, 44, 17],
    },
    ambient: {
      mode: "drift",
      sprites: ["0", "1"].map((s) => `<span class="festive-cell">${s}</span>`),
      motion: "none",
      colors: ["var(--fx-ink)", "var(--fx-blue)"],
      count: 12,
      size: [16, 24],
    },
  },
};
