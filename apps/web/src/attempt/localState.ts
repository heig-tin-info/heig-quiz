/**
 * What the player keeps of an attempt on this device, beside the server's:
 * the notepad's pages (ADR-090, `notepad/store.ts`) and the documents
 * panel's reading state (ADR-144 §7, `student/documentsStore.ts`). Both go
 * together, by these two calls only.
 */
import { endNotepad, purgeAllNotepads } from "../notepad/store";
import { endDocumentStates, purgeAllDocumentStates } from "../student/documentsStore";

/** The attempt is over (submitted, deadline, evaluation closed): what was kept of it goes, and stays gone. */
export function endAttemptLocalState(attemptId: string): void {
  endNotepad(attemptId);
  endDocumentStates(attemptId);
}

/** Sign-out, a pseudonymized account, a kiosk station's load: no student's state stays on this device. */
export function purgeDeviceLocalState(): void {
  purgeAllNotepads();
  purgeAllDocumentStates();
}
