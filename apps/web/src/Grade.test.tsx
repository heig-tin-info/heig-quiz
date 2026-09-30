import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "./test/render";
import { Grade } from "./Grade";

/*
 * A grade is coloured by its band and carries its ECTS label in the text, so
 * a screen reader hears what the colour and the hover bubble say.
 */

describe("Grade", () => {
  it.each([
    [3.4, "text-danger", "3.4 (Fail (F))"],
    [4.2, "text-warning", "4.2 (Sufficient (E))"],
    [5.8, null, "5.8 (Excellent (A))"],
  ])("writes %s with its band and label", (value, tone, text) => {
    const { container } = renderWithProviders(<Grade value={value} />);
    expect(container).toHaveTextContent(text);
    const span = screen.getByText(String(value));
    if (tone) expect(span).toHaveClass(tone);
    else expect(span.className).toBe("");
  });

  it("speaks French in French", () => {
    const { container } = renderWithProviders(<Grade value={4.5} />, { locale: "fr" });
    expect(container).toHaveTextContent("4.5 (Satisfaisant (D))");
  });
});
