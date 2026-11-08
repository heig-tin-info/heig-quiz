import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { RelativeTime, relativeTime } from ".";

/*
 * A date written as a distance. The helper is pure and takes its clock, its
 * locale and the one word `Intl` has no format for, so both languages and
 * both directions are one call each.
 */
describe("relativeTime", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const t = ((key: string) => (key === "time.now" ? "just now" : key)) as (
    key: "time.now",
  ) => string;
  const tf = ((key: string) => (key === "time.now" ? "à l'instant" : key)) as (
    key: "time.now",
  ) => string;

  it("says the word Intl has none for, in either language", () => {
    expect(relativeTime(at(0), now, "en", t)).toBe("just now");
    expect(relativeTime(at(-20_000), now, "en", t)).toBe("just now");
    expect(relativeTime(at(30_000), now, "fr", tf)).toBe("à l'instant");
  });

  it("looks backwards with the largest unit that is not zero", () => {
    expect(relativeTime(at(-5 * 60_000), now, "en", t)).toBe("5 minutes ago");
    expect(relativeTime(at(-3 * 3_600_000), now, "en", t)).toBe("3 hours ago");
    expect(relativeTime(at(-2 * 86_400_000), now, "en", t)).toBe("2 days ago");
    expect(relativeTime(at(-400 * 86_400_000), now, "en", t)).toBe("last year");
  });

  it("looks forwards too", () => {
    expect(relativeTime(at(10 * 60_000), now, "en", t)).toBe("in 10 minutes");
    expect(relativeTime(at(3 * 86_400_000), now, "en", t)).toBe("in 3 days");
  });

  it("speaks French when the locale does", () => {
    expect(relativeTime(at(-5 * 60_000), now, "fr", tf)).toBe("il y a 5 minutes");
    expect(relativeTime(at(2 * 3_600_000), now, "fr", tf)).toBe("dans 2 heures");
  });
});

describe("RelativeTime", () => {
  it("writes the distance, keeps the stamp machine-readable, and is reachable", () => {
    const iso = new Date(Date.now() - 2 * 3_600_000).toISOString();
    renderWithProviders(<RelativeTime iso={iso} />);
    const time = screen.getByText("2 hours ago");
    expect(time).toHaveAttribute("datetime", iso);
    // Focusable, because the exact stamp lives in a Tip and a tooltip nobody
    // can reach is a tooltip that is not there.
    expect(time).toHaveAttribute("tabindex", "0");
  });
});
