import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChangelogList, Me } from "@quiz/contracts";

import App from "../App";
import { resetEventStream } from "../realtime/useEventStream";
import { makeMe } from "../test/fixtures";
import { mockFetch, ok, renderWithProviders } from "../test/render";

/*
 * What's new (ADR-087) as the app mounts it: on the home and the lists only,
 * never over an attempt or a live run, never for a session other than the
 * account's own portal one; closed is read.
 */

const EVAL = "11111111-1111-4111-8111-111111111111";
const UNSEEN: ChangelogList = [
  {
    id: "conditions-moved",
    kind: "moved",
    text: { en: "Conditions now live in the course **Settings**.", fr: "Les conditions sont dans les **Réglages**." },
    liveAt: "2026-10-09T08:00:00.000Z",
    commitSha: "ad87b7d2c0ffee",
  },
];

class FakeStream {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

function render(route: string, me: Me = makeMe({ role: "teacher" }), { unseen = UNSEEN, all = UNSEEN } = {}) {
  vi.stubGlobal("EventSource", FakeStream);
  const mock = mockFetch({
    "GET /app/api/me": ok(me),
    "GET /app/api/courses": ok([]),
    "GET /app/api/pools": ok([]),
    "GET /app/api/changelog/unseen": ok(unseen),
    "GET /app/api/changelog": ok(all),
    "POST /app/api/me/changelog": { status: 204, body: undefined },
  });
  return { ...mock, ...renderWithProviders(<App />, { route }) };
}

afterEach(() => {
  resetEventStream();
  sessionStorage.clear();
  vi.stubGlobal("EventSource", undefined);
});

const asked = (calls: { method: string; url: string }[]) =>
  calls.some((c) => c.method === "GET" && c.url === "/app/api/changelog/unseen");

describe("What's new", () => {
  it("opens on the home, grouped by release, and is acknowledged once closed", async () => {
    const { calls } = render("/");
    const dialog = await screen.findByRole("dialog", { name: "What's new" });
    expect(within(dialog).getByText("Moved")).toBeVisible();
    expect(within(dialog).getByText("ad87b7d")).toBeVisible();
    expect(within(dialog).getByText("Settings").tagName).toBe("STRONG");
    // The one action holds the focus, not the close button.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Got it" })).toHaveFocus());

    await userEvent.click(within(dialog).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.filter((c) => c.method === "POST" && c.url === "/app/api/me/changelog")).toHaveLength(1);
  });

  it.each([`/evaluations/${EVAL}/live`, "/settings"])("never opens on %s", async (route) => {
    const { calls } = render(route);
    // Asked (the coach waits on it), but not shown off the allow-list.
    await waitFor(() => expect(asked(calls)).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
  });

  it("never opens over an attempt", async () => {
    const { calls } = render(`/take/${EVAL}`, makeMe({ role: "student" }));
    await waitFor(() => expect(calls.some((c) => c.url.endsWith(`/evaluations/${EVAL}/attempt`))).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
  });

  it("is not even asked by an impersonation", async () => {
    const session = {
      kind: "impersonation" as const,
      evaluationId: null,
      projectId: null,
      readOnly: true,
      superPowersUntil: null,
      superPowersAvailable: false,
    };
    const { calls } = render("/", makeMe({ role: "student", session }));
    await waitFor(() => expect(calls.some((c) => c.url === "/app/api/me")).toBe(true));
    await new Promise((r) => setTimeout(r, 50));
    expect(asked(calls)).toBe(false);
    expect(screen.queryByRole("dialog", { name: "What's new" })).toBeNull();
  });

  it("lists every entry on its page, from the account menu, ", async () => {
    render("/", makeMe({ role: "teacher" }), { unseen: [] });
    await userEvent.click((await screen.findAllByRole("button", { name: "User menu" }))[0]!);
    await userEvent.click(await screen.findByRole("menuitem", { name: "What's new" }));
    expect(await screen.findByRole("heading", { name: "What's new", level: 1 })).toBeVisible();
    expect(await screen.findByRole("heading", { name: "2026-10-09 · ad87b7d", level: 2 })).toBeVisible();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says so when there is nothing to list", async () => {
    render("/whats-new", makeMe({ role: "student" }), { unseen: [], all: [] });
    expect(await screen.findByText("Nothing new yet")).toBeVisible();
  });
});
