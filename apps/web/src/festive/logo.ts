import type { Accessory } from "./art";

/** The logo's viewBox (assets/quiz.svg): the unit of an accessory's drawing and hit box. */
export const LOGO_BOX = { width: 227.2, height: 60.1 } as const;

/**
 * The logo with an accessory slipped into its bubble's group (ADR-093): so
 * it dances with the bubble, first in the group when it is drawn behind
 * (ears behind the U), last when over it (a hat on the Q).
 */
export function withAccessory(svg: string, accessory: Accessory): string {
  const open = `<g class="logo-${accessory.bubble}">`;
  const start = svg.indexOf(open);
  if (start < 0) return svg;
  const at = accessory.behind ? start + open.length : svg.indexOf("</g>", start);
  const piece = `<g class="festive-accessory festive-enter-${accessory.enter}">${accessory.svg}</g>`;
  return svg.slice(0, at) + piece + svg.slice(at);
}
