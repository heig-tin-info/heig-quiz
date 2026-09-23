// The `./ui` barrel: every screen imports its primitives from here, so where
// one lives inside `ui/` is invisible to the app.
//
//   layers    the base: cx, Z, the layer stack (useLayer), Tip, IconButton,
//             HelpIcon, Modal, Sheet, Menu. Imports no sibling.
//   controls  buttons and form controls.
//   page      tables, identity, dates, feedback, surfaces and page structure.
//   live      the live primitives (PLAN-MVP §6.4).
//   forms     the short form in a dialog (FormDialog), on layers + controls.
//
// `QueryError` and `PageError` come from the app side (they read an
// `ApiError`), so that nothing under `ui/` imports the HTTP client.
export * from "./layers";
export * from "./controls";
export * from "./page";
export * from "./live";
export * from "./forms";
export { PageError, QueryError } from "../queryError";
