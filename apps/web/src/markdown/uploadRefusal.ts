import { SvgRefusal, type SvgRefusalCode } from "@quiz/contracts";

import { ApiError, refusedWith } from "../api";
import type { Dict, TFunction } from "../i18n";

/** Each closed reason of the SVG check (ADR-134), worded in the reader's language. */
const SVG_REFUSALS: Record<SvgRefusalCode, keyof Dict> = {
  too_large: "md.image.svg.too_large",
  malformed: "md.image.svg.malformed",
  not_svg: "md.image.svg.not_svg",
  construct: "md.image.svg.construct",
  text: "md.image.svg.text",
  element: "md.image.svg.element",
  attribute: "md.image.svg.attribute",
  namespace: "md.image.svg.namespace",
  reference: "md.image.svg.reference",
  function: "md.image.svg.function",
  css: "md.image.svg.css",
  escape: "md.image.svg.escape",
  cycle: "md.image.svg.cycle",
  too_deep: "md.image.svg.too_deep",
  too_complex: "md.image.svg.too_complex",
};

/**
 * What a refused image upload says to the teacher: the SVG check's reason
 * by its code, or the accepted types; null for any other failure.
 */
export function uploadRefusalText(error: unknown, t: TFunction): string | null {
  if (error instanceof ApiError) {
    const svg = SvgRefusal.safeParse(error.body);
    if (svg.success) return t(SVG_REFUSALS[svg.data.code], { name: svg.data.name ?? "" });
  }
  return refusedWith(error, "unsupported_media_type") ? t("md.image.typeRefused") : null;
}
