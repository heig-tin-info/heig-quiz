import type { GradebookStaff } from "@quiz/contracts";
import { describe, expect, it } from "vitest";

import { gradebookCsv } from "./csv.js";

describe("gradebookCsv", () => {
  /**
   * #1224: a comma in an activity's or a component's name would cut the header
   * and the `component` line in a spreadsheet splitting on commas. Both carry
   * the same comma-free label, so the line still reads against the header.
   */
  it("writes no comma in the header nor in the component line", () => {
    const table = {
      components: [{ id: "k", name: "Labo, TP", weight: 40, classMean: null }],
      columns: [{ activityId: "a", title: "Test 1, pointeurs", released: false, componentId: "k", counts: true, weight: 100, classMean: null }],
      rows: [],
      classMean: null,
    } as unknown as GradebookStaff;
    expect(gradebookCsv(table).split("\r\n").slice(0, 2)).toEqual([
      "\uFEFFemail;last_name;first_name;Test 1 pointeurs (unreleased);Labo TP;mean",
      "component;;;Labo TP;;",
    ]);
  });
});
