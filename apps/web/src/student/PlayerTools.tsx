/**
 * The tools an evaluation provides on the player (ADR-069, ADR-090): the
 * calculator and the notepad, each a `ToolDock`, stacked at the bottom right
 * when both are on — the calculator at the bottom, the notepad above it.
 *
 * One panel at a time: opening one closes the other, and both keep their
 * state while closed (`keepMounted`), so a number and a page of notes survive
 * the switch, a question change and a reopen. Outside the keyed question for
 * the same reason.
 */
import { useState } from "react";

import { furthestCheckpoint, type CalculatorMode, type NavigationMode, type NotepadMode } from "@quiz/domain";

import { useMe } from "../api";
import { CalculatorDock } from "../calculator/CalculatorDock";
import { NotepadDock } from "../notepad/NotepadDock";
import { useNotepad } from "../notepad/useNotepad";
import type { ToolDockSeat } from "../ui";

type Tool = "calculator" | "notepad";

export function PlayerTools({
  calculator,
  notepad,
  attemptId,
  preview,
  navigation,
  items,
}: {
  calculator: CalculatorMode;
  notepad: NotepadMode;
  attemptId: string;
  /** The teacher's preview: the notepad lives in memory only. */
  preview: boolean;
  navigation: NavigationMode;
  /** The attempt's items in the student's order, for the checkpoint crossed. */
  items: readonly { milestone: boolean; markedDone: boolean }[];
}) {
  const [open, setOpen] = useState<Tool | null>(null);
  const me = useMe();
  const seat = (tool: Tool, slot: number): ToolDockSeat => ({
    slot,
    open: open === tool,
    onOpenChange: (next) => setOpen(next ? tool : (current) => (current === tool ? null : current)),
  });
  const withCalculator = calculator !== "none";
  return (
    <>
      {withCalculator ? <CalculatorDock kind={calculator} seat={seat("calculator", 0)} /> : null}
      {/* Where the notes may be kept is known once the session is: an
          impersonation session (ADR-034) keeps them in memory, like the preview. */}
      {notepad !== "none" && !me.isPending ? (
        <PlayerNotepad
          attemptId={attemptId}
          persist={!preview && me.data?.session?.kind !== "impersonation"}
          checkpoint={furthestCheckpoint(
            navigation,
            items.map((item) => ({ milestone: item.milestone, validated: item.markedDone })),
          )}
          noClipboard={notepad === "provided_no_clipboard"}
          seat={seat("notepad", withCalculator ? 1 : 0)}
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
