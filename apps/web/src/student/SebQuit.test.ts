import { describe, expect, it } from "vitest";

import { quitPlatform } from "./SebQuit";

const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SEB/3.8";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 SEB/3.4";

describe("quitPlatform, for SEB's quit shortcut", () => {
  it("reads the client hint first, then the legacy platform, then the user agent", () => {
    expect(quitPlatform({ userAgent: MAC_UA, platform: "MacIntel", userAgentData: { platform: "Windows" } })).toBe("windows");
    expect(quitPlatform({ userAgent: "", platform: "Win32" })).toBe("windows");
    expect(quitPlatform({ userAgent: "", platform: "MacIntel" })).toBe("mac");
    expect(quitPlatform({ userAgent: WIN_UA, platform: "" })).toBe("windows");
    expect(quitPlatform({ userAgent: MAC_UA })).toBe("mac");
  });

  it("says nothing when none of them names Windows or macOS", () => {
    expect(quitPlatform({ userAgent: "Mozilla/5.0 (X11; Linux x86_64)", platform: "Linux x86_64" })).toBeNull();
    expect(quitPlatform({ userAgent: "" })).toBeNull();
  });
});
