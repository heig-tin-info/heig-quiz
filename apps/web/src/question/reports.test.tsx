import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import type { QuestionReportRow } from "@quiz/contracts";

import { ReportBadge } from "../pool/ReportBadge";
import { mockFetch, ok, renderWithProviders } from "../test/render";
import { QuestionReportsTab, ReportDialog } from "./reports";

/*
 * Reports on a question (issue #680): the open-report indicator of the row,
 * the dialog any reader files one with, and the tab where a writer resolves.
 */

const Q = "00000000-0000-4000-8000-000000000001";
const P = "00000000-0000-4000-8000-0000000000f1";

const report = (over: Partial<QuestionReportRow> = {}): QuestionReportRow => ({
  id: "00000000-0000-4000-8000-0000000000a1",
  questionId: Q,
  reporterName: "Marc Dupont",
  mine: false,
  message: "The key is wrong",
  createdAt: "2026-10-09T08:00:00.000Z",
  resolvedAt: null,
  resolvedByName: null,
  resolution: "",
  ...over,
});

describe("ReportBadge", () => {
  it("says nothing when no report is open", () => {
    renderWithProviders(<ReportBadge count={0} />);
    expect(screen.queryByText(/report/i)).toBeNull();
  });

  it("counts the open reports", () => {
    renderWithProviders(<ReportBadge count={2} />);
    expect(screen.getByText("2 open reports")).toBeInTheDocument();
  });

  it("uses the singular for one", () => {
    renderWithProviders(<ReportBadge count={1} />);
    expect(screen.getByText("Open report")).toBeInTheDocument();
  });
});

describe("QuestionReportsTab", () => {
  it("offers a writer the Resolve action, and sends the optional reply", async () => {
    const { calls } = mockFetch({
      [`GET /app/api/questions/${Q}/reports`]: ok([report()]),
      [`POST /app/api/questions/${Q}/reports/${report().id}/resolve`]: ok({ ok: true }),
    });
    renderWithProviders(<QuestionReportsTab questionId={Q} poolId={P} canResolve />);
    expect(await screen.findByText("The key is wrong")).toBeInTheDocument();
    expect(screen.getByText("Marc Dupont")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Resolve" }));
    await userEvent.type(screen.getByLabelText("Reply to the reporter (optional)"), "Fixed in v3");
    const buttons = screen.getAllByRole("button", { name: "Resolve" });
    await userEvent.click(buttons[buttons.length - 1]!);

    const sent = calls.find((c) => c.method === "POST");
    expect(sent?.body).toEqual({ reply: "Fixed in v3" });
  });

  it("gives a reporter who does not write no action", async () => {
    mockFetch({
      [`GET /app/api/questions/${Q}/reports`]: ok([report({ mine: true, reporterName: "Me" })]),
    });
    renderWithProviders(<QuestionReportsTab questionId={Q} poolId={P} canResolve={false} />);
    expect(await screen.findByText("You")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("shows a resolved report with its reply and who closed it", async () => {
    mockFetch({
      [`GET /app/api/questions/${Q}/reports`]: ok([
        report({ resolvedAt: "2026-10-09T09:00:00.000Z", resolvedByName: "Yves", resolution: "Done" }),
      ]),
    });
    renderWithProviders(<QuestionReportsTab questionId={Q} poolId={P} canResolve />);
    expect(await screen.findByText("Resolved by Yves")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve" })).toBeNull();
  });

  it("says so when there is nothing to read", async () => {
    mockFetch({ [`GET /app/api/questions/${Q}/reports`]: ok([]) });
    renderWithProviders(<QuestionReportsTab questionId={Q} poolId={P} canResolve />);
    expect(await screen.findByText("No report on this question.")).toBeInTheDocument();
  });
});

describe("ReportDialog", () => {
  it("cannot send an empty message, then posts the trimmed one", async () => {
    const { calls } = mockFetch({
      [`POST /app/api/questions/${Q}/reports`]: ok(report({ mine: true })),
    });
    renderWithProviders(<ReportDialog questionId={Q} poolId={P} onClose={() => {}} />);
    const send = screen.getByRole("button", { name: "Send the report" });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("What is wrong?"), "  Typo in the statement ");
    await userEvent.click(send);
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ message: "Typo in the statement" });
  });
});
