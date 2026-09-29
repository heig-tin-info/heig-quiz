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
  coach: { enabled: false, seen: [] },
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
    state: "running",
    settings: { anonymous: true, revealed: false, votes: false },
    question: { type: "mcq", student: mcqStudent },
    solution: null,
    tally: null,
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

  it("says a classroom's poll is for another class, and shows nothing of it", async () => {
    const { calls } = render({
      [`GET ${URL}`]: fail(403, {
        error: "not_on_roster",
        message: "This poll is for the students of its classroom",
      }),
    });
    expect(
      await screen.findByRole("heading", { name: "This poll is for another class" }),
    ).toBeVisible();
    expect(screen.getByText(/your account is not on its list/)).toBeVisible();
    // No join is attempted, and no retry offered: another account is the repair.
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("offers one way in when the poll is not anonymous and nobody is signed in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign, search: "" });
    render({
      [`GET ${URL}`]: ok(
        view({
          settings: { anonymous: false, revealed: false, votes: false },
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

  // Incident of 2026-09-29 (poll KUFE5R): a reveal hid the question and the
  // Send button, and the students who joined afterwards read "not allowed".
  // Only End closes the vote (ADR-014, addendum 2026-09-29).
  it("keeps the question and Send under a revealed key while the poll runs, with no verdict", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          settings: { anonymous: true, revealed: true, votes: false },
          solution: { correct: [0] },
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [1] } },
        }),
      ),
    });

    expect(await screen.findByText("Correct answer")).toBeVisible();
    // Still answerable: the choices and the button are there.
    expect(screen.getByRole("radio", { name: "1" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Update/ })).toBeInTheDocument();
    // No verdict while the answer may still change.
    expect(screen.queryByText(/— wrong|— correct/)).not.toBeInTheDocument();
    expect(screen.queryByText("You did not answer this poll.")).not.toBeInTheDocument();
  });

  it("lets a latecomer answer after the reveal, and says nothing about not having answered", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          question: { type: "short", student: { prompt: "Complexité de la recherche binaire ?" } },
          settings: { anonymous: true, revealed: true, votes: false },
          solution: { expected: ["O(log n)"] },
        }),
      ),
    });

    expect(await screen.findByText("Accepted answers")).toBeVisible();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByText("You did not answer this poll.")).not.toBeInTheDocument();
    expect(screen.queryByText("Your answer")).not.toBeInTheDocument();
  });

  it("names the verdict once the poll has ended", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          state: "ended",
          settings: { anonymous: true, revealed: true, votes: false },
          solution: { correct: [0] },
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [1] } },
        }),
      ),
    });

    expect(await screen.findByText("Correct answer")).toBeVisible();
    expect(screen.getByText("Your answer — wrong")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Send|Update/ })).not.toBeInTheDocument();
  });

  it("says an ended short poll went unanswered, and only then", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          state: "ended",
          question: { type: "short", student: { prompt: "Complexité de la recherche binaire ?" } },
          settings: { anonymous: true, revealed: true, votes: false },
          solution: { expected: ["O(log n)"] },
        }),
      ),
    });
    expect(await screen.findByText("You did not answer this poll.")).toBeVisible();
  });

  it("shows the live distribution while the votes are shown, beside a question still open", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          settings: { anonymous: true, revealed: false, votes: true },
          tally: { joined: 5, answered: 4, choices: [{ index: 0, count: 1 }, { index: 1, count: 3 }], answers: [] },
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [1] } },
        }),
      ),
    });

    expect(await screen.findByText("The results")).toBeVisible();
    expect(screen.getByText("25%")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    // Votes are not the key: nothing is marked right.
    expect(screen.queryByText("Correct answer")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Update/ })).toBeInTheDocument();
  });

  it("names only its own answer in the distribution of a poll with no key", async () => {
    render({
      [`GET ${URL}`]: ok(
        view({
          state: "ended",
          // A keyless poll never carries a key: the server reads a legacy
          // reveal as the votes (`pollSettingsOf`).
          settings: { anonymous: true, revealed: false, votes: true },
          solution: null,
          tally: { joined: 5, answered: 4, choices: [{ index: 0, count: 1 }, { index: 1, count: 3 }], answers: [] },
          me: { identified: true, loginRequired: false, joined: true, answer: { selected: [1] } },
        }),
      ),
    });

    expect(await screen.findByText("The results")).toBeVisible();
    expect(screen.getByText("25%")).toBeVisible();
    expect(screen.getByText("75%")).toBeVisible();
    expect(screen.getByText("Your answer")).toBeVisible();
    // Nothing is right, so nothing is wrong either.
    expect(screen.queryByText("Correct answer")).not.toBeInTheDocument();
    expect(screen.queryByText(/— wrong|— correct/)).not.toBeInTheDocument();
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
