import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { QUESTION_TYPE_IDS } from "../questionTypes";
import { renderWithProviders } from "../test/render";
import { isWide, QuestionHost } from "./QuestionHost";

describe("isWide", () => {
  it("gives the room to the program types only, a statement beside an editor", () => {
    expect(QUESTION_TYPE_IDS.filter(isWide)).toEqual(["code", "codeimage"]);
    expect(isWide("nope")).toBe(false);
  });
});

/*
 * The student's host lends the `rich` player the app's formatted editor
 * (`PlayerProps.RichText`, issue #192) and the French words of its field. The
 * package's own suite proves what the player does with them; this proves the
 * host hands them over.
 */
describe("QuestionHost for an essay", () => {
  it("mounts the formatted editor, in the student's language", async () => {
    renderWithProviders(
      <QuestionHost
        type="rich"
        student={{ prompt: "Expliquez.", format: "markdown", maxChars: 1500 }}
        answer={{ text: "Une **pile**." }}
        onChange={() => {}}
        readOnly={false}
      />,
      { locale: "fr" },
    );
    const field = await screen.findByRole("textbox", { name: "Votre réponse" });
    expect(field).toHaveAttribute("contenteditable", "true");
    expect(screen.getByText(/13 \/ 1500 caractères/)).toBeInTheDocument();
  });

  it("keeps a plain question to a textarea", async () => {
    renderWithProviders(
      <QuestionHost
        type="rich"
        student={{ prompt: "Expliquez.", format: "plain" }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
      />,
    );
    const field = await screen.findByRole("textbox", { name: "Your answer" });
    expect(field.tagName).toBe("TEXTAREA");
  });
});

/*
 * The host once built its own copy of the `mcq` dictionary, which lacked the
 * negative-marking notice: a French student read it in English.
 */
describe("QuestionHost for a choice question", () => {
  it("tells of negative marking in the student's language", async () => {
    renderWithProviders(
      <QuestionHost
        type="mcq"
        student={{
          prompt: "Quelle adresse ?",
          choices: [
            { id: 0, text: "0x1000" },
            { id: 1, text: "0x1004" },
          ],
          mode: "single",
          negativeMarking: true,
        }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
      />,
      { locale: "fr" },
    );
    expect(
      await screen.findByText("Une réponse fausse coûte des points ; ne pas répondre ne coûte rien."),
    ).toBeInTheDocument();
    expect(screen.getByText("Choisissez une réponse.")).toBeInTheDocument();
  });
});

/* A focused canvas lends its keys through the host (issue #549), for the player's side column. */
describe("QuestionHost for a diagram", () => {
  it("hands the canvas's keys to the player's listener", async () => {
    const lend = vi.fn();
    renderWithProviders(
      <QuestionHost
        type="diagram"
        student={{ prompt: "Dessinez.", kind: "flow" }}
        answer={null}
        onChange={() => {}}
        readOnly={false}
        onCanvasShortcuts={lend}
      />,
    );
    fireEvent.focus(await screen.findByRole("group", { name: "Your diagram" }));
    expect(lend).toHaveBeenLastCalledWith(expect.arrayContaining([{ keys: ["Mod+Z", "Mod+Y"], label: "Undo / Redo" }]));
  });
});
