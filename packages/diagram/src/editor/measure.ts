/**
 * The browser's text measure: a canvas set in the faces the SVG uses, so a
 * box is as wide as its text really is. Without a canvas (jsdom, a very old
 * browser) the estimate of `geometry.ts` stands in, as on the server.
 */
import { estimateText, type Face, type Measure } from "../geometry.js";

const FACE: Readonly<Record<Face, (sans: string, mono: string) => string>> = {
  name: (sans) => `600 13.5px ${sans}`,
  italic: (sans) => `italic 600 13.5px ${sans}`,
  stereo: (sans) => `400 12px ${sans}`,
  mono: (_, mono) => `400 12px ${mono}`,
  label: (sans) => `500 13px ${sans}`,
};

export function canvasMeasure(host: Element | null): Measure {
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx || !host) return estimateText;
  const style = getComputedStyle(host);
  const sans = style.fontFamily || "system-ui, sans-serif";
  const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "ui-monospace, monospace";
  const cache = new Map<string, number>();
  const c = ctx;
  return (face, text) => {
    const key = `${face}\u0000${text}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    c.font = FACE[face](sans, mono);
    const w = c.measureText(text).width;
    cache.set(key, w);
    return w;
  };
}
