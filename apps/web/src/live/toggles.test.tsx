import { act, renderHook } from "@testing-library/react";
import type { EvaluationMode } from "@quiz/contracts";
import { describe, expect, it } from "vitest";

import {
  examTogglesKey,
  LIVE_TOGGLE_DEFAULTS,
  LIVE_TOGGLES_KEY,
  parseLiveToggles,
  useLiveToggles,
} from "./toggles";

describe("parseLiveToggles (#80)", () => {
  it("gives the defaults when nothing is stored", () => {
    expect(parseLiveToggles(null)).toEqual(LIVE_TOGGLE_DEFAULTS);
  });

  // #227: the first frame a projector shows names nobody and answers nothing.
  it("starts with everything hidden", () => {
    expect(LIVE_TOGGLE_DEFAULTS).toEqual({ names: false, answers: false, results: false });
  });

  it("reads back what was stored", () => {
    expect(parseLiveToggles('{"names":false,"answers":true,"results":false}')).toEqual({
      names: false,
      answers: true,
      results: false,
    });
  });

  it("ignores a value that is not JSON, or not an object", () => {
    for (const raw of ["", "not json", "true", "[false,false,false]", "null", '"names"']) {
      expect(parseLiveToggles(raw)).toEqual(LIVE_TOGGLE_DEFAULTS);
    }
  });

  it("falls back field by field: a malformed field does not take the others down", () => {
    expect(parseLiveToggles('{"names":true,"answers":"no","results":0,"extra":1}')).toEqual({
      names: true,
      answers: false,
      results: false,
    });
  });

  it("never hands out the shared defaults object", () => {
    const a = parseLiveToggles(null);
    a.names = true;
    expect(parseLiveToggles(null).names).toBe(false);
  });
});

describe("useLiveToggles (#796)", () => {
  const ALL_ON = { names: true, answers: true, results: true };

  it("an exam, or a mode not loaded yet, ignores the browser's answers and results", () => {
    localStorage.setItem(LIVE_TOGGLES_KEY, JSON.stringify(ALL_ON));
    const { result, rerender } = renderHook(
      ({ mode }: { mode: EvaluationMode | undefined }) => useLiveToggles("e1", mode),
      { initialProps: { mode: undefined as EvaluationMode | undefined } },
    );
    expect(result.current[0]).toEqual({ names: true, answers: false, results: false });
    rerender({ mode: "exam" });
    expect(result.current[0]).toEqual({ names: true, answers: false, results: false });
    rerender({ mode: "exercise" });
    expect(result.current[0]).toEqual(ALL_ON);
  });

  it("an exam's choice stays with that exam, and names stay the browser's", () => {
    const { result, unmount } = renderHook(() => useLiveToggles("e1", "exam"));
    act(() => result.current[1]((prev) => ({ ...prev, names: true, results: true })));
    expect(result.current[0]).toEqual({ names: true, answers: false, results: true });
    expect(parseLiveToggles(localStorage.getItem(LIVE_TOGGLES_KEY))).toEqual({
      names: true,
      answers: false,
      results: false,
    });
    expect(sessionStorage.getItem(examTogglesKey("e1"))).toBe('{"answers":false,"results":true}');
    unmount();

    expect(renderHook(() => useLiveToggles("e1", "exam")).result.current[0].results).toBe(true);
    expect(renderHook(() => useLiveToggles("e2", "exam")).result.current[0]).toEqual({
      names: true,
      answers: false,
      results: false,
    });
  });
});
