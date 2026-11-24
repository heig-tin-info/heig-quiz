import { describe, expect, it } from "vitest";

import { notepadKey, saveNotes } from "../notepad/store";
import { documentsKey, emptyPanel, savePanel } from "../student/documentsStore";
import { endAttemptLocalState, purgeDeviceLocalState } from "./localState";

/* ADR-090, ADR-144 §7: what the player keeps of an attempt goes with it, both stores at once. */

const notes = { pages: ["2 + 2"], page: 0, checkpoint: 0, savedAt: Date.now() };

describe("the attempt's local state", () => {
  it("is gone at the attempt's end, the notepad's and the documents' both, another attempt's kept", () => {
    saveNotes("a1", notes);
    savePanel("a1", true, { ...emptyPanel(), open: true });
    saveNotes("a2", notes);
    savePanel("a2", true, emptyPanel());
    endAttemptLocalState("a1");
    expect(localStorage.getItem(notepadKey("a1"))).toBeNull();
    expect(sessionStorage.getItem(documentsKey("a1"))).toBeNull();
    expect(localStorage.getItem(notepadKey("a2"))).not.toBeNull();
    expect(sessionStorage.getItem(documentsKey("a2"))).not.toBeNull();
  });

  it("is gone from the device at sign-out and on a kiosk station, every attempt's", () => {
    saveNotes("a3", notes);
    savePanel("a3", true, emptyPanel());
    sessionStorage.setItem("unrelated", "1");
    purgeDeviceLocalState();
    expect(localStorage.getItem(notepadKey("a3"))).toBeNull();
    expect(sessionStorage.getItem(documentsKey("a3"))).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("1");
  });
});
