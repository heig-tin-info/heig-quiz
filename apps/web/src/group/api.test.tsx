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
import { placeOf, withMove, WriteHeld } from "./groupRules";

/*
 * The write queue of a set (M3-16a, W7): one request at a time, the cache
 * from the latest answer only, an error that ends the queue putting back
 * the last answer; held by a `409 needs_confirmation` (M3-16b) until the
 * page confirms or cancels.
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
  const { write, confirm, cancel } = result.current;
  return { qc, write, confirm, cancel, cached: () => qc.getQueryData<GroupSetDetail>(groupSetKey(SET_ID))! };
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

  describe("held by a confirmation (ADR-070 §6, M3-16b)", () => {
    const DIGEST = "a".repeat(64);
    const asked = (digest = DIGEST) => ({
      error: "needs_confirmation",
      message: "x",
      consequences: [],
      digest,
    });
    const bodyOf = (n: number) => JSON.parse(String(vi.mocked(fetch).mock.calls[n]![1]!.body)) as unknown;

    it("keeps the move drawn on a 409, rejects the writes queued behind it unsent, and confirms with the digest", async () => {
      const pending = deferredFetch();
      const { write, confirm, cached } = setup();
      let first!: Promise<GroupSetDetail>;
      let second!: Promise<GroupSetDetail>;
      act(() => {
        first = write(...move(chloe, GROUP_1));
        second = write(...move(emma, GROUP_2));
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => {
        pending[0]!.resolve(409, asked());
        await expect(first).rejects.toBeDefined();
        await expect(second).rejects.toBeInstanceOf(WriteHeld);
      });
      // Nothing more was sent; the held move is still drawn; a new write is refused at once.
      expect(pending).toHaveLength(1);
      expect(placeOf(cached(), chloe)).toBe(GROUP_1);
      await expect(write(...move(emma, GROUP_1))).rejects.toBeInstanceOf(WriteHeld);

      let confirmed!: Promise<GroupSetDetail>;
      act(() => {
        confirmed = confirm(setWrite.place(chloe, GROUP_1, DIGEST));
      });
      await waitFor(() => expect(pending).toHaveLength(2));
      expect(bodyOf(1)).toEqual({ groupId: GROUP_1, confirm: DIGEST });
      const answer = withMove(makeSet(), chloe, GROUP_1);
      await act(async () => {
        pending[1]!.resolve(200, answer);
        await confirmed;
      });
      expect(cached()).toEqual(answer);
    });

    it("is held again by a stale digest, and Cancel puts back the set as it was", async () => {
      const pending = deferredFetch();
      const { write, confirm, cancel, cached } = setup();
      let first!: Promise<GroupSetDetail>;
      act(() => {
        first = write(...move(chloe, GROUP_1));
      });
      await waitFor(() => expect(pending).toHaveLength(1));
      await act(async () => {
        pending[0]!.resolve(409, asked());
        await expect(first).rejects.toBeDefined();
      });
      let stale!: Promise<GroupSetDetail>;
      act(() => {
        stale = confirm(setWrite.place(chloe, GROUP_1, DIGEST));
      });
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => {
        pending[1]!.resolve(409, asked("b".repeat(64)));
        await expect(stale).rejects.toBeDefined();
      });
      // Held again, the move still drawn.
      expect(placeOf(cached(), chloe)).toBe(GROUP_1);
      await expect(write(...move(emma, GROUP_1))).rejects.toBeInstanceOf(WriteHeld);
      act(() => cancel());
      expect(placeOf(cached(), chloe)).toBeNull();
      // The hold is over: the next write is sent.
      act(() => void write(...move(emma, GROUP_2)).catch(() => undefined));
      await waitFor(() => expect(pending).toHaveLength(3));
    });
  });
});
