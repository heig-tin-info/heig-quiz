import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { AssignStationDialog } from "./AssignStation";

const EVALUATION = "22222222-2222-4222-8222-222222222222";
const STUDENT = "33333333-3333-4333-8333-333333333333";
const URL = `POST /app/api/evaluations/${EVALUATION}/kiosk-assign`;

function render(reply: ReturnType<typeof ok>) {
  const stub = mockFetch({ [URL]: reply });
  const onDone = vi.fn();
  const onClose = vi.fn();
  renderWithProviders(
    <AssignStationDialog evaluationId={EVALUATION} userId={STUDENT} name="Léa Martin" onDone={onDone} onClose={onClose} />,
  );
  return { ...stub, onDone, onClose };
}

afterEach(() => vi.unstubAllGlobals());

describe("assigning a station from the dashboard (ADR-051 §7)", () => {
  it("formats the code as typed, sends it for the row's student, and names the station", async () => {
    const { calls, onDone } = render(ok({ station: { label: "Poste de secours n° 7" } }));
    expect(screen.getByRole("dialog", { name: "Assign a station to Léa Martin" })).toBeInTheDocument();
    const field = screen.getByLabelText("Code shown on the station");
    await userEvent.type(field, "bcdfghjk");
    expect(field).toHaveValue("BCDF-GHJK");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ userCode: "BCDF-GHJK", userId: STUDENT });
    expect(onDone).toHaveBeenCalledWith("Poste de secours n° 7");
  });

  it("refuses a malformed code without asking the server", async () => {
    const { calls } = render(ok({ station: { label: "x" } }));
    await userEvent.type(screen.getByLabelText("Code shown on the station"), "bcd");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(screen.getByText(/A code has 8 letters and digits/)).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("says a wrong code and a student who cannot sit it apart", async () => {
    render(fail(404, { error: "pairing_not_found" }));
    await userEvent.type(screen.getByLabelText("Code shown on the station"), "BCDFGHJK");
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText(/This code does not work/)).toBeInTheDocument();
    vi.unstubAllGlobals();
    mockFetch({ [URL]: fail(409, { error: "evaluation_not_pairable" }) });
    await userEvent.click(screen.getByRole("button", { name: "Assign" }));
    expect(await screen.findByText("Léa Martin cannot start this exam on a station now.")).toBeInTheDocument();
  });
});
