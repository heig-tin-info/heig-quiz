import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrgAvatar, orgInitials } from "./identity";

/*
 * An organization's picture: the one the API serves, or its initials when
 * there is none or it fails — the browser's broken-image glyph is not a logo,
 * and the browser never goes to github.com for one.
 */

describe("orgInitials", () => {
  it("takes the first letter of the first two words of the login", () => {
    expect(orgInitials("heig-tin-info")).toBe("HT");
    expect(orgInitials("prg1_2026")).toBe("P2");
    expect(orgInitials("octocat")).toBe("OC");
    expect(orgInitials("x")).toBe("X");
    expect(orgInitials("--")).toBe("?");
  });
});

describe("OrgAvatar", () => {
  it("draws the initials, and loads nothing, when no picture is given", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("HT");
  });

  it("shows the picture it is given, decorative", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" src="/api/orgs/1/avatar" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("/api/orgs/1/avatar");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("falls back to the initials when the picture fails, and retries a new one", () => {
    const { container, rerender } = render(<OrgAvatar login="heig-tin-info" src="/a.png" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("HT");
    rerender(<OrgAvatar login="heig-tin-info" src="/b.png" />);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("/b.png");
  });

  it("writes one letter at the smallest size, where two would be a smudge", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" size="xs" />);
    expect(container.textContent).toBe("H");
  });
});
