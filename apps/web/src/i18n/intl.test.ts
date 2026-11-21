import { describe, expect, it } from "vitest";

import { percent, relativeTime, weekLabel } from "../ui/dates";
import { formatDecimal, intlTag } from "./index";

/** ICU writes a group with a narrow no-break space in French: compared as a plain space. */
const plain = (s: string) => s.replace(/[  ]/g, " ");

describe("the regional formats (ADR-140 §10, N-I18N-02)", () => {
  it("formats each language with its regional tag, never the bare code", () => {
    expect(intlTag("fr")).toBe("fr-CH");
    expect(intlTag("en")).toBe("en-GB");
  });

  it("writes numbers the Swiss and British way", () => {
    expect(plain(formatDecimal(1234.5, 2, "fr"))).toBe("1 234,50");
    expect(formatDecimal(1234.5, 2, "en")).toBe("1,234.50");
    expect(percent(0.85, "fr")).toBe("85%");
    expect(percent(0.85, "en")).toBe("85%");
  });

  it("puts the day before the month in English too", () => {
    expect(weekLabel("2026-10-05", "en")).toBe("5 Oct");
    expect(weekLabel("2026-10-05", "fr")).toBe("5 oct.");
    const now = Date.parse("2026-11-21T12:00:00Z");
    const t = () => "now";
    expect(relativeTime("2026-11-21T07:00:00Z", now, "en", t, "short")).toBe("5 hr ago");
    expect(relativeTime("2026-11-18T12:00:00Z", now, "fr", t)).toBe("il y a 3 jours");
  });
});
