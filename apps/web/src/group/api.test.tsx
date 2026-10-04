import { QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { GroupSetDetail } from "@quiz/contracts";

import { I18nProvider } from "../i18n";
import { ToastProvider } from "../notify";
import { groupSetKey } from "../queryKeys";
import { GROUP_1, GROUP_2, makeSet, SET_ID, student } from "../test/group-fixtures";
import { makeQueryClient } from "../test/render";
import { setWrite, useGroupSetWrites } from "./api";
import { placeOf, withMove } from "./groupRules";

/*
 * The write queue of a set (M3-16a, W7): one request at a time, the cache
 * from the latest answer only, an error that ends the queue putting back
 * the last answer.
 */

/** A `fetch` whose answers the test hands out one by one. */
function deferredFetch() {
  const pending: { url: string; resolve: (status: number, body: unknown) => void }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string) =>
        new Promise<Response>((done) => {
          pending.push({
            url,
            resolve: (status, body) =>
              done(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
          });
        }),
    ),
  );
  return pending;
}

function setup() {
  const qc = makeQueryClient();
  qc.setQueryData(groupSetKey(SET_ID), makeSet());
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <I18nProvider>
        <ToastProvider>{children}</ToastProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const { result } = renderHook(() => useGroupSetWrites(SET_ID), { wrapper });
  return { qc, write: result.current, cached: () => qc.getQueryData<GroupSetDetail>(groupSetKey(SET_ID))! };
}

const chloe = student(2).enrollmentId;
const emma = student(4).enrollmentId;
const move = (eid: string, gid: string | null) => [setWrite.place(eid, gid), (d: GroupSetDetail) => withMove(d, eid, gid)] as const;

describe("a set's write queue", () => {
  it("sends one write at a time, and an earlier answer never undoes a later move on screen", async () => {
    const pending = deferredFetch();
    const { write, cached } = setup();
    let first!: Promise<GroupSetDetail>;
    let second!: Promise<GroupSetDetail>;
    act(() => {
      first = write(...move(chloe, GROUP_1));
      second = write(...move(emma, GROUP_2));
    });
    // Both drawn at once; only the first sent.
    expect(placeOf(cached(), chloe)).toBe(GROUP_1);
    expect(placeOf(cached(), emma)).toBe(GROUP_2);
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0]!.url).toContain(`/members/${chloe}`);
    // The first answer knows nothing of the second move: the screen keeps it.
    await act(async () => {
      pending[0]!.resolve(200, withMove(makeSet(), chloe, GROUP_1));
      await first;
    });
    expect(placeOf(cached(), emma)).toBe(GROUP_2);
    // The second leaves only now, and its answer is the cache.
    await waitFor(() => expect(pending).toHaveLength(2));
    const last = withMove(withMove(makeSet(), chloe, GROUP_1), emma, GROUP_2);
    await act(async () => {
      pending[1]!.resolve(200, last);
      await second;
    });
    expect(cached()).toEqual(last);
  });

  it("puts back the previous answer when the last write is refused", async () => {
    const pending = deferredFetch();
    const { write, cached } = setup();
    let first!: Promise<GroupSetDetail>;
    let second!: Promise<GroupSetDetail>;
    act(() => {
      first = write(...move(chloe, GROUP_1));
      second = write(...move(emma, GROUP_2));
    });
    const answered = withMove(makeSet(), chloe, GROUP_1);
    await waitFor(() => expect(pending).toHaveLength(1));
    await act(async () => {
      pending[0]!.resolve(200, answered);
      await first;
    });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => {
      pending[1]!.resolve(409, { error: "classroom_archived", message: "x" });
      await expect(second).rejects.toBeDefined();
    });
    expect(placeOf(cached(), emma)).toBeNull();
    expect(placeOf(cached(), chloe)).toBe(GROUP_1);
  });
});
