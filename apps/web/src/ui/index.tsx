// The `./ui` barrel: every screen imports its primitives from here, so where
// one lives inside `ui/` is invisible to the app.
//
//   layers    the base: cx, Z, the layer stack (useLayer), Tip, IconButton,
//             IconLink, HelpIcon, Modal, Sheet, useNow. Imports no sibling.
//   menu      the overflow menu (Menu) and the list and strip keyboard
//             arithmetic (listboxIndex, rovingIndex), on layers (and
//             isPlainClick from controls, for its link items).
//   controls  buttons and form controls.
//   table     sortable tables: useSortableTable, the styles `T`, TableHead.
//   identity  a person or an organization as a picture or initials
//             (PersonAvatar, Avatar, OrgAvatar), and the GitHub mark
//             (GithubIcon).
//   dates     the account's date format, absolute and relative times, and a
//             percentage in the interface language.
//   feedback  Spinner, Skeleton, Progress, Kbd, Badge, Alert, EmptyState.
//   page      surfaces and page structure: Card, PageHeader, Tabs…
//             The six above are on layers and import no other sibling,
//             except page, which reads rovingIndex from menu and Fab from
//             fab.
//   fab       the screen's creating primary as a floating button on a
//             phone (Fab), rendered by PageHeader's `primary`, on layers.
//   meta      the small facts under a title (MetaItem, MetaLine), on layers.
//   breadcrumb the trail of ancestors of a page (Breadcrumb), on controls.
//   actions   the actions of one record: icon buttons or a menu, decided
//             by their number (Actions), on layers and menu.
//   popover   the small floating card anchored on a trigger (Popover), on
//             layers and menu (menuPosition).
//   people    a person as a disc, its card, and a row of them (PersonPill,
//             PersonCard, PeopleStack), on actions, popover and identity.
//   live      the live primitives (PLAN-MVP §6.4).
//   bar       a thin segmented bar of counts (SegmentedBar), vertical bars
//             (Bars, StackedBars) and their legend, on layers.
//   forms     the short form in a dialog (FormDialog), on layers + controls.
//   combobox  the ARIA combobox with virtual focus (useCombobox,
//             ComboboxList, ComboboxOption), on layers and menu.
//   selection the floating bar of a list's ticked rows (SelectionBar), on
//             layers.
//   state     browser state a screen reads: remembered choices
//             (usePersistentChoice), isTyping, useFullscreen. Imports no
//             sibling.
//   toolDock  a tool docked at the bottom right (ToolDock: the calculator,
//             the help assistant), on layers.
//   expand    the layer a question type's canvas expands into
//             (ExpandPanel), on layers + controls.
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
export type { PagePrimary } from "./fab";
export * from "./meta";
export * from "./breadcrumb";
export * from "./actions";
export * from "./popover";
export * from "./people";
export * from "./live";
export * from "./bar";
export * from "./forms";
export * from "./combobox";
export * from "./selection";
export * from "./state";
export * from "./expand";
export * from "./toolDock";
export { FormError, PageError, QueryError } from "../queryError";
