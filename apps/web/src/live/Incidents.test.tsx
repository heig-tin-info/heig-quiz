import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvaluationIncidents } from "@quiz/contracts";

import { EVALUATION_ID, id, makeDashboard } from "../test/live-fixtures";
import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { IncidentBadge, IncidentsModal, JournalSection } from "./Incidents";

/*
 * The integrity journal as the teacher reads it (ADR-088 §7): a neutral badge
 * on the row, the inspector's Journal section, the evaluation's list — and the
 * two empty states that say which empty it is.
 */

afterEach(() => vi.unstubAllGlobals());

const AT = "2026-10-09T08:41:07.000Z";

describe("IncidentBadge", () => {
  it("is absent with nothing to count", () => {
    renderWithProviders(<IncidentBadge count={0} name="Nadia" onOpen={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows the count, says it in its tooltip and opens the journal", async () => {
    const onOpen = vi.fn();
    renderWithProviders(<IncidentBadge count={3} name="Nadia" onOpen={onOpen} />);
    const badge = screen.getByRole("button", { name: "3 incidents for Nadia: open the journal" });
    expect(badge).toHaveAttribute("title", "3 incidents");
    expect(badge).toHaveTextContent("3");
    await userEvent.click(badge);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("speaks French", () => {
    renderWithProviders(<IncidentBadge count={1} name="Nadia" onOpen={vi.fn()} />, { locale: "fr" });
    expect(screen.getByRole("button")).toHaveAttribute("title", "1 incident");
  });
});

describe("JournalSection", () => {
  it("lists each incident with its kind and its duration or length, and the caveat", () => {
    renderWithProviders(
      <JournalSection
        incidents={[
          { kind: "left", at: AT, durationMs: 125_000 },
          { kind: "paste", at: AT, length: 312, afterFocusLoss: true },
          { kind: "left", at: AT, durationMs: null },
        ]}
      />,
    );
    expect(screen.getByText(/not proof/)).toBeInTheDocument();
    expect(screen.getAllByText("Left the page")).toHaveLength(2);
    expect(screen.getByText("2 min 05 s")).toBeInTheDocument();
    expect(screen.getByText("312 characters · just after leaving the page")).toBeInTheDocument();
    expect(screen.getByText("Still away")).toBeInTheDocument();
  });
});

describe("IncidentsModal", () => {
  const URL = `GET /app/api/evaluations/${EVALUATION_ID}/incidents`;
  const view = makeDashboard(3, 2);

  function list(incidents: EvaluationIncidents["incidents"]): EvaluationIncidents {
    return { incidents, serverNow: AT };
  }

  function open(nameOf = (row: { displayName: string }) => row.displayName, namesShown = true) {
    const onOpenRow = vi.fn();
    renderWithProviders(
      <IncidentsModal
        evaluationId={EVALUATION_ID}
        rows={view.rows}
        nameOf={nameOf}
        namesShown={namesShown}
        onOpenRow={onOpenRow}
        onClose={vi.fn()}
      />,
    );
    return onOpenRow;
  }

  it("names each entry as the grid does, and opens the student's paper", async () => {
    mockFetch({
      [URL]: ok(
        list([
          {
            attemptId: id("attempt", 1),
            userId: id("user", 1),
            displayName: "Nadia Roux 1",
            pseudonym: "Amber Lynx",
            incident: { kind: "left", at: AT, durationMs: 42_000 },
          },
        ]),
      ),
    });
    const onOpenRow = open(() => "Student 7", false);
    await userEvent.click(await screen.findByRole("button", { name: "Student 7" }));
    expect(onOpenRow).toHaveBeenCalledWith(view.rows[1]);
    expect(screen.queryByText("Nadia Roux 1")).toBeNull();
    expect(screen.getByText("42 s")).toBeInTheDocument();
  });

  it("names an entry the grid has no row for by its pseudonym while names are hidden, never its name", async () => {
    const off = {
      attemptId: id("attempt", 9),
      userId: id("user", 9),
      displayName: "Léa Moved",
      pseudonym: "Quiet Heron",
      incident: { kind: "left" as const, at: AT, durationMs: 42_000 },
    };
    mockFetch({ [URL]: ok(list([off])) });
    open(() => "Student 1", false);
    expect(await screen.findByText("Quiet Heron")).toBeInTheDocument();
    expect(screen.queryByText("Léa Moved")).toBeNull();
    // No row to open: plain text, not a button.
    expect(screen.queryByRole("button", { name: "Quiet Heron" })).toBeNull();
  });

  it("names it by its name once the names are shown", async () => {
    mockFetch({
      [URL]: ok(
        list([
          {
            attemptId: id("attempt", 9),
            userId: id("user", 9),
            displayName: "Léa Moved",
            pseudonym: "Quiet Heron",
            incident: { kind: "left", at: AT, durationMs: 42_000 },
          },
        ]),
      ),
    });
    open();
    expect(await screen.findByText("Léa Moved")).toBeInTheDocument();
  });

  it("shows the empty state of a quiet evaluation", async () => {
    mockFetch({ [URL]: ok(list([])) });
    open();
    expect(await screen.findByText("No incidents recorded")).toBeInTheDocument();
  });

  it("says when the journal cannot be read", async () => {
    mockFetch({ [URL]: fail(500, { message: "boom" }) });
    open();
    expect(await screen.findByText("Could not read the journal")).toBeInTheDocument();
  });
});
