/**
 * One focus of a field is one undo step: every field of the editor — the
 * inspector's, the text pane — draws its session number here, and the
 * editor records a step only when the number changes.
 */
let sessions = 0;
export const nextSession = (): number => (sessions += 1);
