import { describe, expect, it, vi } from "vitest";

import { boundKeys, claimedKeys } from "@quiz/ui/testing";

import { editorKey, SHORTCUT_LINES, UNLISTED_KEYS, type KeyActions } from "./useSelection.js";

/**
 * One press through `editorKey`, every action a spy: what it did is the
 * actions it called, or that it only swallowed the key.
 */
function press(key: string, mod: boolean, shift: boolean): string {
  const spies = {
    undo: vi.fn(),
    redo: vi.fn(),
    duplicate: vi.fn(),
    selectAll: vi.fn(),
    transform: vi.fn(),
    toggleWire: vi.fn(),
    remove: vi.fn(),
    escape: vi.fn(() => true),
    arm: vi.fn(),
  } satisfies KeyActions;
  const preventDefault = vi.fn();
  editorKey({ key, target: null, ctrlKey: mod, metaKey: false, shiftKey: shift, preventDefault }, spies, false);
  const called = Object.entries(spies).filter(([, spy]) => spy.mock.calls.length > 0).map(([name]) => name);
  return called.length > 0 ? called.join() : preventDefault.mock.calls.length > 0 ? "prevented" : "";
}

describe("the circuit editor's shortcut lines (issue #549)", () => {
  it("cover every key the editor answers to, and show none it ignores", () => {
    expect(claimedKeys(SHORTCUT_LINES, UNLISTED_KEYS)).toEqual(boundKeys(press));
  });

  it("fit the zone: five lines at most", () => {
    expect(SHORTCUT_LINES.length).toBeLessThanOrEqual(5);
  });
});
