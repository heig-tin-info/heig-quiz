import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { StudentPreviewPage } from "./StudentPreviewPage";

/*
 * `/questions/:id/preview`: the page the editor's "Student preview" button
 * opens in a tab of its own.
 *
 * The question type is the REAL one from `@quiz/registry/client` and it is
 * mounted through the student's own `QuestionHost` — which is the point of
 * the page, and the reason the markdown assertion below belongs here: a
 * preview that renders the statement differently from the player previews
 * nothing.
 */

const PREVIEW = {
  type: "mcq",
  student: {
    prompt: "# Les pointeurs\n\nQue vaut un pointeur non initialisé ?",
    choices: [
      { id: 0, text: "NULL" },
      { id: 1, text: "Une valeur indéterminée" },
    ],
    mode: "single",
  },
  itemPoints: 2,
};

describe("StudentPreviewPage", () => {
  it("renders the question through the student player, markdown and all", async () => {
    const { calls } = mockFetch({ "POST /app/api/questions/q1/preview": ok(PREVIEW) });
    renderWithProviders(<StudentPreviewPage id="q1" />);

    // The subtitle is the whole contract of the page: nothing is kept.
    expect(await screen.findByText("Answer freely: nothing is saved or graded")).toBeInTheDocument();
    // The statement went through `MarkdownView`, like the player's: a heading
    // is a heading and not the literal "# Les pointeurs".
    const heading = await screen.findByRole("heading", { name: "Les pointeurs" });
    expect(heading).toBeInTheDocument();
    expect(screen.queryByText(/# Les pointeurs/)).toBeNull();
    // The type's own player, with the app's translated strings.
    expect(screen.getByRole("radio", { name: "Une valeur indéterminée" })).toBeInTheDocument();
    expect(screen.getByText("Choose one answer.")).toBeInTheDocument();
    // The draft, at seed 0, through `toStudent` — one read, behind a POST.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "/app/api/questions/q1/preview",
      body: { source: "draft" },
    });
  });

  /*
   * "Show answers" asks for the key on the click, never before, and marks it
   * on the same player, the teacher's tick kept, with the explanation under
   * the question (#554); "Hide answers" takes both away again.
   */
  it("shows the answers on demand, and hides them again with the answer kept", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch({
      "POST /app/api/questions/q1/preview": ok(PREVIEW),
      "POST /app/api/questions/q1/preview/solution": ok({ solution: { correct: [1] }, explanation: "Lire avant d'écrire." }),
    });
    renderWithProviders(<StudentPreviewPage id="q1" />);
    await user.click(await screen.findByRole("radio", { name: "NULL" }));
    expect(calls.map((c) => c.url)).toEqual(["/app/api/questions/q1/preview"]);

    await user.click(screen.getByRole("button", { name: "Show answers" }));
    expect(await screen.findByText("Correct answer")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Une valeur indéterminée/ })).toHaveAccessibleName(
      "Une valeur indéterminée Correct answer",
    );
    expect(screen.getByRole("radio", { name: "NULL" })).toBeChecked();
    expect(screen.getByText("Lire avant d'écrire.")).toBeInTheDocument();
    expect(calls[1]).toMatchObject({
      method: "POST",
      url: "/app/api/questions/q1/preview/solution",
      body: { source: "draft" },
    });

    await user.click(screen.getByRole("button", { name: "Hide answers" }));
    expect(screen.getByRole("radio", { name: "NULL" })).toBeChecked();
    expect(screen.queryByText("Correct answer")).toBeNull();
    expect(screen.queryByText("Lire avant d'écrire.")).toBeNull();
  });

  it("offers no answers for a type whose key it does not show yet", async () => {
    mockFetch({
      "POST /app/api/questions/q1/preview": ok({
        type: "short",
        student: { prompt: "Le mot-clé ?" },
        itemPoints: 1,
      }),
    });
    renderWithProviders(<StudentPreviewPage id="q1" />);
    expect(await screen.findByText("Answer freely: nothing is saved or graded")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show answers" })).toBeNull();
  });

  /*
   * A question created a minute ago has an empty draft, which does not
   * validate (decision D16), so the server answers `422 config_invalid`. That
   * is the state the teacher who reported the bug was in, and it must say so
   * rather than show an empty page.
   */
  it("says the draft is not finished instead of failing", async () => {
    mockFetch({
      "POST /app/api/questions/q1/preview": fail(422, {
        error: "config_invalid",
        message: "This version cannot be rendered",
      }),
    });
    renderWithProviders(<StudentPreviewPage id="q1" />);
    expect(await screen.findByText("The preview could not be built.")).toBeInTheDocument();
  });
});
