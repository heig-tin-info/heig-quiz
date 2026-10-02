import { describe, expect, it } from "vitest";

import type { ProjectSourceDetail } from "@quiz/contracts";

import { ApiError } from "../api";
import { chosenBranches, durationMinutes, emptyDraft, projectBody, refusalPlace, type ProjectDraft } from "./newProject";

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

  it("needs the source's detail", () => {
    expect(projectBody(draft(), undefined).missing).toEqual({ source: "project.source.detailFailed" });
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
      name: "project.missing.nameSlug",
      grace: "project.missing.grace",
      groupMaxSize: "project.missing.groupMaxSize",
    });
  });

  it("drops a chosen branch the source no longer has", () => {
    expect(chosenBranches(draft({ branches: ["gone"] }), DETAIL)).toEqual(["main"]);
    expect(chosenBranches(draft({ branches: ["solution", "gone", "main"] }), DETAIL)).toEqual(["solution", "main"]);
  });

  it("counts a duration in days and hours, and refuses one under 15 minutes", () => {
    expect(durationMinutes(draft({ durationDays: "1", durationHours: "2" }))).toBe(26 * 60);
    expect(durationMinutes(draft({ durationDays: "1.5" }))).toBeUndefined();
    const { missing } = projectBody(draft({ deadlineKind: "duration", durationDays: "0", durationHours: "0" }), DETAIL);
    expect(missing).toEqual({ duration: "project.missing.duration" });
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
