import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ClipboardList,
  Eye,
  FolderTree,
  Library,
  Menu as MenuIcon,
  School,
  Search,
  ShieldCheck,
  Vote,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import type { CourseSummary, Me, PoolSummary } from "@quiz/contracts";

import { api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { Logo, UserMenu, useSignOut, ViewModeToggle } from "./Header";
import { helpTopics, useHelp } from "./help";
import { useI18n, useT } from "./i18n";
import { NotificationBell } from "./notifications/NotificationBell";
import { sectionOf, type Route } from "./router";
import { inPoolSection, PoolNavTree, usePoolNavState } from "./pool/PoolNav";
import { shortcutCaps, useActiveShortcuts, useGlobalShortcuts } from "./shortcuts";
import { setThemeChoice, useResolvedTheme, useThemeChoice } from "./theme";
import {
  Button,
  cx,
  IconButton,
  Kbd,
  modKey,
  Tip,
  useLayer,
  useTruncated,
  Z,
  type IconType,
} from "./ui";
import { coursesKey, poolsKey } from "./queryKeys";

/**
 * Application frame: a 240 px sidebar on desktop (navigation, the teacher's
 * classrooms, the account menu at the bottom) and a slim top bar with a
 * drawer on phones. The page content sits in a 1120 px column.
 */

function NavItem({
  icon: Icon,
  label,
  active,
  onClick,
  trailing,
  expanded,
}: {
  icon?: IconType;
  label: ReactNode;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  /** Set on a row that also discloses something under itself. */
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      className={cx(
        "flex w-full items-center gap-2.5 rounded-field px-2.5 py-1.5 text-left text-sm transition-colors",
        active ? "bg-accent-soft font-semibold text-accent" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      {Icon ? <Icon className={cx("size-4 shrink-0", active ? "" : "text-fg-faint")} /> : null}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
    </button>
  );
}

/**
 * A classroom in the sidebar: its name, and its course code as the second
 * name beside it. The name is the one label of the frame that is routinely
 * too long for 240 px — "Prog-C-2026-2027-test" is a classroom a teacher
 * really creates — so the row carries a `Tip` with the whole of it, and only
 * when the ellipsis is actually there (`useTruncated`). The `Tip` wraps the
 * ROW, not the text: React's `onFocus` rides `focusin`, which bubbles, so a
 * teacher who reaches the row with the Tab key reads the name the same way a
 * pointer does.
 */
function ClassroomNavItem({
  name,
  courseCode,
  active,
  onClick,
}: {
  name: string;
  courseCode: string;
  active: boolean;
  onClick: () => void;
}) {
  const [nameRef, truncated] = useTruncated<HTMLSpanElement>();
  return (
    <Tip label={truncated ? name : null} className="block">
      <NavItem
        icon={School}
        label={
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span ref={nameRef} className="truncate">
              {name}
            </span>
            {/* `fg-muted`: a course code is the classroom's other name, not
                decoration, and this row sits on `accent-soft` when it is the
                one being read — the one background `fg-faint` still falls
                short of 4.5:1 on (W1). */}
            <span className="shrink-0 text-[11px] text-fg-muted">{courseCode}</span>
          </span>
        }
        active={active}
        onClick={onClick}
      />
    </Tip>
  );
}

/** How many classrooms the sidebar shows before it offers to unfold. */
const SIDEBAR_CLASSROOM_CAP = 12;

/**
 * The slice of the classroom list the sidebar shows while it is folded: the
 * first `cap` entries, plus the classroom being read when it sits past them,
 * so the current page is never missing from its own navigation.
 */
export function cappedClassrooms<T extends { id: string }>(
  rooms: T[],
  currentId: string | null,
  cap: number,
): T[] {
  if (rooms.length <= cap) return rooms;
  const head = rooms.slice(0, cap);
  const current = currentId == null ? undefined : rooms.find((r) => r.id === currentId);
  return current && !head.includes(current) ? [...head, current] : head;
}

function Nav({
  me,
  route,
  navigate,
  teacherUi,
  poolNav,
  onNavigate,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  /** The teacher UI is on (false in student view and for students). */
  teacherUi: boolean;
  /**
   * The three-state disclosure of the pools section, held by the frame: the
   * desktop sidebar and the mobile drawer both draw this navigation, and two
   * copies of the state would drift apart between them.
   */
  poolNav: ReturnType<typeof usePoolNavState>;
  /** Called after any navigation (closes the mobile drawer). */
  onNavigate?: () => void;
}) {
  const t = useT();
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
    enabled: teacherUi,
  });
  const go = (r: Route) => {
    navigate(r);
    onNavigate?.();
  };
  const currentRoom = route.view === "classroom" ? route.id : null;
  // The row lit for the page on screen, read from the route table.
  const section = sectionOf(route);
  // Folded by default and not persisted: thirty classrooms turn the sidebar
  // into a scrolling wall, and the teacher who wants them all says so once.
  const [showAll, setShowAll] = useState(false);
  // The sidebar lists CLASSROOMS, flattened out of the courses: that is what
  // a teacher navigates to. The course each one belongs to is the small line
  // under its name, not a second level of folding.
  const allRooms = (courses.data ?? []).flatMap((c) =>
    c.classrooms.map((r) => ({ ...r, courseCode: c.code })),
  );
  const shownRooms = showAll
    ? allRooms
    : cappedClassrooms(allRooms, currentRoom, SIDEBAR_CLASSROOM_CAP);
  return (
    // min-h-0 + overflow-y-auto: with thirty classrooms the list scrolls on its
    // own inside the sticky sidebar instead of pushing the account row out.
    <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
      <div className="space-y-0.5">
        <NavItem
          icon={teacherUi ? Library : ClipboardList}
          // WP9: student player — the student home is their evaluations now,
          // not the list of classrooms it used to be.
          label={teacherUi ? t("nav.courses") : t("shome.title")}
          active={section === "home"}
          onClick={() => go({ view: "home" })}
        />
        {teacherUi ? (
          <>
            <NavItem
              icon={FolderTree}
              label={t("pools.title")}
              // The three pool routes are one place as far as navigation goes:
              // a question is read inside its pool, not beside it.
              active={section === "pools"}
              expanded={poolNav.state !== "collapsed"}
              // One row, two jobs, and they never collide: from outside the
              // section the click NAVIGATES (and unfolds a collapsed tree);
              // from inside it cycles collapsed → active pool → all pools.
              // So a teacher reading a question cannot lose it by folding the
              // tree, and nobody needs a second control to see their pools.
              onClick={() => {
                if (inPoolSection(route)) poolNav.cycle();
                else {
                  poolNav.open();
                  go({ view: "pools" });
                }
              }}
            />
            {/* The tree of the pool being read, or every pool the teacher can
                reach — the state the row above cycles through (PoolNav.tsx).
                Each row of it is a drop target for a dragged question. */}
            <PoolNavTree state={poolNav.state} route={route} navigate={go} />
            {/* The launcher is a page of its own (`/polls`); the row stays
                `active` while a projection is up, because that IS the poll. */}
            <NavItem
              icon={Vote}
              label={t("poll.nav")}
              active={section === "polls"}
              onClick={() => go({ view: "polls" })}
            />
          </>
        ) : null}
        {/* Settings is not a section of the product: it lives in the account
            menu at the bottom of this sidebar, and in the palette. */}
        {me.role === "admin" && teacherUi ? (
          <NavItem
            icon={ShieldCheck}
            label={t("nav.admin")}
            active={section === "admin"}
            onClick={() => go({ view: "admin" })}
          />
        ) : null}
      </div>
      {teacherUi && allRooms.length ? (
        <div>
          <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("classrooms.title")}
          </p>
          <div className="space-y-0.5">
            {shownRooms.map((r) => (
              <ClassroomNavItem
                key={r.id}
                name={r.name}
                courseCode={r.courseCode}
                active={currentRoom === r.id}
                onClick={() => go({ view: "classroom", id: r.id })}
              />
            ))}
            {allRooms.length > shownRooms.length ? (
              <NavItem
                icon={ChevronDown}
                label={t("common.showAll", { n: allRooms.length })}
                onClick={() => setShowAll(true)}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/**
 * How many lines the strip shows. The account row under it is the bottom of
 * the frame and must never be pushed off — the navigation above already
 * scrolls — and a hint longer than a glance is a manual, not a hint.
 */
const SHORTCUT_STRIP_CAP = 10;

/**
 * The shortcuts that are live on this page, above the account row: the
 * global Ctrl+K first, then what the mounted screen registered and what the
 * focused field added on top (`shortcuts.tsx`).
 *
 * It is the one place the palette is still taught since the sidebar lost its
 * search row, so it is shown even when Ctrl+K is the only line. Desktop
 * only: the mobile drawer opens on a device with no keyboard to hold any of
 * this.
 */
function ShortcutStrip() {
  const t = useT();
  const shortcuts = useActiveShortcuts().slice(0, SHORTCUT_STRIP_CAP);
  if (shortcuts.length === 0) return null;
  return (
    <div className="border-t border-line px-3 py-2.5">
      <p className="mb-1.5 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
        {t("shortcuts.title")}
      </p>
      <ul className="space-y-1">
        {shortcuts.map((shortcut, i) => (
          <li key={`${shortcut.keys}-${shortcut.label}-${i}`} className="flex items-center gap-2">
            <span className="flex shrink-0 items-center gap-0.5">
              {shortcutCaps(shortcut.keys).map((cap, j) => (
                <Kbd key={`${cap}-${j}`}>{cap}</Kbd>
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{shortcut.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Shell({
  me,
  route,
  navigate,
  teacherUi,
  studentView,
  onToggleStudentView,
  children,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  teacherUi: boolean;
  studentView: boolean;
  onToggleStudentView?: () => void;
  children: ReactNode;
}) {
  const { t, locale, setLocale } = useI18n();
  const [drawer, setDrawer] = useState(false);
  const drawerPanel = useRef<HTMLDivElement>(null);
  const drawerTitleId = useId();
  // The mobile drawer is a modal dialog: focus moves in, Tab cycles inside,
  // Escape closes it and the "Open menu" button gets the focus back.
  useLayer(drawerPanel, () => setDrawer(false), { enabled: drawer });

  const poolNav = usePoolNavState();
  const [palette, setPalette] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Alt+K and Ctrl+Shift+K belong to the browser (the web console,
      // among others); only the bare shortcut is ours.
      if (e.altKey || e.shiftKey) return;
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      // On `window`, so it answers from inside a field too, which is the
      // convention everywhere this shortcut exists; and prevented, because
      // Firefox otherwise takes Ctrl+K to its own search bar.
      e.preventDefault();
      setPalette((open) => !open);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The palette is the one shortcut that works on every page, so the frame
  // registers it and the strip below shows it first.
  useGlobalShortcuts([{ keys: `${modKey()}+K`, label: t("palette.title") }]);

  // The same query `Nav` runs, deduplicated by react-query on the shared key:
  // the palette lists the classrooms the sidebar lists, at no extra request.
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
    enabled: teacherUi,
  });
  // Same shape as the classroom list above: the palette lists the pools a
  // teacher can jump to, on the key the pool screens already use.
  const pools = useQuery<PoolSummary[]>({
    queryKey: poolsKey,
    queryFn: () => api("/app/api/pools"),
    enabled: teacherUi,
  });
  const themeChoice = useThemeChoice();
  const resolvedTheme = useResolvedTheme();
  const { open: openHelp } = useHelp();
  const signOut = useSignOut();
  // Reads every help source to pull its title out; once per language is
  // enough. The teacher UI decides which topics are reachable at all.
  const topics = useMemo(() => helpTopics(locale, teacherUi), [locale, teacherUi]);

  /**
   * The home link, drawn as the wordmark. `titleId` lands on the image, whose
   * `alt` is then what names the drawer through `aria-labelledby`.
   *
   * `width` is the one thing that changes between the three places it
   * appears: the sidebar gives it the whole column, the phone top bar and the
   * drawer a third of it.
   */
  const brand = (titleId?: string, width = "w-28") => (
    <button
      type="button"
      onClick={() => navigate({ view: "home" })}
      aria-label={t("app.title")}
      className="flex shrink-0 items-center rounded-field text-left transition-opacity hover:opacity-80"
    >
      <Logo id={titleId} className={width} />
    </button>
  );
  const userMenu = (compact: boolean) => (
    <UserMenu
      me={me}
      compact={compact}
      onOpenSettings={() => navigate({ view: "settings" })}
      studentView={studentView}
      onToggleStudentView={onToggleStudentView}
    />
  );
  /*
   * The teacher/student switch, in the frame rather than on a page (ADR-018
   * addendum): a teacher who has launched their quiz is on the live
   * dashboard, and the button that used to be the only way in lives on
   * another screen. `onToggleStudentView` is defined for a teacher and an
   * admin and for nobody else, so a student never sees a switch that would
   * do nothing. It is drawn in BOTH views — the way out of the student view
   * is exactly as reachable as the way in.
   */
  const viewToggle = (compact: boolean) =>
    onToggleStudentView ? (
      <ViewModeToggle
        studentView={studentView}
        onToggle={onToggleStudentView}
        compact={compact}
      />
    ) : null;

  return (
    <div className="min-h-dvh lg:flex">
      {/* Desktop sidebar */}
      <aside
        aria-label={t("aside.sidebar")}
        className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-line bg-canvas lg:flex"
      >
        {/* The mark takes the sidebar's full width, with the air a wordmark
            needs: it is the only thing above the navigation. */}
        <div className="px-5 pb-3 pt-5">{brand(undefined, "w-full")}</div>
        {/* No search row here: Ctrl/⌘+K opens the palette from anywhere, and a
            permanent button for it took the top of the sidebar away from the
            navigation. The phone keeps its own trigger in the top bar, where
            there is no keyboard to hold a shortcut. */}
        <Nav
          me={me}
          route={route}
          navigate={navigate}
          teacherUi={teacherUi}
          poolNav={poolNav}
        />
        <ShortcutStrip />
        {/* The account row, and beside it the bell: the two things that are
            about the PERSON rather than about the page, at the bottom of the
            column where the eye leaves the navigation. */}
        <div className="border-t border-line p-2">
          {onToggleStudentView ? (
            <div className="mb-2 flex justify-center">{viewToggle(false)}</div>
          ) : null}
          <div className="flex items-center gap-1">
            <div className="min-w-0 flex-1">{userMenu(false)}</div>
            {teacherUi ? <NotificationBell navigate={navigate} /> : null}
          </div>
        </div>
      </aside>

      {/* Mobile drawer */}
      {drawer ? (
        <div className={`fixed inset-0 ${Z.modal} lg:hidden`}>
          <div className="layer-backdrop absolute inset-0 bg-fg/30" onClick={() => setDrawer(false)} />
          <div
            ref={drawerPanel}
            role="dialog"
            aria-modal="true"
            aria-labelledby={drawerTitleId}
            tabIndex={-1}
            className="absolute inset-y-0 left-0 flex w-72 flex-col border-r border-line bg-canvas shadow-overlay focus:outline-none"
          >
            <div className="flex items-center justify-between px-3 pb-2 pt-4">
              {brand(drawerTitleId)}
              <IconButton label={t("menu.closeMenu")} onClick={() => setDrawer(false)}>
                <X />
              </IconButton>
            </div>
            <Nav
              me={me}
              route={route}
              navigate={navigate}
              teacherUi={teacherUi}
              poolNav={poolNav}
              onNavigate={() => setDrawer(false)}
            />
            <div className="border-t border-line p-2">
              {onToggleStudentView ? (
                <div className="mb-2 flex justify-center">{viewToggle(false)}</div>
              ) : null}
              {userMenu(false)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="min-w-0 flex-1">
        {/* Mobile top bar */}
        <div className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b border-line bg-canvas/90 px-3 backdrop-blur lg:hidden">
          <IconButton
            label={t("menu.openMenu")}
            aria-haspopup="dialog"
            aria-expanded={drawer}
            onClick={() => setDrawer(true)}
          >
            <MenuIcon />
          </IconButton>
          {brand()}
          <span className="flex-1" />
          {viewToggle(true)}
          <IconButton label={t("palette.open")} onClick={() => setPalette(true)}>
            <Search />
          </IconButton>
          {/* Beside the avatar, hanging from its own right edge: the top bar
              has nothing else on that side to push the panel out of. */}
          {teacherUi ? <NotificationBell navigate={navigate} align="end" /> : null}
          {userMenu(true)}
        </div>

        {studentView ? (
          <div className="border-b border-accent/20 bg-accent-soft px-4 py-2 text-[13px] text-accent">
            <div className="mx-auto flex max-w-280 items-center gap-2 sm:px-2">
              <Eye className="size-4" />
              <span className="flex-1">{t("menu.studentViewBanner")}</span>
              {onToggleStudentView ? (
                <Button size="sm" variant="secondary" onClick={onToggleStudentView}>
                  {t("menu.teacherView")}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <main className="mx-auto w-full max-w-280 px-4 py-6 sm:px-8 lg:py-8">{children}</main>
      </div>

      {/* Mounted only while open: nothing of it — the key listener of its
          layer, the autofocus, the query it holds — exists on a page nobody
          summoned it on. It still takes `open`, so a test can render it on
          its own without the Shell around it. */}
      {palette ? (
        <CommandPalette
          open
          onClose={() => setPalette(false)}
          t={t}
          locale={locale}
          setLocale={setLocale}
          route={route}
          navigate={navigate}
          me={me}
          teacherUi={teacherUi}
          studentView={studentView}
          onToggleStudentView={onToggleStudentView}
          courses={courses.data ?? []}
          pools={pools.data ?? []}
          themeChoice={themeChoice}
          resolvedTheme={resolvedTheme}
          setThemeChoice={setThemeChoice}
          openHelp={openHelp}
          helpTopics={topics}
          signOut={signOut}
          onStartPoll={teacherUi ? () => navigate({ view: "polls" }) : undefined}
        />
      ) : null}

    </div>
  );
}
