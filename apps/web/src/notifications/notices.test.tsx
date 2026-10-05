import { useQuery } from "@tanstack/react-query";
import { act, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "../api";
import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../test/render";
import { useNoticeToasts, type Notice } from "./notices";

/*
 * F-PROJ-21 (M3-09c): the notices of a page's data as it is re-read — the
 * first read after mount is the baseline (cached data shown before it is
 * not a read), an unchanged read says nothing, and a new query key starts
 * a new baseline.
 */

interface Counter {
  n: number;
}

const KEY = (id: string) => ["probe", id] as const;

/** Toasts "n rose to <n>" when `n` grows between two reads. */
const rose = (prev: Counter, next: Counter): Notice[] =>
  next.n > prev.n ? [{ key: "probe:rose", message: `n rose to ${next.n}` }] : [];

function Probe({ id }: { id: string }) {
  const query = useQuery<Counter>({ queryKey: KEY(id), queryFn: () => api(`/probe/${id}`) });
  useNoticeToasts(query, rose);
  return <span data-testid="n">{query.data?.n ?? "…"}</span>;
}

/** A fetch serving each probe id its own counter, read by the tests through `bump`. */
function serve(ids: string[]) {
  const counters = new Map(ids.map((id) => [id, { n: 1 }]));
  mockFetch(Object.fromEntries(ids.map((id) => [`GET /probe/${id}`, () => ok({ ...counters.get(id)! })])));
  return { bump: (id: string) => (counters.get(id)!.n += 1) };
}

describe("useNoticeToasts", () => {
  afterEach(() => vi.unstubAllGlobals());

  function setup(id = "a", queryClient = makeQueryClient()) {
    const view = renderWithProviders(<Probe id={id} />, { queryClient });
    const reread = (key = id) => act(() => queryClient.refetchQueries({ queryKey: KEY(key) }));
    return { view, queryClient, reread };
  }

  it("toasts nothing on the first read, a notice of what a re-read changed, nothing of an unchanged one", async () => {
    const { bump } = serve(["a"]);
    const { reread } = setup();
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("1"));
    expect(screen.queryByRole("status")).toBeNull();
    await reread();
    expect(screen.queryByRole("status")).toBeNull();
    bump("a");
    await reread();
    expect(await screen.findByText("n rose to 2")).toBeInTheDocument();
  });

  it("treats cached data shown at mount as no read: the first fetch after mount is the baseline", async () => {
    const { bump } = serve(["a"]);
    const queryClient = makeQueryClient();
    queryClient.setQueryData<Counter>(KEY("a"), { n: 0 });
    const { reread } = setup("a", queryClient);
    expect(screen.getByTestId("n")).toHaveTextContent("0");
    // The first fetch after mount: n went 0 → 1, and still no notice.
    await reread();
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("1"));
    expect(screen.queryByRole("status")).toBeNull();
    bump("a");
    await reread();
    expect(await screen.findByText("n rose to 2")).toBeInTheDocument();
  });

  it("starts a new baseline on another query key: the pages' data are never compared", async () => {
    const { bump } = serve(["a", "b"]);
    const { view, reread } = setup("a");
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("1"));
    bump("b");
    bump("b");
    view.rerender(<Probe id="b" />);
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("3"));
    expect(screen.queryByRole("status")).toBeNull();
    bump("b");
    await reread("b");
    expect(await screen.findByText("n rose to 4")).toBeInTheDocument();
  });

  it("replaces the standing notice of the same kind instead of stacking it", async () => {
    const { bump } = serve(["a"]);
    const { reread } = setup();
    await waitFor(() => expect(screen.getByTestId("n")).toHaveTextContent("1"));
    bump("a");
    await reread();
    await screen.findByText("n rose to 2");
    bump("a");
    await reread();
    await screen.findByText("n rose to 3");
    expect(screen.queryByText("n rose to 2")).toBeNull();
  });
});
