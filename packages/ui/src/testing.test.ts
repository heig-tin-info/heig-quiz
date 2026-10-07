import { describe, expect, it } from "vitest";

import { boundKeys, claimedKeys } from "./testing.js";

/* The key probe itself, on a toy editor: Ctrl+Z undoes, Ctrl+Shift+Z redoes, Ctrl+Shift+D duplicates like Ctrl+D. */
describe("the key probe", () => {
  const toy = (key: string, mod: boolean, shift: boolean): string => {
    if (mod) return key === "z" ? (shift ? "redo" : "undo") : key === "d" ? "duplicate" : "";
    return key === "Delete" ? "delete" : key === " " ? "rotate" : key === "2" ? "arm 2" : "";
  };

  it("finds every key, and Shift only where it changes the chord", () => {
    expect(boundKeys(toy)).toEqual(["2", "Del", "Mod+D", "Mod+Shift+Z", "Mod+Z", "Space"]);
  });

  it("expands 1–9 to the editor's digits and adds the unlisted keys", () => {
    expect(claimedKeys([{ keys: ["Mod+Z", "Mod+Y"] }, { keys: ["1–9"] }], ["Esc"], 2)).toEqual(
      ["1", "2", "Esc", "Mod+Y", "Mod+Z"].sort(),
    );
  });
});
