import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { fail, mockFetch, ok, renderWithProviders } from "../test/render";
import { EnterCodeForm } from "./EnterCode";

/*
 * The student's one code field (ADR-045): the length says which code it is,
 * a poll's goes to the poll's page without a request, a classroom's to
 * `POST /join`, and anything else never leaves the browser.
 */
const render = () => {
  const navigate = vi.fn();
  const onDone = vi.fn();
  renderWithProviders(<EnterCodeForm navigate={navigate} onDone={onDone} />);
  return { navigate, onDone };
};

const submit = async (code: string) => {
  await userEvent.type(screen.getByLabelText("Code"), code);
  await userEvent.click(screen.getByRole("button", { name: "Join" }));
};

describe("EnterCodeForm", () => {
  it("opens the poll's own page for a six-character code, without a request", async () => {
    const { calls } = mockFetch({});
    const { navigate, onDone } = render();
    await submit("nm2 x9a");
    expect(navigate).toHaveBeenCalledWith({ view: "join", code: "NM2X9A" });
    expect(onDone).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(0);
  });

  it("joins the classroom of an eight-character code", async () => {
    const { calls } = mockFetch({
      "POST /app/api/join/K7PMQ2XR": ok({
        classroomId: "r1",
        classroomName: "PRG1-2026",
        courseCode: "PRG1",
        status: "joined",
      }),
    });
    const { navigate, onDone } = render();
    await submit("k7pm-q2xr");
    expect(await screen.findByText("You joined PRG1-2026.")).toBeInTheDocument();
    expect(calls.map((c) => `${c.method} ${c.url}`)).toContain("POST /app/api/join/K7PMQ2XR");
    expect(onDone).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("refuses any other length on the spot, and says what the field takes", async () => {
    const { calls } = mockFetch({});
    const { navigate, onDone } = render();
    await submit("ABC12");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("a classroom code has 8 characters, a poll code 6");
    expect(alert).toHaveTextContent("An exam's access code is typed on the exam's own page.");
    expect(screen.getByLabelText("Code")).toHaveAttribute("aria-invalid", "true");
    expect(calls).toHaveLength(0);
    expect(navigate).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("says no classroom answers to an unknown classroom code, and stays open", async () => {
    mockFetch({ "POST /app/api/join/K7PMQ2XR": fail(404, { error: "not_found" }) });
    const { onDone } = render();
    await submit("K7PMQ2XR");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("No classroom answers to this code.");
    expect(alert).toHaveTextContent("classroom code or a poll code");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("stays disabled while the field holds no character of a code", async () => {
    mockFetch({});
    render();
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Code"), " - ");
    expect(screen.getByRole("button", { name: "Join" })).toBeDisabled();
  });
});
