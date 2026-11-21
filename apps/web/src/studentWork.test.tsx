import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { en } from "./i18n/en";
import { studentWorkIn, studentWorkText, useStudentWorkRefusal, type StudentWorkKind } from "./studentWork";
import { renderWithProviders } from "./test/render";

/*
 * A deletion refused because the entity holds students' work (ADR-141): the
 * 409 read through its contract, worded per kind, and shown in a dialog that
 * offers Archive where the entity has one and only closes otherwise.
 */

const work = { classrooms: 2, evaluations: 3, projects: 1, attempts: 40, gradedRepos: 5, released: 1 };
const refusal = new ApiError(409, { error: "holds_student_work", message: "m", work });
const t = (key: keyof typeof en, vars?: Record<string, string | number>) =>
  en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k]));

describe("studentWorkIn", () => {
  it("reads what blocks from the 409, and nothing from any other error", () => {
    expect(studentWorkIn(refusal)).toEqual(work);
    expect(studentWorkIn(new ApiError(409, { error: "confirm_mismatch" }))).toBeNull();
    expect(studentWorkIn(new ApiError(500, { error: "holds_student_work", message: "m", work }))).toBeNull();
    expect(studentWorkIn(new Error("offline"))).toBeNull();
  });
});

describe("studentWorkText", () => {
  it("says what blocks, by kind, and where to go instead", () => {
    expect(studentWorkText(t, "evaluation", work)).toBe("Students have started this evaluation or received its results.");
    expect(studentWorkText(t, "project", work)).toBe("This project has graded students' repositories or released scores. Archive it instead.");
    expect(studentWorkText(t, "classroom", work)).toBe("Activities with students' work: 4. Archive the classroom instead.");
    expect(studentWorkText(t, "course", work)).toBe("Classrooms with students' work: 2. Archive its classrooms instead.");
  });
});

function Probe({ kind, archive, otherwise }: { kind: StudentWorkKind; archive?: () => void; otherwise: (e: unknown) => void }) {
  const refused = useStudentWorkRefusal();
  return (
    <button type="button" onClick={() => refused(kind, { archive, otherwise })(refusal)}>
      fail
    </button>
  );
}

describe("useStudentWorkRefusal", () => {
  it("offers Archive where the entity has one, and runs it", async () => {
    const archive = vi.fn();
    renderWithProviders(<Probe kind="project" archive={archive} otherwise={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "fail" }));
    const dialog = await screen.findByRole("dialog", { name: "Deletion refused" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(archive).toHaveBeenCalledOnce();
  });

  it("only closes where there is no archive (a course, an evaluation)", async () => {
    const otherwise = vi.fn();
    renderWithProviders(<Probe kind="course" otherwise={otherwise} />);
    await userEvent.click(screen.getByRole("button", { name: "fail" }));
    const dialog = await screen.findByRole("dialog", { name: "Deletion refused" });
    expect(dialog).toHaveTextContent("Classrooms with students' work: 2.");
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).toBeNull();
    // The footer's one button, beside the X of the dialog's header.
    await userEvent.click(within(dialog).getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(otherwise).not.toHaveBeenCalled();
  });
});
