/**
 * The tools an evaluation provides on the player (ADR-069, ADR-090, ADR-144
 * §7): the calculator, the notepad and the documents, stacked at the bottom
 * right in that order — each takes the next slot of the stack, whichever
 * are on.
 *
 * The calculator and the notepad are `ToolDock`s, one panel at a time:
 * opening one closes the other, and both keep their state while closed
 * (`keepMounted`), so a number and a page of notes survive the switch, a
 * question change and a reopen. The documents open a panel of their own
 * beside the questions (`DocumentsPanel`), which closes neither. Outside the
 * keyed question for the same reason.
 */
import { useState } from "react";

import { furthestCheckpoint, type CalculatorMode, type NavigationMode, type NotepadMode } from "@quiz/domain";

import { useMe } from "../api";
import { CalculatorDock } from "../calculator/CalculatorDock";
import { NotepadDock } from "../notepad/NotepadDock";
import { useNotepad } from "../notepad/useNotepad";
import type { ToolDockSeat } from "../ui";
import { DocumentsPanel, type PlayerDocuments } from "./DocumentsPanel";

type Tool = "calculator" | "notepad";

export function PlayerTools({
  calculator,
  notepad,
  attemptId,
  preview,
  navigation,
  items,
  documents,
  paused = false,
}: {
  calculator: CalculatorMode;
  notepad: NotepadMode;
  attemptId: string;
  /** The teacher's preview: the notepad lives in memory only. */
  preview: boolean;
  navigation: NavigationMode;
  /** The attempt's items in the student's order, for the checkpoint crossed. */
  items: readonly { milestone: boolean; markedDone: boolean }[];
  /** ADR-144 §7: the documents the attempt may read now; absent where none can be (a paper copy). */
  documents?: PlayerDocuments | undefined;
  /** The evaluation is paused: the documents are not read (the pause event carries no list). */
  paused?: boolean;
}) {
  const [open, setOpen] = useState<Tool | null>(null);
  const me = useMe();
  const seat = (tool: Tool, slot: number): ToolDockSeat => ({
    slot,
    open: open === tool,
    onOpenChange: (next) => setOpen(next ? tool : (current) => (current === tool ? null : current)),
  });
  const withCalculator = calculator !== "none";
  const withNotepad = notepad !== "none";
  // Each tool on takes the next slot, from the bottom.
  const notepadSlot = withCalculator ? 1 : 0;
  const documentsSlot = notepadSlot + (withNotepad ? 1 : 0);
  return (
    <>
      {withCalculator ? <CalculatorDock kind={calculator} seat={seat("calculator", 0)} /> : null}
      {/* Where the notes may be kept is known once the session is: an
          impersonation session (ADR-034) keeps them in memory, like the preview. */}
      {withNotepad && !me.isPending ? (
        <PlayerNotepad
          attemptId={attemptId}
          // A failed /me never falls back to persisting.
          persist={me.isSuccess && !preview && me.data?.session?.kind !== "impersonation"}
          checkpoint={furthestCheckpoint(
            navigation,
            items.map((item) => ({ milestone: item.milestone, validated: item.markedDone })),
          )}
          noClipboard={notepad === "provided_no_clipboard"}
          seat={seat("notepad", notepadSlot)}
        />
      ) : null}
      {documents && !me.isPending ? (
        <DocumentsPanel
          attemptId={attemptId}
          // A failed /me never falls back to persisting, as the notepad.
          documents={{
            ...documents,
            persist: documents.persist && me.isSuccess && me.data?.session?.kind !== "impersonation",
          }}
          hidden={paused}
          slot={documentsSlot}
          offset="var(--player-footer-h,0px)"
        />
      ) : null}
    </>
  );
}

function PlayerNotepad({
  attemptId,
  persist,
  checkpoint,
  noClipboard,
  seat,
}: {
  attemptId: string;
  persist: boolean;
  checkpoint: number;
  noClipboard: boolean;
  seat: ToolDockSeat;
}) {
  const notepad = useNotepad({ attemptId, checkpoint, persist });
  return <NotepadDock notepad={notepad} noClipboard={noClipboard} seat={seat} />;
}
