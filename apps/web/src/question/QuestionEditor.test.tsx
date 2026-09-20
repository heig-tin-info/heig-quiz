import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolDetail, QuestionDetail } from "@quiz/contracts";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { QuestionEditor } from "./QuestionEditor";

/*
 * The authoring flow, end to end against a stubbed API: open a question,
 * change it, watch it autosave, publish it, and see the publication refused
 * when the draft is not finished (decision D16).
 *
 * The question types are the REAL ones from `@quiz/registry/client`: the
 * point of the editor screen is that it mounts a type's own editor with the
 * app's strings, and a stub of that editor would test the stub.
 */

const POOL: PoolDetail = {
  pool: {
    id: "p1",
    name: "Programmation C",
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
  },
  categories: [{ id: "k1", poolId: "p1", parentId: null, name: "Pointeurs", position: 0, children: [] }],
  tags: ["pointeurs"],
  questionCount: 1,
};

function mcqDetail(over: Partial<QuestionDetail> = {}): QuestionDetail {
  return {
    meta: {
      id: "q1",
      poolId: "p1",
      type: "mcq",
      internalName: "ptr-null-check",
      categoryId: "k1",
      difficulty: 2,
      shuffleable: true,
      randomizable: false,
      tags: ["pointeurs"],
      createdBy: "u-me",
      originQuestionId: null,
      deletedAt: null,
      updatedAt: "2026-09-01T08:00:00.000Z",
    },
    draft: {
      config: {
        configVersion: 1,
        prompt: "Que vaut un pointeur non initialisé ?",
        choices: [
          { text: "NULL", correct: false },
          { text: "Une valeur indéterminée", correct: true },
        ],
        mode: "single",
        policy: "all_or_nothing",
        penalty: 1,
        allowNegative: false,
        shuffleChoices: true,
      },
      explanation: "",
      configVersion: 1,
      updatedAt: "2026-09-01T08:00:00.000Z",
      valid: true,
    },
    versions: [],
    latestPublished: null,
    ...over,
  };
}

function codeDetail(): QuestionDetail {
  const base = mcqDetail();
  return {
    ...base,
    meta: { ...base.meta, id: "q2", type: "code", internalName: "ptr-arith-01" },
    draft: {
      ...base.draft,
      config: {
        configVersion: 1,
        prompt: "Écrivez la fonction `somme`.",
        language: "c",
        template: "int somme(void) {\n    return 0;\n}\n",
        files: [],
        action: "run",
        compileArgs: "",
        limits: { timeMs: 2000, memoryMb: 128, outputKb: 64 },
        runsPerMinute: 10,
        allOrNothing: false,
        referenceSolution: "",
        tests: {
          mode: "io",
          compare: { trimTrailing: true, ignoreCase: false, numeric: null },
          cases: [{ name: "cas 1", stdin: "", expected: "150", visible: true, points: 1, timeMs: null }],
        },
      },
    },
  };
}

const DRAFT_OK = { updatedAt: "2026-09-20T10:00:00.000Z", valid: true, issues: [] };

function routes(detail: QuestionDetail, over: Record<string, unknown> = {}) {
  const id = detail.meta.id;
  return {
    [`GET /app/api/questions/${id}`]: ok(detail),
    "GET /app/api/pools/p1": ok(POOL),
    [`PUT /app/api/questions/${id}/draft`]: ok(DRAFT_OK),
    [`POST /app/api/questions/${id}/publish`]: ok({
      number: 1,
      publishedAt: "2026-09-20T10:00:00.000Z",
      publishedBy: "u-me",
      changeNote: null,
      deprecatedAt: null,
      deprecationNote: null,
    }),
    [`POST /app/api/questions/${id}/preview`]: ok({
      student: {
        prompt: "Que vaut un pointeur non initialisé ?",
        choices: [
          { id: 0, text: "NULL" },
          { id: 1, text: "Une valeur indéterminée" },
        ],
        mode: "single",
      },
      itemPoints: 1,
    }),
    ...over,
  } as Record<string, ReturnType<typeof ok>>;
}

describe("QuestionEditor — mcq", () => {
  it("mounts the type's own editor with the translated strings", async () => {
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "ptr-null-check" })).toBeInTheDocument();
    // The mcq editor's own prompt field, labelled through `strings`.
    expect(await screen.findByLabelText("Statement")).toHaveValue(
      "Que vaut un pointeur non initialisé ?",
    );
    expect(screen.getByLabelText("Text of choice A")).toHaveValue("NULL");
  });

  it("autosaves the draft after the last keystroke, once", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    const prompt = await screen.findByLabelText("Statement");
    // One keystroke: the live markdown preview re-renders on each one, and
    // the debounce itself is unit-tested in `autosave.test.tsx`.
    await user.type(prompt, "!");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("/app/api/questions/q1/draft");
    expect((put.body as { config: { prompt: string } }).config.prompt).toBe(
      "Que vaut un pointeur non initialisé ?!",
    );
    // SyncBadge spells the state twice (visible above `sm`, sr-only below).
    expect(await screen.findAllByText("Saved")).not.toHaveLength(0);
  }, 20_000);

  it("publishes with a change note", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("What changed"), "Reformulation");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/questions/q1/publish")).toBe(true),
    );
    const post = calls.find((c) => c.url === "/app/api/questions/q1/publish")!;
    expect(post.body).toEqual({ changeNote: "Reformulation" });
  });

  it("shows the zod issues inline when the API refuses the publication", async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(mcqDetail(), {
        "POST /app/api/questions/q1/publish": fail(422, {
          error: "config_invalid",
          message: "Fix the draft before publishing",
          details: [
            { path: ["choices"], code: "custom", message: "mcq.no_correct_choice" },
            { path: ["choices", "1", "text"], code: "too_small", message: "String must contain at least 1 character(s)" },
          ],
        }),
      }),
    );
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    // The schema key is translated; the zod sentence is shown as it came.
    expect(await screen.findByText("Tick at least one correct choice.")).toBeInTheDocument();
    expect(screen.getByText("choices.1.text", { exact: false })).toBeInTheDocument();
    // The dialog stays open: the decision is made here, so the refusal is too.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
});

describe("QuestionEditor — code", () => {
  it("mounts the code editor and publishes it", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(codeDetail()));
    renderWithProviders(<QuestionEditor id="q2" navigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "ptr-arith-01" })).toBeInTheDocument();
    // Monaco never loads under jsdom; the textarea fallback is the surface.
    expect(await screen.findByLabelText("Starting code")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(calls.some((c) => c.url === "/app/api/questions/q2/publish")).toBe(true),
    );
  });
});

describe("QuestionEditor — keyboard", () => {
  it("Ctrl+S saves without waiting for the debounce", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    const prompt = await screen.findByLabelText("Statement");
    await user.type(prompt, "!");
    await user.keyboard("{Control>}s{/Control}");
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
  });

  it("Ctrl+Shift+P opens the publish dialog", async () => {
    const user = userEvent.setup();
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    expect(await screen.findByRole("dialog")).toHaveAccessibleName("Publish this question");
  });

  it("Ctrl+Shift+M toggles the student preview", async () => {
    const user = userEvent.setup();
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    // The button of the same name is always there; the PANEL is what toggles.
    const panel = () => screen.queryByRole("heading", { name: "Student preview" });
    expect(panel()).not.toBeInTheDocument();
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    expect(await screen.findByRole("heading", { name: "Student preview" })).toBeInTheDocument();
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    await waitFor(() => expect(panel()).not.toBeInTheDocument());
  });
});
