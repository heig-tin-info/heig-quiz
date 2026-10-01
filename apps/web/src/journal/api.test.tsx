import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { JournalRepository } from "@quiz/contracts";

import { ApiError } from "../api";
import { mockFetch } from "../test/render";
import { journalRefusal, nameTakenSuggestion, REFRESH_GIVE_UP_MS, useJournalRefresh } from "./api";

/*
 * Refresh's wait (F-JRN-05): "Refreshing…" until the row's sync state or its
 * last synchronisation moves (the write's own refetch of an unchanged row
 * does not end it), and never longer than a minute. And the refusals, read
 * off the body by the contract's schemas.
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

function renderRefresh() {
  mockFetch({ "POST /app/api/classrooms/r1/journal/refresh": { status: 202 } });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(({ repo }) => useJournalRefresh("r1", repo, vi.fn()), {
    wrapper,
    initialProps: { repo: repository },
  });
}

describe("useJournalRefresh", () => {
  it("waits through an unchanged row, and ends when the row moves", async () => {
    const { result, rerender } = renderRefresh();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    rerender({ repo: { ...repository } });
    expect(result.current.refreshing).toBe(true);
    rerender({ repo: { ...repository, lastSyncedAt: "2026-10-01T10:00:00.000Z" } });
    expect(result.current.refreshing).toBe(false);
  });

  it("gives up after a minute when no hint comes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = renderRefresh();
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.refreshing).toBe(true));
    await act(() => vi.advanceTimersByTimeAsync(REFRESH_GIVE_UP_MS));
    expect(result.current.refreshing).toBe(false);
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
  });
});
