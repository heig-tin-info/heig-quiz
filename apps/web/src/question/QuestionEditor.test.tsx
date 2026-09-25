import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PoolDetail, QuestionDetail } from "@quiz/contracts";

import { makeEvaluationDetail } from "../test/live-fixtures";
import { labelIssues } from "../test/labels";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { AUTOSAVE_DELAY_MS } from "./autosave";
import { QuestionEditor } from "./QuestionEditor";

/*
 * The authoring flow, end to end against a stubbed API: open a question,
 * change it, watch it autosave, publish it, and see the publication refused
 * when the draft is not finished (decision D16).
 *
 * The question types are the REAL ones from `@quiz/registry/client`: the
 * point of the editor screen is that it mounts a type's own editor with the
 * app's strings, and a stub of that editor would test the stub.
 *
 * Since the host lends the types its WYSIWYG editor (`EditorProps.RichText`),
 * the statement and the choices are CONTENTEDITABLE surfaces and not inputs:
 * they are read with `toHaveTextContent`, never `toHaveValue`. What they hold
 * is still markdown — `markdown/roundtrip.test.ts` is where that is proven.
 */

/*
 * jsdom implements `Range` but none of its layout methods, and ProseMirror
 * calls them while mapping the document to coordinates. The stubs live here
 * and not in `src/test/setup.ts`: a global stub would hide a real layout call
 * in every other component test.
 */
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects = () =>
    ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
}
document.elementFromPoint ??= () => null;

const POOL: PoolDetail = {
  pool: {
    id: "p1",
    name: "Programmation C",
    icon: null,
    visibility: "private",
    ownerId: "u-me",
    isPersonal: false,
    createdAt: "2026-01-01T08:00:00.000Z",
    updatedAt: "2026-09-18T08:00:00.000Z",
  },
  role: "owner",
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
    keyless: false,
    ...over,
  };
}

/** The same question with two keys: what fills the scoring card. */
function multipleDetail(): QuestionDetail {
  const base = mcqDetail();
  return {
    ...base,
    draft: {
      ...base.draft,
      config: {
        ...(base.draft.config as Record<string, unknown>),
        configVersion: 2,
        choices: [
          { text: "NULL", correct: true },
          { text: "Une valeur indéterminée", correct: true },
          { text: "0", correct: false },
        ],
        mode: "multiple",
        policy: "inherit",
      },
    },
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
      type: "mcq",
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
    expect(await screen.findByLabelText("Statement")).toHaveTextContent(
      "Que vaut un pointeur non initialisé ?",
    );
    expect(screen.getByLabelText("Text of choice A")).toHaveTextContent("NULL");
    // The first mount of the suite pulls the lazy rich-text chunk (Tiptap +
    // KaTeX), which takes the default 5 s budget on a loaded CI worker.
  }, 20_000);

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
    // Where the caret lands in a freshly mounted contenteditable is the
    // browser's business, so the assertion is that the keystroke reached the
    // draft — not where in the sentence it landed.
    const saved = (put.body as { config: { prompt: string } }).config.prompt;
    expect(saved).toContain("!");
    expect(saved).toContain("Que vaut un pointeur non initialisé ?");
    // SyncBadge spells the state twice (visible above `sm`, sr-only below).
    expect(await screen.findAllByText("Saved")).not.toHaveLength(0);
  }, 20_000);

  /*
   * The autosave loop this screen used to live in: `PUT /draft` makes the API
   * emit a pool hint, `live.ts` invalidates EVERY query, the question query
   * refetches, its draft comes back with a new `updatedAt`, the effect keyed
   * on that stamp replaced the local draft, `useAutosave` saw a new reference
   * and saved again — forever. The editor now recognises the stamp its own
   * save returned and lets it pass.
   */
  it("ignores its own draft coming back from the server, instead of saving again", async () => {
    const user = userEvent.setup();
    let served = mcqDetail();
    const { calls } = mockFetch({
      ...routes(mcqDetail()),
      "GET /app/api/questions/q1": () => ok(served),
    });
    const { queryClient } = renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await user.type(await screen.findByLabelText("Statement"), "!");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));

    // What the server now holds: what we just sent, stamped with the
    // `updatedAt` the PUT answered with.
    const sent = calls.find((c) => c.method === "PUT")!.body as { config: unknown };
    const base = mcqDetail();
    served = mcqDetail({
      draft: { ...base.draft, config: sent.config, updatedAt: DRAFT_OK.updatedAt },
    });

    const before = calls.filter((c) => c.url === "/app/api/questions/q1").length;
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(calls.filter((c) => c.url === "/app/api/questions/q1").length).toBeGreaterThan(before),
    );
    // Long enough for a debounced second save to have left, had one been armed.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS * 3));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(await screen.findByLabelText("Statement")).toHaveTextContent("!");
  }, 20_000);

  it("still takes a FOREIGN draft — a version restored from the Versions tab", async () => {
    let served = mcqDetail();
    const { calls } = mockFetch({
      ...routes(mcqDetail()),
      "GET /app/api/questions/q1": () => ok(served),
    });
    const { queryClient } = renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByLabelText("Statement");

    // `POST /versions/:n/restore` copies v1 over the draft and invalidates the
    // question query; the stamp is newer than anything this editor wrote.
    const base = mcqDetail();
    served = mcqDetail({
      draft: {
        ...base.draft,
        config: { ...(base.draft.config as object), prompt: "Restored from v1" },
        updatedAt: "2026-09-21T09:00:00.000Z",
      },
    });
    await queryClient.invalidateQueries();
    await waitFor(() =>
      expect(screen.getByLabelText("Statement")).toHaveTextContent("Restored from v1"),
    );
    // Shown, not written back: the server already holds it.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS * 3));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  }, 20_000);

  /*
   * #72, #74: publishing reopens the draft with a fresh stamp, the refetch
   * brought it home as a FOREIGN draft (newer than the editor's own save),
   * and the editor saved it straight back — which put the draft after the
   * publication, so the header and the pool list both read "unpublished
   * changes" about a question that had none.
   */
  it("after publishing, writes nothing back and shows no unpublished changes", async () => {
    const user = userEvent.setup();
    const PUBLISHED_AT = "2026-09-20T10:00:05.000Z";
    const version = {
      number: 1,
      publishedAt: PUBLISHED_AT,
      publishedBy: "u-me",
      changeNote: null,
      deprecatedAt: null,
      deprecationNote: null,
    };
    let served = mcqDetail();
    const { calls } = mockFetch({
      ...routes(mcqDetail()),
      "GET /app/api/questions/q1": () => ok(served),
      "POST /app/api/questions/q1/publish": () => {
        const sent = calls.find((c) => c.method === "PUT")!.body as { config: unknown };
        const base = mcqDetail();
        served = mcqDetail({
          draft: { ...base.draft, config: sent.config, updatedAt: PUBLISHED_AT },
          versions: [version],
          latestPublished: version,
        });
        return ok(version);
      },
    });
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await user.type(await screen.findByLabelText("Statement"), "!");
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "Publish" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Publish" }));
    expect(await screen.findByText("published v1")).toBeInTheDocument();

    // Long enough for a debounced save of the refetched draft to have left.
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS * 3));
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(screen.queryByText("unpublished changes")).not.toBeInTheDocument();
  }, 20_000);

  it("opens a blank, invalid draft without complaining about it", async () => {
    // A new question is created EMPTY now; the warning belongs to a draft the
    // teacher has worked on, not to one they have not started.
    const base = mcqDetail();
    const blank = mcqDetail({
      draft: {
        ...base.draft,
        config: {
          configVersion: 1,
          prompt: "",
          choices: [
            { text: "", correct: true },
            { text: "", correct: false },
          ],
          mode: "single",
          policy: "all_or_nothing",
          penalty: 1,
          allowNegative: false,
          shuffleChoices: true,
        },
        valid: false,
      },
    });
    mockFetch(routes(blank));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    expect((await screen.findByLabelText("Statement")).textContent).toBe("");
    expect(screen.queryByText("This draft is incomplete")).not.toBeInTheDocument();
  });

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

  /*
   * Where the type's settings LAND. The scoring of a question belongs with
   * what the question is, not in the middle of what it says, so the screen
   * lends the type an element of its right column (`EditorProps.aside`) and
   * the mcq editor portals its "Scoring" card into it, under "Properties".
   */
  it("hosts the type's scoring settings in the right column, after Properties", async () => {
    mockFetch(routes(multipleDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    const aside = await screen.findByRole("complementary", { name: "Question details" });
    await waitFor(() => expect(within(aside).getByText("Scoring")).toBeInTheDocument());
    expect(within(aside).getByRole("radiogroup", { name: "Scoring policy" })).toBeInTheDocument();
    expect(within(aside).getByLabelText("Never shuffle this question")).toBeInTheDocument();
    const headings = within(aside)
      .getAllByRole("heading")
      .map((h) => h.textContent);
    expect(headings.indexOf("Properties")).toBeGreaterThanOrEqual(0);
    expect(headings.indexOf("Properties")).toBeLessThan(headings.indexOf("Scoring"));
    // And nothing of it stayed in the main column.
    expect(screen.getAllByText("Scoring")).toHaveLength(1);
  }, 20_000);

  it("complains about an answer limit below the key set without waiting for a save", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(multipleDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    const max = await screen.findByLabelText("Maximum selections");
    await user.type(max, "1");
    expect(
      await screen.findByText(
        "The maximum number of selections is below the number of correct choices.",
      ),
    ).toBeInTheDocument();
    // Said before anything left for the server, which is the whole point.
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  }, 20_000);

  /*
   * `MarkdownField` names its own surface through `aria-label` and leaves its
   * caption out (`labelHidden`), because the "?" has to be a SIBLING of the
   * caption and that component has no slot for it. The visible row is the
   * screen's, and this is what says the two stay together.
   */
  it("offers the help of the explanation field beside its label", async () => {
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    const row = (await screen.findAllByText("Explanation")).find((el) => el.tagName === "SPAN");
    expect(within(row!.parentElement!).getByRole("button", { name: "Help" })).toBeInTheDocument();
  }, 20_000);

  it("gives every <label for> of the screen a control to point at", async () => {
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByLabelText("Statement");
    expect(labelIssues()).toEqual([]);
  }, 20_000);
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

  it("gives every <label for> of the screen a control to point at", async () => {
    mockFetch(routes(codeDetail()));
    renderWithProviders(<QuestionEditor id="q2" navigate={vi.fn()} />);
    await screen.findByLabelText("Starting code");
    expect(labelIssues()).toEqual([]);
  }, 20_000);

  /*
   * "Try the reference solution". The mock question says `runtime: "backend"`,
   * so the screen posts the reference as an ANSWER — one region per editable
   * part of the template — and turns the server's GRADING into the verdict the
   * editor shows. The browser branch (`runtime: "runno"`) is the student's own
   * path and is covered by `runner/index.test.ts`.
   */
  it("tries the reference solution through the server, as regions", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(codeDetail(), {
        "POST /app/api/questions/q2/try": ok({
          status: "graded",
          points: 1,
          maxPoints: 1,
          solution: null,
          details: {
            runner: "ok",
            compile: { ok: true, stderr: "", ms: 4 },
            cases: [{ name: "cas 1", visible: true, points: 1, ok: true, exitCode: 0, ms: 3, timedOut: false, oom: false }],
            earned: 1,
            total: 1,
            sourceSha256: null,
          },
        }),
      }),
    );
    renderWithProviders(<QuestionEditor id="q2" navigate={vi.fn()} />);
    await screen.findByLabelText("Starting code");

    await user.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(await screen.findByText("1 of 1 cases pass.")).toBeInTheDocument();
    // The template is one editable region and the reference was never
    // written, so "try" runs what the reference editor shows: the template.
    expect(calls.find((c) => c.url === "/app/api/questions/q2/try")?.body).toEqual({
      source: "draft",
      answer: { regions: ["int somme(void) {\n    return 0;\n}\n"] },
    });
  });

  it("says the runner is off rather than failing, when it is", async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(codeDetail(), {
        "POST /app/api/questions/q2/try": ok({
          status: "runner_unavailable",
          reason: "stub",
        }),
      }),
    );
    renderWithProviders(<QuestionEditor id="q2" navigate={vi.fn()} />);
    await screen.findByLabelText("Starting code");
    await user.click(screen.getByRole("button", { name: "Try the reference solution" }));
    expect(
      await screen.findByText(
        "The runner is unavailable, so the reference solution cannot be tried right now.",
      ),
    ).toBeInTheDocument();
  });
});

describe("QuestionEditor — keyboard", () => {
  it("teaches its shortcuts through the sidebar strip, not through a sentence", async () => {
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    // The page itself says nothing about the keys any more: the frame does
    // (Shell.test.tsx), and it follows the focus.
    expect(screen.queryByText(/Ctrl\+S/)).toBeNull();
    // The explanation keeps its label and loses the sentence above it.
    expect(await screen.findByLabelText("Explanation")).toBeInTheDocument();
    expect(screen.queryByText(/Shown to the student after grading/)).toBeNull();
  }, 20_000);

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

  /*
   * W14: `docs/spec/08` §8.5 lists Ctrl+Enter as "Essayer la question" and it
   * was not implemented. It saves first (the Try tab runs what the SERVER
   * holds) and takes the focus with it — a shortcut that moves the screen and
   * leaves the caret behind has moved half the reader.
   */
  it("Ctrl+Enter switches to the Try tab and moves the focus into it", async () => {
    const user = userEvent.setup();
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    expect(screen.getByRole("tab", { name: "Edit" })).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Try" })).toHaveAttribute("aria-selected", "true"),
    );
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "question-panel-try");
    expect(panel).toHaveFocus();
  });

  /*
   * "Student preview" leaves the editor: it opens `/questions/:id/preview` in
   * a TAB of its own. It used to toggle a panel at the bottom of the right
   * column of the Edit tab, which is why the teacher who pressed it saw
   * nothing happen — from the Try tab it really did nothing.
   */
  it("opens the student preview in a new tab, and saves the draft first", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    // Nothing of the preview is rendered in the page any more.
    expect(screen.queryByRole("heading", { name: "Student preview" })).toBeNull();

    const link = screen.getByRole("link", { name: "Student preview" });
    expect(link).toHaveAttribute("href", "/questions/q1/preview");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener");
    // The tab reads what the SERVER holds, so an edit in flight is flushed
    // before it opens.
    await user.type(await screen.findByLabelText("Statement"), "?");
    await user.click(link);
    await waitFor(() =>
      expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/draft"))).toBe(true),
    );
  });

  it("Ctrl+Shift+M opens the same tab", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    mockFetch(routes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    await user.keyboard("{Control>}{Shift>}M{/Shift}{/Control}");
    expect(open).toHaveBeenCalledWith("/questions/q1/preview", "_blank", "noopener");
    open.mockRestore();
  });
});

/*
 * A pool shared with me as `reader` (F-POOL sharing): the question is there to
 * be READ — that is what sharing is for — so nothing is hidden but the actions
 * the server would refuse, and the Try tab, which writes nothing, stays live.
 */
describe("QuestionEditor — shared as reader", () => {
  const readerRoutes = (detail: QuestionDetail) =>
    routes(detail, { "GET /app/api/pools/p1": ok({ ...POOL, role: "reader" as const }) });

  it("says so in the header and drops every action that would be refused", async () => {
    mockFetch(readerRoutes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    expect(
      await screen.findByText("Read-only — shared with you as reader"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    // The one thing a reader may still do with the screen.
    expect(screen.getByRole("link", { name: "Student preview" })).toBeInTheDocument();
  });

  it("disables the type's editor and the properties panel", async () => {
    mockFetch(readerRoutes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    // The badge is the proof the ROLE has landed: until the pool detail is
    // there the screen knows nothing and stays as it was.
    await screen.findByText("Read-only — shared with you as reader");
    expect(await screen.findByRole("button", { name: "Add a choice" })).toBeDisabled();
    expect(screen.getByLabelText("Internal name")).toBeDisabled();
    expect(screen.getByLabelText("Category")).toBeDisabled();
  }, 20_000);

  it("sends no draft, not even on Ctrl+S, and never opens the publish dialog", async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(readerRoutes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });

    await user.keyboard("{Control>}s{/Control}");
    await user.keyboard("{Control>}{Shift>}P{/Shift}{/Control}");
    await new Promise((resolve) => setTimeout(resolve, AUTOSAVE_DELAY_MS * 3));

    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("still lets a reader try the question", async () => {
    const user = userEvent.setup();
    mockFetch(readerRoutes(mcqDetail()));
    renderWithProviders(<QuestionEditor id="q1" navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "ptr-null-check" });
    await user.click(screen.getByRole("tab", { name: "Try" }));
    expect(await screen.findByRole("heading", { name: "Try the question" })).toBeInTheDocument();
  }, 20_000);
});

describe("QuestionEditor — opened from an evaluation (#127)", () => {
  const EVAL = "0f0e0d0c-0b0a-4908-8706-050403020100";

  it("leads back to the evaluation it was opened from, by name", async () => {
    const user = userEvent.setup();
    const base = makeEvaluationDetail();
    mockFetch(
      routes(mcqDetail(), {
        [`GET /app/api/evaluations/${EVAL}`]: ok({
          ...base,
          evaluation: { ...base.evaluation, id: EVAL, title: "Test 0 — bases du C" },
        }),
      }),
    );
    const navigate = vi.fn();
    renderWithProviders(<QuestionEditor id="q1" navigate={navigate} />, {
      route: `/questions/q1?from=${EVAL}`,
    });

    await user.click(await screen.findByRole("button", { name: /back to test 0 — bases du c/i }));
    expect(navigate).toHaveBeenCalledWith({ view: "evaluation", id: EVAL });
  });

  it("leads back to the pool without one", async () => {
    const user = userEvent.setup();
    mockFetch(routes(mcqDetail()));
    const navigate = vi.fn();
    renderWithProviders(<QuestionEditor id="q1" navigate={navigate} />);

    await user.click(await screen.findByRole("button", { name: "Programmation C" }));
    expect(navigate).toHaveBeenCalledWith({ view: "pool", id: "p1" });
  });
});
