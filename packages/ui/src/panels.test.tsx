import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AsideSection, TryPanel } from "./panels.js";

describe("AsideSection", () => {
  it("renders in place, undressed, without an aside", () => {
    const { container } = render(
      <div>
        <AsideSection aside={null}>
          <h3>Scoring</h3>
        </AsideSection>
      </div>,
    );
    const section = container.querySelector("section");
    expect(section?.className).toBe("flex flex-col gap-3");
    expect(section?.parentElement).toBe(container.firstElementChild);
  });

  it("portals into the aside and wears the card there", () => {
    const aside = document.createElement("div");
    document.body.appendChild(aside);
    const { container } = render(
      <div>
        <AsideSection aside={aside}>
          <h3>Scoring</h3>
        </AsideSection>
      </div>,
    );
    expect(container.querySelector("section")).toBeNull();
    const section = aside.querySelector("section");
    expect(section?.className).toContain("rounded-card");
    expect(section?.className).toContain("p-4");
    aside.remove();
  });
});

describe("TryPanel", () => {
  it("runs on click and says nothing before the first try", () => {
    const onTry = vi.fn();
    render(<TryPanel label="Try" runningLabel="Trying…" running={false} onTry={onTry} status={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Try" }));
    expect(onTry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("is busy while running and shows the status in its tone", () => {
    render(
      <TryPanel
        label="Try"
        runningLabel="Trying…"
        running
        onTry={() => {}}
        status={{ tone: "danger", text: "Does not compile." }}
      />,
    );
    expect(screen.getByRole("button", { name: "Trying…" })).toBeDisabled();
    expect(screen.getByRole("status").className).toContain("text-danger");
  });
});
