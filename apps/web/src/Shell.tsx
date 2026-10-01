import { useQuery } from "@tanstack/react-query";
import {
  CalendarRange,
  ChevronDown,
  Eye,
  FolderTree,
  Library,
  Menu as MenuIcon,
  School,
  Search,
  ShieldCheck,
  VenetianMask,
  Vote,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";

import type { CourseSummary, Me, PoolSummary } from "@quiz/contracts";
import { isCurrent } from "@quiz/domain";

import { api } from "./api";
import { CommandPalette } from "./CommandPalette";
import { Logo, UserMenu, useSignOut, ViewModeToggle } from "./Header";
import { helpTopics, useHelp } from "./help";
import { useI18n, useT } from "./i18n";
import { bottomSlotOf, sectionOf, type Route } from "./router";
import {
  activeCourseOf,
  CourseNavTree,
  inNavigation,
  useCourseNavState,
} from "./CourseNav";
import type { NavCycle } from "./navTree";
import { PoolNavTree, usePoolNavState } from "./pool/PoolNav";
import { shortcutCaps, useActiveShortcuts, useGlobalShortcuts } from "./shortcuts";
import { setThemeChoice, useResolvedTheme, useThemeChoice } from "./theme";
import {
  Button,
  cx,
  IconButton,
  Kbd,
  modKey,
  pageColumnVars,
  Tip,
  useLayer,
  useTruncated,
  Z,
  type IconType,
} from "./ui";
import { coursesKey, poolsKey } from "./queryKeys";
import { BottomNav, SLOT_LOOK } from "./student/BottomNav";
import { bottomNavShown, sidebarSlots } from "./student/bottomNavSlots";
import { useDrillAvailability, type DrillAvailability } from "./drill/api";
import { AvailableDot } from "./drill/AvailableDot";

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
  coach,
  description,
}: {
  icon?: IconType;
  label: ReactNode;
  /** What the row's `Tip` shows, for a reader that cannot see the bubble. */
  description?: string;
  active?: boolean;
  onClick: () => void;
  trailing?: ReactNode;
  /** Set on a row that also discloses something under itself. */
  expanded?: boolean;
  /** A coach mark's anchor (`coach/catalog.ts`). */
  coach?: string;
}) {
  return (
    <button
      type="button"
      data-coach={coach}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      aria-expanded={expanded}
      aria-description={description}
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
 * A classroom in the sidebar: its name, and nothing else (#153). At 240 px a
 * second label beside it truncated the name on almost every row, and the
 * course code it showed did not even tell two classrooms of the same course
 * apart. The course lives in the row's `Tip` instead — its code and its name,
 * one hover or one Tab away — together with the whole classroom name when the
 * ellipsis actually cut it (`useTruncated`): "Prog-C-2026-2027-test" is a
 * classroom a teacher really creates. The `Tip` wraps the ROW, not the text:
 * React's `onFocus` rides `focusin`, which bubbles, so a teacher who reaches
 * the row with the Tab key reads it the same way a pointer does. The bubble
 * is `aria-hidden`, so the course also rides the row's `aria-description`.
 */
function ClassroomNavItem({
  name,
  courseCode,
  courseName,
  active,
  onClick,
}: {
  name: string;
  courseCode: string;
  courseName: string;
  active: boolean;
  onClick: () => void;
}) {
  const t = useT();
  const [nameRef, truncated] = useTruncated<HTMLSpanElement>();
  const course = t("nav.classroomCourse", { code: courseCode, name: courseName });
  return (
    <Tip label={truncated ? t("nav.classroomTip", { name, course }) : course} className="block">
      <NavItem
        icon={School}
        label={
          <span ref={nameRef} className="block truncate">
            {name}
          </span>
        }
        description={course}
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
  courseNav,
  drill,
  onNavigate,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  /** The teacher UI is on (false in student view and for students). */
  teacherUi: boolean;
  /** The student's drill: whether its row is drawn, and today's badge (#317). */
  drill: DrillAvailability;
  /**
   * The three-state disclosure of the pools section, held by the frame: the
   * desktop sidebar and the mobile drawer both draw this navigation, and two
   * copies of the state would drift apart between them.
   */
  poolNav: NavCycle;
  /** The same, for the course → classroom tree under "Courses" (#154). */
  courseNav: NavCycle;
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
  // The row lit for the page on screen, read from the route table: a
  // teacher's by section, a student's by the bottom bar's slot.
  const section = teacherUi ? sectionOf(route) : null;
  const studentSlot = teacherUi ? null : bottomSlotOf(route);
  // Folded by default and not persisted: thirty classrooms turn the sidebar
  // into a scrolling wall, and the teacher who wants them all says so once.
  const [showAll, setShowAll] = useState(false);
  // The sidebar lists CLASSROOMS, flattened out of the courses: that is what
  // a teacher navigates to. The course each one belongs to is in the row's
  // tip, not a second label on it nor a second level of folding.
  // It is the "right now" list: the server already leaves the archived out,
  // the courses the teacher hid are left out as everywhere in the navigation
  // (#155), and a dated classroom shows only while its period covers today —
  // the browser's local date, a display rule and not a deadline (#156). The
  // classroom being read stays, ended or not: the current page is never
  // missing from its own navigation. The course tree above and the course
  // cards keep every classroom.
  const list = courses.data ?? [];
  const activeCourse = activeCourseOf(list, route);
  const today = new Date();
  const allRooms = list
    .filter((c) => inNavigation(c, activeCourse))
    .flatMap((c) => c.classrooms)
    .filter((r) => r.id === currentRoom || isCurrent(r.periodStart, r.periodEnd, today));
  const shownRooms = showAll
    ? allRooms
    : cappedClassrooms(allRooms, currentRoom, SIDEBAR_CLASSROOM_CAP);
  return (
    // min-h-0 + overflow-y-auto: with thirty classrooms the list scrolls on its
    // own inside the sticky sidebar instead of pushing the account row out.
    <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
      <div className="space-y-0.5">
        {/* Every activity across the classrooms (#190): a flat page, no tree.
            First, above the courses: it is where a teacher's day starts. */}
        {teacherUi ? (
          <>
            <NavItem
              icon={CalendarRange}
              label={t("nav.activities")}
              active={section === "activities"}
              onClick={() => go({ view: "activities" })}
            />
            <NavItem
              icon={Library}
              label={t("nav.courses")}
              active={section === "home"}
              coach="nav.home"
              expanded={courseNav.state === "all"}
              // The pools' rule (below): the click goes to the course list; on
              // the list itself it toggles the active course / all courses.
              onClick={() => courseNav.press(route.view === "home", () => go({ view: "home" }))}
            />
            <CourseNavTree state={courseNav.state} courses={courses} route={route} navigate={go} />
            <NavItem
              icon={FolderTree}
              label={t("pools.title")}
              // The three pool routes are one place as far as navigation goes:
              // a question is read inside its pool, not beside it.
              active={section === "pools"}
              coach="nav.pools"
              expanded={poolNav.state === "all"}
              // One row, two jobs, and they never collide: anywhere but the
              // pool list the click NAVIGATES there, as every sidebar row
              // does; on the list, where there is nowhere left to go, it
              // toggles the active pool / all pools (useNavCycle).
              onClick={() => poolNav.press(route.view === "pools", () => go({ view: "pools" }))}
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
              coach="nav.polls"
              onClick={() => go({ view: "polls" })}
            />
          </>
        ) : (
          // The student's rows are the phone's bottom bar, minus Profile (the
          // account menu below): one list, one lit row (the route's
          // `bottomSlot`). Drill only once a classroom has it on (ADR-041);
          // its dot is "today's drill is available".
          sidebarSlots(drill.shown).map((slot) => {
            const look = SLOT_LOOK[slot.id];
            return (
              <NavItem
                key={slot.id}
                icon={look.icon}
                label={t(look.label)}
                active={slot.id === studentSlot}
                onClick={() => go(slot.route)}
                trailing={slot.id === "drill" && drill.available ? <AvailableDot /> : null}
              />
            );
          })
        )}
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
        // A hairline above, like the one over the shortcut strip: this is the
        // "right now" list, apart from the navigation, and it looks apart.
        <div className="border-t border-line pt-4">
          <p className="mb-1.5 px-2.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            {t("classrooms.title")}
          </p>
          <div className="space-y-0.5">
            {shownRooms.map((r) => (
              <ClassroomNavItem
                key={r.id}
                name={r.name}
                courseCode={r.courseCode}
                courseName={r.courseName}
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
    <div className="border-t border-line px-3 py-2.5" data-coach="shell.shortcuts">
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
  wide = false,
  children,
}: {
  me: Me;
  route: Route;
  navigate: (r: Route) => void;
  teacherUi: boolean;
  studentView: boolean;
  onToggleStudentView?: () => void;
  /**
   * The page drops the reading-width cap and takes the whole content area.
   * An opt-in of the route (`WIDE` in App.tsx), never a default: a form or a
   * list stretched across a 27" screen is harder to read, while a matrix —
   * the live grid, thirty students by twelve questions — capped at 70 rem
   * scrolls sideways beside two empty margins (#93).
   */
  wide?: boolean;
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
  const courseNav = useCourseNavState();
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
      className="flex shrink-0 items-center rounded-field text-left"
    >
      <Logo id={titleId} className={width} />
    </button>
  );
  // Where the student's bottom bar shows, the top bar does not repeat it:
  // DESIGN.md, "The student's bottom bar" (#191).
  const bottomNav = bottomNavShown(route, teacherUi);
  // The student's drill (#317): the sidebar row and the bottom slot, both
  // drawn only once a classroom has it on, with today's badge.
  const drill = useDrillAvailability(!teacherUi);
  const userMenu = (compact: boolean) => (
    <UserMenu
      me={me}
      compact={compact}
      {...(compact && bottomNav ? {} : { onOpenSettings: () => navigate({ view: "settings" }) })}
      studentView={studentView}
      onToggleStudentView={onToggleStudentView}
      notifications={{ navigate }}
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

  const frame = (
    <div className="min-h-[calc(100dvh-var(--banner-h))] lg:flex">
      {/* Desktop sidebar */}
      <aside
        aria-label={t("aside.sidebar")}
        className="sticky top-(--banner-h) hidden h-[calc(100dvh-var(--banner-h))] w-60 shrink-0 flex-col border-r border-line bg-canvas lg:flex"
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
          courseNav={courseNav}
          drill={drill}
        />
        <ShortcutStrip />
        {/* The account row: what is about the PERSON rather than about the
            page (the inbox included, inside its menu), at the bottom of the
            column where the eye leaves the navigation. */}
        <div className="border-t border-line p-2">
          {onToggleStudentView ? (
            <div className="mb-2 flex justify-center">
              <span className="inline-flex rounded-full" data-coach="shell.view-toggle">
                {viewToggle(false)}
              </span>
            </div>
          ) : null}
          {userMenu(false)}
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
              courseNav={courseNav}
              drill={drill}
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
        <div className="sticky top-(--banner-h) z-20 flex h-(--topbar-h) items-center gap-2 border-b border-line bg-canvas/90 px-3 backdrop-blur lg:hidden">
          {bottomNav ? null : (
            <IconButton
              label={t("menu.openMenu")}
              aria-haspopup="dialog"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
            >
              <MenuIcon />
            </IconButton>
          )}
          {brand()}
          <span className="flex-1" />
          {viewToggle(true)}
          <IconButton label={t("palette.open")} onClick={() => setPalette(true)}>
            <Search />
          </IconButton>
          {userMenu(true)}
        </div>

        <main
          style={pageColumnVars}
          className={cx(
            "mx-auto w-full px-4 py-6 sm:px-(--page-gutter) lg:py-8",
            wide ? "max-w-none" : "max-w-(--page-cap)",
          )}
        >
          {children}
        </main>
        {bottomNav ? <BottomNav route={route} navigate={navigate} drill={drill} /> : null}
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
  return studentView ? (
    <StudentViewBanner onLeave={onToggleStudentView}>{frame}</StudentViewBanner>
  ) : (
    frame
  );
}

/**
 * ADR-034: an admin acting as this student, in a private window. Every page
 * says so, with the way out: "End" signs this session out — which is what
 * ends the impersonation, audit entry included — and leaves the window on
 * the landing page. The admin's own session lives in another browser. Any
 * other session: the children, as they are.
 */
export function ImpersonationBanner({ me, children }: { me: Me; children: ReactNode }) {
  const t = useT();
  const signOut = useSignOut();
  if (me.session?.kind !== "impersonation") return children;
  const name = `${me.givenName} ${me.familyName}`.trim();
  return (
    <ModeBanner
      icon={<VenetianMask />}
      message={t(me.session?.readOnly ? "impersonation.bannerReadOnly" : "impersonation.banner", { name })}
      short={t("impersonation.bannerShort", { name })}
      action={{ label: t("impersonation.end"), onClick: signOut }}
    >
      {children}
    </ModeBanner>
  );
}

/** The height of one mode banner; `--banner-h` is the sum of the banners above the frame. */
const BANNER_HEIGHT = "2rem";

/** The fill of each tone, with its ink, the pill's hairline and its focus ring. */
const BANNER_TONE = {
  mode: "bg-fg text-canvas [--banner-ink:var(--canvas)]",
  danger: "bg-danger text-on-fill [--banner-ink:var(--on-fill)]",
} as const;

/**
 * A mode of the whole application, stated above everything: full width,
 * sticky at the top, over the sidebar. Solid `fg` on `canvas` ink — inverted
 * rather than red, because the one red element of a screen is the thing to
 * click, and a mode is not that. It wraps the frame it sits on and hands it
 * `--banner-h`, so the sidebar, the phone top bar and the player's header
 * stick below it instead of under it.
 *
 * Generic on purpose: the student view says one thing and offers the way
 * back; another mode (acting as someone else) says another and offers its
 * own way out. `short` is what a phone shows, where the full sentence would
 * be cut before the word that names the mode; `message` names the region.
 *
 * `danger` is the one red banner: Super Powers (ADR-054), a state that is a
 * hazard rather than a point of view — every colleague's course is open to
 * the admin's next click. `aside` is what the banner says beside its
 * message and changes on its own (their countdown).
 *
 * Banners stack: each one sticks below the ones around it (`--banner-top`,
 * the `--banner-h` it inherits) and hands its frame the sum.
 */
export function ModeBanner({
  icon,
  message,
  short,
  aside,
  action,
  tone = "mode",
  children,
}: {
  icon?: ReactNode;
  message: string;
  short?: string | undefined;
  aside?: ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean } | undefined;
  tone?: keyof typeof BANNER_TONE;
  children: ReactNode;
}) {
  return (
    // Two elements, because a custom property read and set on the same
    // element is a cycle: the outer one reads the offset above, the inner one
    // adds this banner to it.
    <div style={{ "--banner-top": "var(--banner-h)" } as CSSProperties}>
    <div style={{ "--banner-h": `calc(var(--banner-top) + ${BANNER_HEIGHT})` } as CSSProperties}>
      <div
        role="region"
        aria-label={message}
        className={cx(
          "sticky top-(--banner-top) flex h-8 items-center gap-2 px-4 text-xs font-medium [&>svg]:size-3.5 [&>svg]:shrink-0",
          BANNER_TONE[tone],
          Z.banner,
        )}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">
          {short ? (
            <>
              <span className="sm:hidden">{short}</span>
              <span className="hidden sm:inline">{message}</span>
            </>
          ) : (
            message
          )}
        </span>
        {aside}
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            className="h-6 shrink-0 whitespace-nowrap rounded-full border border-(--banner-ink)/40 px-2.5 text-xs font-medium transition-colors hover:bg-(--banner-ink)/15 focus-visible:outline-(--banner-ink) disabled:opacity-60"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {children}
    </div>
    </div>
  );
}

/**
 * The strip that says a teacher is looking through a student's eyes, with the
 * way back. Drawn by the frame, and by `App` above the full-screen attempt:
 * an exam has no sidebar, and without it the only way out of the student
 * view was to hand the attempt in.
 */
export function StudentViewBanner({
  onLeave,
  children,
}: {
  onLeave?: (() => void) | undefined;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <ModeBanner
      icon={<Eye />}
      message={t("menu.studentViewBanner")}
      short={t("menu.studentViewBannerShort")}
      action={onLeave ? { label: t("menu.teacherView"), onClick: onLeave } : undefined}
    >
      {children}
    </ModeBanner>
  );
}
