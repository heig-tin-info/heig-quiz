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

/** What the player's docks sit above: its footer, on a phone. */
const DOCK_OFFSET = "var(--player-footer-h,0px)";

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
  /** The teacher's preview: the notepad and the documents' state live in memory only. */
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
  // Where the notes and the documents' reading state may be kept is known
  // once the session is: the preview and an impersonation session (ADR-034)
  // keep them in memory; a failed /me never falls back to persisting.
  const persist = me.isSuccess && !preview && me.data?.session?.kind !== "impersonation";
  // Each tool on takes the next slot of the stack, from the bottom.
  const stack = (
    [calculator !== "none" && "calculator", notepad !== "none" && "notepad", documents && "documents"] as const
  ).filter((tool): tool is Tool | "documents" => tool !== false && tool !== undefined);
  const seat = (tool: Tool): ToolDockSeat => ({
    slot: stack.indexOf(tool),
    offset: DOCK_OFFSET,
    open: open === tool,
    onOpenChange: (next) => setOpen(next ? tool : (current) => (current === tool ? null : current)),
  });
  return (
    <>
      {calculator !== "none" ? <CalculatorDock kind={calculator} seat={seat("calculator")} /> : null}
      {notepad !== "none" && !me.isPending ? (
        <PlayerNotepad
          attemptId={attemptId}
          persist={persist}
          checkpoint={furthestCheckpoint(
            navigation,
            items.map((item) => ({ milestone: item.milestone, validated: item.markedDone })),
          )}
          noClipboard={notepad === "provided_no_clipboard"}
          seat={seat("notepad")}
        />
      ) : null}
      {documents && !me.isPending ? (
        <DocumentsPanel
          attemptId={attemptId}
          documents={documents}
          persist={persist}
          hidden={paused}
          slot={stack.indexOf("documents")}
          offset={DOCK_OFFSET}
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
