import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JournalRepository } from "@quiz/contracts";

import { ApiError } from "../api";
import { journalKey } from "../queryKeys";
import { mockFetch } from "../test/render";
import { journalRefusal, nameTakenSuggestion, REFRESH_GIVE_UP_MS, REFRESH_POLL_MS, useJournalRefresh } from "./api";

/*
 * Refresh's wait (F-JRN-05): the copy is read again every few seconds while
 * the row has not moved, in case the `journal` hint is lost, and the wait
 * gives up after a minute rather than spinning for ever. And the refusals,
 * read off the body by the contract's schemas.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const repository: JournalRepository = {
  fullName: "heig-tin-info/prg1-journal",
  ref: "main",
  rootPath: "",
  htmlUrl: "https://github.com/heig-tin-info/prg1-journal",
  syncStatus: "ok",
  syncError: null,
  lastSyncedAt: "2026-09-30T10:00:00.000Z",
  lastCommitSha: null,
  editable: true,
};

describe("useJournalRefresh", () => {
  it("reads the journal again while it waits, and gives up after a minute", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch({ "POST /app/api/classrooms/r1/journal/refresh": { status: 202 } });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const onError = vi.fn();
    const { result } = renderHook(() => useJournalRefresh("r1", repository, onError), { wrapper });

    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    invalidate.mockClear();

    await act(() => vi.advanceTimersByTimeAsync(REFRESH_POLL_MS));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: journalKey("r1", "staff"), exact: true });
    expect(result.current.refreshing).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(REFRESH_GIVE_UP_MS));
    expect(result.current.refreshing).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("the refusals", () => {
  it("reads a refusal's code and a taken name's suggestion, and nothing from anything else", () => {
    const taken = new ApiError(409, { error: "name_taken", message: "name_taken", suggestion: "prg1-journal-0190d3c4" });
    expect(journalRefusal(taken)).toBe("name_taken");
    expect(nameTakenSuggestion(taken)).toBe("prg1-journal-0190d3c4");
    expect(journalRefusal(new ApiError(409, { error: "journal_attached" }))).toBeNull();
    expect(journalRefusal(new Error("network"))).toBeNull();
    expect(nameTakenSuggestion(new ApiError(409, { error: "conflict", message: "conflict" }))).toBeNull();
    expect(nameTakenSuggestion(null)).toBeNull();
  });
});
