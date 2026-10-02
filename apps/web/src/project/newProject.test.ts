import { describe, expect, it } from "vitest";

import type { ProjectSourceDetail } from "@quiz/contracts";

import { ApiError } from "../api";
import { chosenBranches, emptyDraft, projectBody, refusalPlace, type ProjectDraft } from "./newProject";

const DETAIL: ProjectSourceDetail = {
  name: "labo",
  defaultBranch: "main",
  branches: ["main", "solution"],
  tree: [],
  truncated: false,
  suggestedProtected: ["criteria.yml"],
};
const draft = (over: Partial<ProjectDraft> = {}): ProjectDraft => ({
  ...emptyDraft(),
  name: "Labo",
  sourceRepo: "labo",
  deadlineLocal: "2099-06-01T12:00",
  ...over,
});

describe("the new project's body", () => {
  it("is the schema's, defaults filled", () => {
    const { body } = projectBody(draft(), DETAIL);
    expect(body).toMatchObject({ branches: ["main"], protectedFiles: ["criteria.yml"], graceMinutes: 30 });
  });

  it("asks for a source, and sends no branches nor protected files without its detail", () => {
    expect(projectBody(draft({ sourceRepo: "" }), DETAIL).missing).toEqual({ source: "project.missing.source" });
    const { body } = projectBody(draft(), undefined);
    expect(body).not.toHaveProperty("branches");
    expect(body?.protectedFiles).toEqual([]);
  });

  it("names every missing field at once, dates included", () => {
    const { missing } = projectBody(draft({ name: " ", sourceRepo: "", deadlineLocal: "" }), undefined);
    expect(missing).toEqual({
      name: "project.missing.name",
      source: "project.missing.source",
      deadline: "project.missing.deadline",
    });
  });

  it("refuses a name without a letter, a bad grace, a group size out of range", () => {
    const { missing } = projectBody(draft({ name: "--", graceMinutes: "x", groupMode: true, groupMaxSize: "99" }), DETAIL);
    expect(missing).toEqual({
      name: "project.missing.name",
      grace: "project.missing.grace",
      groupMaxSize: "project.missing.groupMaxSize",
    });
  });

  it("drops a chosen branch the source no longer has", () => {
    expect(chosenBranches(draft({ branches: ["gone"] }), DETAIL)).toEqual(["main"]);
    expect(chosenBranches(draft({ branches: ["solution", "gone", "main"] }), DETAIL)).toEqual(["solution", "main"]);
  });

  it("counts a duration in whole days, from 1 to 400", () => {
    expect(projectBody(draft({ deadlineKind: "duration", durationDays: "3" }), DETAIL).body).toMatchObject({
      durationMinutes: 3 * 1440,
    });
    for (const durationDays of ["", "0", "1.5", "401"]) {
      const { missing } = projectBody(draft({ deadlineKind: "duration", durationDays }), DETAIL);
      expect(missing).toEqual({ duration: "project.missing.duration" });
    }
  });
});

describe("where a refusal is said", () => {
  const refused = (status: number, body: unknown) => refusalPlace(new ApiError(status, body));

  it("places each code", () => {
    expect(refused(409, { error: "not_connected", message: "" })).toEqual({ at: "page", code: "not_connected" });
    expect(refused(422, { error: "source_not_found", message: "", branches: ["x"] })).toMatchObject({
      at: "field",
      field: "source",
      branches: ["x"],
    });
    expect(refused(422, { error: "deadline_past", message: "" })).toMatchObject({ field: "deadline" });
    expect(refused(409, { error: "duplicate_slug", message: "" })).toMatchObject({ field: "name" });
    expect(refused(502, { error: "distribution_failed", message: "" })).toMatchObject({ at: "form" });
  });

  it("leaves anything else to the ordinary failure", () => {
    expect(refused(500, { message: "boom" })).toBeNull();
    expect(refused(409, { error: "not_draft", message: "" })).toBeNull();
    expect(refusalPlace(new Error("network"))).toBeNull();
  });
});
