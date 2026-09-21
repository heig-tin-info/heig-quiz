import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { PollPublicView } from "@quiz/contracts";

import { mockFetch, ok, fail, renderWithProviders } from "../test/render";
import { PollJoin } from "./PollJoin";
import { matchesExpected } from "./PollJoinReveal";

const CODE = "QZ4F7K";
const URL = `/app/api/p/${CODE}`;

const me = {
  id: "u1",
  email: "marie@heig-vd.ch",
  givenName: "Marie",
  familyName: "Dupont",
  role: "student" as const,
  lastLoginAt: null,
  avatarUrl: null,
  hasUploadedAvatar: false,
  locale: null,
  dateFormat: null,
  mcqPolicy: null,
};

const mcqStudent = {
  prompt: "Que vaut sizeof(char) ?",
  mode: "single",
  choices: [
    { id: 0, text: "1" },
    { id: 1, text: "4" },
  ],
};

function view(patch: Partial<PollPublicView> = {}): PollPublicView {
  return {
    code: CODE,
    title: "Échauffement",
    state: "running",
    settings: { anonymous: true, revealed: false },
    question: { type: "mcq", student: mcqStudent },
    solution: null,
    me: { identified: true, loginRequired: false, joined: true, answer: null },
    ...patch,
  };
}

const render = (routes: Parameters<typeof mockFetch>[0], props: Partial<Parameters<typeof PollJoin>[0]> = {}) => {
  const stub = mockFetch(routes);
  const navigate = vi.fn();
  const result = renderWithProviders(
    <PollJoin code={CODE} me={props.me ?? null} navigate={props.navigate ?? navigate} />,
    { route: `/p/${CODE}` },
  );
  return { ...result, ...stub, navigate };
};

describe("the poll participant page", () => {
  it("shows the code field when no poll answers to that code", async () => {
    const { navigate } = render({ [`GET ${URL}`]: fail(404, { message: "No poll" }) });

    expect(await screen.findByRole("heading", { name: "No poll with this code" })).toBeVisible();
    await userEvent.type(screen.getByLabelText("Session code"), "nm2x9a");
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(navigate).toHaveBeenCalledWith({ view: "join", code: "NM2X9A" });
  });

  it("offers one way in when the poll is not anonymous and nobody is signed in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, search: "" });
    render({
      [`GET ${URL}`]: ok(
        view({
          settings: { anonymous: false, revealed: false },
          me: { identified: false, loginRequired: true, joined: false, answer: null },
        }),
      ),
      "GET /app/api/config": ok({ devLogin: false }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Log in to answer" }));
    expect(assign).toHaveBeenCalledWith("/app/auth/login?next=%2Fp%2FQZ4F7K");
    // The gate is a gate: nothing was joined behind it.
    expect(screen.queryByRole("button", { name: /Send/ })).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it("joins by itself, with no click, when the poll takes guests", async () => {
    const { calls } = render({
      [`GET ${URL}`]: ok(view({ me: { identified: true, loginRequired: false, joined: false, answer: null } })),
      [`POST ${URL}/join`]: ok(view()),
    });

    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${URL}/join`)).toBe(true));
  });

  it("sends the answer the type built, once, and then says so", async () => {
    const { calls } = render({
      [`GET ${URL}`]: ok(view()),
      [`POST ${URL}/answer`]: ok(view({ me: { identified: true, loginRequired: false, joined: true, answer: { selected: [0] } } })),
    });

    // Nothing to send until the question has been answered.
    const send = await screen.findByRole("button", { name: "Send" });
    expect(send).toBeDisabled();

    await userEvent.click(await screen.findByRole("radio", { name: "1" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(screen.getByText("Sent")).toBeVisible());
    const posted = calls.filter((c) => c.url === `${URL}/answer`);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual({ payload: { selected: [0] } });
    // A sent answer that has not changed offers nothing to press again.
    expect(screen.getByRole("button", { name: "Update" })).toBeDisabled();
  });

  it("reports a refused send and offers the retry", async () => {
    render({
      [`GET ${URL}`]: ok(view()),
      [`POST ${URL}/answer`]: fail(500, { message: "Boom" }),
    });

    await userEvent.click(await screen.findByRole("radio", { name: "1" }));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Your answer did not reach the server")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });

  it("draws the key, and no answer control, once the teacher reveals", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          settings: { anonymous: true, revealed: true },
          solution: { correct: [0] },
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [1] } },
        }),
      ),
    });

    expect(await screen.findByText("Correct answer")).toBeVisible();
    expect(screen.getByText("Your answer — wrong")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Send|Update/ })).not.toBeInTheDocument();
  });

  it("says an ended poll is over and locks the question", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          state: "ended",
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [0] } },
        }),
      ),
    });

    expect(await screen.findByText("This poll has ended")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Send|Update/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("radio", { name: "1" })).toBeDisabled());
  });

  it("names who is answering", async () => {
    const { unmount } = render({ [`GET ${URL}`]: ok(view()) });
    expect(await screen.findByText(/Answering anonymously/)).toBeVisible();
    unmount();

    render({ [`GET ${URL}`]: ok(view()) }, { me });
    expect(await screen.findByText(/Answering as Marie/)).toBeVisible();
    // An anonymous poll answered from an account says so rather than implying
    // the answer is untraceable.
    expect(screen.getByText(/but you are signed in/)).toBeVisible();
  });
});

describe("the short reveal's fold", () => {
  it("ignores case, spacing and the edges", () => {
    expect(matchesExpected("  O(LOG   n) ", ["O(log n)"])).toBe(true);
    expect(matchesExpected("O(n)", ["O(log n)"])).toBe(false);
    expect(matchesExpected("   ", ["O(log n)"])).toBe(false);
  });
});
