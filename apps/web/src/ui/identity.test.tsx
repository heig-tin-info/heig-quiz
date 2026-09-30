import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrgAvatar, orgInitials } from "./identity";

/*
 * An organization's picture: GitHub's, or its initials when there is none or
 * it fails — the browser's broken-image glyph is not a logo.
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
  it("shows GitHub's public picture of the organization by default", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://github.com/heig-tin-info.png?size=96");
    expect(img.getAttribute("alt")).toBe("");
    expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("falls back to the initials when the picture fails to load", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("HT");
  });

  it("draws the initials at once when no picture is known", () => {
    const { container } = render(<OrgAvatar login="prg1-2026" src={null} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("P2");
  });

  it("is named by its label when it stands alone, picture or initials", () => {
    render(
      <>
        <OrgAvatar login="heig-tin-info" label="heig-tin-info" />
        <OrgAvatar login="prg1-2026" src={null} label="prg1-2026" />
      </>,
    );
    expect(screen.getByRole("img", { name: "heig-tin-info" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "prg1-2026" })).toBeTruthy();
  });

  it("keeps a square-ish corner from the radius tokens at every size", () => {
    const { container } = render(
      <>
        <OrgAvatar login="a" src={null} size="xs" />
        <OrgAvatar login="b" src={null} size="sm" />
        <OrgAvatar login="c" src={null} size="md" />
      </>,
    );
    const classes = [...container.querySelectorAll("span")].map((s) => s.className);
    expect(classes[0]).toContain("rounded-sm");
    expect(classes[1]).toContain("rounded-key");
    expect(classes[2]).toContain("rounded-field");
    for (const c of classes) expect(c).not.toContain("rounded-full");
  });

  it("writes one letter at the smallest size, where two would be a smudge", () => {
    const { container } = render(<OrgAvatar login="heig-tin-info" src={null} size="xs" />);
    expect(container.textContent).toBe("H");
  });
});
