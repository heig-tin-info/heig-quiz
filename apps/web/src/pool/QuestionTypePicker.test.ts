import { describe, expect, it } from "vitest";
import { columnsFor } from "./QuestionTypePicker";

describe("columnsFor", () => {
  it("keeps a pair on two columns", () => {
    expect(columnsFor(1)).toBe(2);
    expect(columnsFor(2)).toBe(2);
  });

  it("picks the count that leaves the fewest empty cells, four on a tie", () => {
    expect([3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(columnsFor)).toEqual([3, 4, 3, 3, 4, 4, 3, 4, 4, 4]);
  });
});
