import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RosterImport, spreadsheetRows } from "./RosterImport";
import { candidatesFor } from "./test/candidates";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The "Add students" sheet. Its one hard case is a partly rejected import:
 * the offending lines have to be readable next to where the file was given,
 * and the footer has to say something rather than stay blank.
 */

const ROSTER = "/app/api/classrooms/c1/roster";

const errors = [
  { line: 3, message: "missing e-mail" },
  { line: 7, message: "duplicate e-mail" },
];

const openSheet = (reply: ReturnType<typeof ok>) => {
  const stub = mockFetch({ [`POST ${ROSTER}`]: reply });
  renderWithProviders(<RosterImport classroomId="c1" onClose={vi.fn()} />, {
    route: "/classrooms/c1?tab=students",
  });
  return stub;
};

const pasteAndImport = async () => {
  await userEvent.type(screen.getByLabelText("Pasted CSV"), "Dupont,Marie,marie@heig-vd.ch");
  await userEvent.click(screen.getByRole("button", { name: /Import CSV/ }));
};

describe("RosterImport rejected lines", () => {
  it("lists them under the drop zone and counts them in the footer", async () => {
    openSheet(fail(422, { message: "Some lines were rejected", errors }));
    await pasteAndImport();

    const first = await screen.findByText(/line 3: missing e-mail/);
    expect(screen.getByText(/line 7: duplicate e-mail/)).toBeVisible();
    // Under the drop zone, where the file was let go: at the bottom of the
    // sheet the list was off screen on a phone.
    const dropZone = screen.getByRole("button", { name: "Drop a roster file" });
    expect(dropZone.parentElement?.contains(first)).toBe(true);

    // The footer used to show nothing at all in this case.
    expect(screen.getByText("2 lines rejected, detailed above.")).toBeVisible();
  });

  it("keeps the plain failure line when the server names no line", async () => {
    openSheet(fail(500, { message: "database is down" }));
    await pasteAndImport();
    expect(await screen.findByText("Import failed.")).toBeVisible();
  });

  it("says the import is done when it went through", async () => {
    openSheet(ok({ imported: 1 }));
    await pasteAndImport();
    await waitFor(() => expect(screen.getByText("Import done")).toBeVisible());
  });
});

describe("RosterImport one student (ADR-133)", () => {
  const CANDIDATES = "/app/api/classrooms/c1/roster/candidates";
  const LINE = "POST /app/api/classrooms/c1/roster/line";
  const lea = { givenName: "Léa", familyName: "Rochat", email: "lea.rochat@heig-vd.ch" };

  const open = (stubs: Parameters<typeof mockFetch>[0]) => {
    const stub = mockFetch(stubs);
    const onClose = vi.fn();
    renderWithProviders(<RosterImport classroomId="c1" onClose={onClose} />, {
      route: "/classrooms/c1?tab=students",
    });
    return { ...stub, onClose };
  };
  const field = () => screen.getByRole("combobox", { name: /Name or e-mail/ });
  const posted = (calls: { method: string; url: string; body: unknown }[]) =>
    calls.filter((c) => c.method === "POST").map((c) => c.body);

  it("adds a person picked by name, with the school address shown, by a click", async () => {
    const { calls } = open({ ...candidatesFor(CANDIDATES, "roch", [lea]), [LINE]: ok({ ok: true }) });
    await userEvent.type(field(), "roch");
    await userEvent.click(await screen.findByRole("option", { name: /Léa Rochat/ }));
    // The address names the pick on the label line: two homonyms differ there.
    expect(screen.getByText("lea.rochat@heig-vd.ch")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(posted(calls)).toEqual([{ email: "lea.rochat@heig-vd.ch", picked: true, timeBonusPercent: 0 }]));
    expect(await screen.findByText("Added: Léa Rochat")).toBeVisible();
  });

  it("never adds on Enter: Enter only picks the highlighted match", async () => {
    const { calls } = open(candidatesFor(CANDIDATES, "rochat", [lea]));
    await userEvent.type(field(), "rochat");
    await screen.findByRole("option", { name: /Léa Rochat/ });
    await userEvent.keyboard("{Enter}");
    expect(field()).toHaveValue("Léa Rochat");
    await userEvent.keyboard("{Enter}");
    expect(posted(calls)).toEqual([]);
  });

  it("adds a typed address nobody was picked from, nameless", async () => {
    const { calls } = open({ ...candidatesFor(CANDIDATES, "new@school.test", []), [LINE]: ok({ ok: true }) });
    await userEvent.type(field(), "New@school.test");
    await userEvent.type(screen.getByLabelText("Extra time (%)"), "25");
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));
    await waitFor(() => expect(posted(calls)).toEqual([{ email: "new@school.test", picked: false, timeBonusPercent: 25 }]));
  });

  it("waits for three letters, blanks aside, before it searches", async () => {
    const { calls } = open({});
    await userEvent.type(field(), "a b");
    expect(await screen.findByText("Type three letters of a name or of a school address.")).toBeVisible();
    expect(calls.filter((c) => c.url.includes("/roster/candidates"))).toEqual([]);
  });

  it("says that nobody of the school matches, and that an address is added as typed", async () => {
    open(candidatesFor(CANDIDATES, "dupont", []));
    await userEvent.type(field(), "dupont");
    expect(await screen.findByText(/No one of your school matches “dupont”/)).toBeVisible();
  });

  it("closes the open list on Escape, not the sheet", async () => {
    const { onClose } = open(candidatesFor(CANDIDATES, "roch", [lea]));
    await userEvent.type(field(), "roch");
    await screen.findByRole("option", { name: /Léa Rochat/ });
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("says a pick that is no longer offered", async () => {
    open({ ...candidatesFor(CANDIDATES, "roch", [lea]), [LINE]: fail(404, { error: "student_not_found" }) });
    await userEvent.type(field(), "roch");
    await userEvent.click(await screen.findByRole("option", { name: /Léa Rochat/ }));
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(await screen.findByText(/can no longer be added from the search/)).toBeVisible();
  });
});

describe("spreadsheetRows", () => {
  // The dropped file is read in the browser; what reaches the API is these
  // rows, so the reader's quirks have to be settled here.
  const roster = async (format: "xlsx" | "ods") => {
    const { write } = await import("hucre");
    const bytes = await write({
      sheets: [
        {
          name: "Liste",
          rows: [
            ["Nom", "Prénom", "E-mail", "Temps sup."],
            ["Dupont", "Marie", "marie@heig-vd.ch", 1.5],
            ["Rochat", "Léa", "lea@heig-vd.ch", 0.25],
            ["Muller", "Jean", null, 25],
          ],
          cells: new Map([
            ["1,3", { style: { numFmt: "0%" } }],
            ["2,3", { style: { numFmt: "0%" } }],
          ]),
        },
      ],
      format,
    });
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  };

  it.each(["xlsx", "ods"] as const)("reads a %s roster as the teacher sees it", async (format) => {
    expect(await spreadsheetRows(await roster(format))).toEqual([
      ["Nom", "Prénom", "E-mail", "Temps sup."],
      // "150 %" is stored as 1.5, which the roster would read as 1.5 %.
      ["Dupont", "Marie", "marie@heig-vd.ch", 150],
      ["Rochat", "Léa", "lea@heig-vd.ch", 25],
      ["Muller", "Jean", null, 25],
    ]);
  });
});
