import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../test/render";
import { StationSuspendedOverlay } from "./PausedOverlay";

describe("the suspended station's notice (ADR-051 §6)", () => {
  it("covers the question, says the answers are kept and whom to call, with nothing to press", () => {
    renderWithProviders(<StationSuspendedOverlay show />);
    const notice = screen.getByRole("status");
    expect(notice).toHaveTextContent("This station is suspended");
    expect(notice).toHaveTextContent("your answers are saved. Call the supervisor.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is absent once lifted", () => {
    renderWithProviders(<StationSuspendedOverlay show={false} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("speaks French", () => {
    renderWithProviders(<StationSuspendedOverlay show />, { locale: "fr" });
    expect(screen.getByRole("status")).toHaveTextContent("Ce poste est suspendu");
  });
});
