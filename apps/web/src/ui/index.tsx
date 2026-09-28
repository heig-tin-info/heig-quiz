// The `./ui` barrel: every screen imports its primitives from here, so where
// one lives inside `ui/` is invisible to the app.
//
//   layers    the base: cx, Z, the layer stack (useLayer), Tip, IconButton,
//             HelpIcon, Modal, Sheet, useNow. Imports no sibling.
//   menu      the overflow menu (Menu) and the list and strip keyboard
//             arithmetic (listboxIndex, rovingIndex), on layers.
//   controls  buttons and form controls.
//   table     sortable tables: useSortableTable, the styles `T`, TableHead.
//   identity  a person as a picture or initials (PersonAvatar, Avatar).
//   dates     the account's date format, absolute and relative times.
//   feedback  Spinner, Skeleton, Kbd, Badge, Alert, EmptyState.
//   page      surfaces and page structure: Card, PageHeader, Tabs…
//             The six above are on layers and import no other sibling,
//             except page, which reads rovingIndex from menu.
//   actions   the actions of one record: icon buttons or a menu, decided
//             by their number (Actions), on layers and menu.
//   popover   the small floating card anchored on a trigger (Popover), on
//             layers and menu (menuPosition).
//   people    a person as a disc, and a row of them (PersonPill,
//             PeopleStack), on actions, popover and identity.
//   live      the live primitives (PLAN-MVP §6.4).
//   bar       a thin segmented bar of counts (SegmentedBar), on layers.
//   forms     the short form in a dialog (FormDialog), on layers + controls.
//   combobox  the ARIA combobox with virtual focus (useCombobox,
//             ComboboxList, ComboboxOption), on layers and menu.
//   state     browser state a screen reads: remembered choices
//             (usePersistentChoice), isTyping, useFullscreen. Imports no
//             sibling.
//
// `QueryError`, `PageError` and `FormError` come from the app side (they read an
// `ApiError`), so that nothing under `ui/` imports the HTTP client.
export * from "./layers";
export * from "./menu";
export * from "./controls";
export * from "./table";
export * from "./identity";
export * from "./dates";
export * from "./feedback";
export * from "./page";
export * from "./actions";
export * from "./popover";
export * from "./people";
export * from "./live";
export * from "./bar";
export * from "./forms";
export * from "./combobox";
export * from "./state";
export { FormError, PageError, QueryError } from "../queryError";
