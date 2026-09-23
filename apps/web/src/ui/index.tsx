// The `./ui` barrel: every screen imports its primitives from here, so where
// one lives inside `ui/` is invisible to the app.
//
//   layers    the base: cx, Z, the layer stack (useLayer), Tip, IconButton,
//             HelpIcon, Modal, Sheet, Menu. Imports no sibling.
//   controls  buttons and form controls.
//   page      tables, identity, dates, feedback, surfaces and page structure.
//   actions   the actions of one record: icon buttons or a menu, decided
//             by their number (Actions), on layers.
//   popover   the small floating card anchored on a trigger (Popover), on
//             layers.
//   people    a person as a disc, and a row of them (PersonPill,
//             PeopleStack), on actions, popover and page.
//   live      the live primitives (PLAN-MVP §6.4).
//   forms     the short form in a dialog (FormDialog), on layers + controls.
//   combobox  the ARIA combobox with virtual focus (useCombobox,
//             ComboboxList, ComboboxOption), on layers.
//   state     browser state a screen reads: remembered choices
//             (usePersistentChoice), isTyping, useFullscreen. Imports no
//             sibling.
//
// `QueryError`, `PageError` and `FormError` come from the app side (they read an
// `ApiError`), so that nothing under `ui/` imports the HTTP client.
export * from "./layers";
export * from "./controls";
export * from "./page";
export * from "./actions";
export * from "./popover";
export * from "./people";
export * from "./live";
export * from "./forms";
export * from "./combobox";
export * from "./state";
export { FormError, PageError, QueryError } from "../queryError";
