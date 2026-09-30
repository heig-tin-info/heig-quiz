/**
 * The text measure of the element a ref points at, once it is laid out;
 * the estimate before.
 */
import { useLayoutEffect, useState, type RefObject } from "react";

import type { Measure } from "../geometry.js";
import { canvasMeasure } from "./measure.js";

export function useMeasure(ref: RefObject<Element | null>): Measure {
  const [measure, setMeasure] = useState<Measure>(() => canvasMeasure(null));
  useLayoutEffect(() => setMeasure(() => canvasMeasure(ref.current)), [ref]);
  return measure;
}
