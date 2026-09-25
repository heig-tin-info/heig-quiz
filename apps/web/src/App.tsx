import { lazy, Suspense, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type { Me, PublicConfig } from "@quiz/contracts";

import { api, useMe } from "./api";
import { Logo } from "./Header";
import { useI18n, useT } from "./i18n";
import { useLiveUpdates } from "./live";
import { CoachLayer } from "./coach/CoachLayer";
import { useRoute, type Navigate, type Route, type RouteOf } from "./router";
import { Shell, StudentViewBanner } from "./Shell";
import {
  enterStudentView,
  leaveStudentView,
  STUDENT_ROUTES,
  studentRouteFor,
  useStudentView,
} from "./studentView";
import { Button, LinkButton, setDateFormat, Spinner } from "./ui";
import { configKey } from "./queryKeys";

// One chunk per page: a student never downloads the teacher UI and vice versa.
const TeacherHome = lazy(() => import("./TeacherHome").then((m) => ({ default: m.TeacherHome })));
// WP9: student player
const StudentHome = lazy(() =>
  import("./student/StudentHome").then((m) => ({ default: m.StudentHome })),
);
const AttemptPage = lazy(() =>
  import("./student/Attempt").then((m) => ({ default: m.AttemptPage })),
);
const Feedback = lazy(() => import("./student/Feedback").then((m) => ({ default: m.Feedback })));
const ClassroomView = lazy(() =>
  import("./ClassroomView").then((m) => ({ default: m.ClassroomView })),
);
// The pool screens (WP7): the teacher's authoring surface, one chunk each,
// so a student — or a teacher who only runs quizzes — never downloads them.
const PoolsPage = lazy(() => import("./pool/PoolsPage").then((m) => ({ default: m.PoolsPage })));
const PoolView = lazy(() => import("./pool/PoolView").then((m) => ({ default: m.PoolView })));
const CategoriesPage = lazy(() =>
  import("./pool/CategoriesPage").then((m) => ({ default: m.CategoriesPage })),
);
const QuestionEditor = lazy(() =>
  import("./question/QuestionEditor").then((m) => ({ default: m.QuestionEditor })),
);
// "See what the student sees" for one question (docs/spec/08 §8.2). Its own
// chunk and its own full-screen page, like the attempt: it IS the player.
const EvaluationPreviewPage = lazy(() =>
  import("./preview/EvaluationPreviewPage").then((m) => ({ default: m.EvaluationPreviewPage })),
);
const StudentPreviewPage = lazy(() =>
  import("./question/StudentPreviewPage").then((m) => ({ default: m.StudentPreviewPage })),
);
// WP8: evaluation + dashboard
const EvaluationConfig = lazy(() =>
  import("./evaluation/EvaluationConfig").then((m) => ({ default: m.EvaluationConfig })),
);
const LiveDashboard = lazy(() =>
  import("./live/LiveDashboard").then((m) => ({ default: m.LiveDashboard })),
);
// WP10: grading + results. Two more page chunks, for the same reason as the
// pool ones: a student never downloads the grading panel, and a teacher who
// only runs quizzes never downloads the results view. (`Feedback` is already
// lazy above: it is the student's page and a teacher only reaches it through
// the student view.)
const GradingPanel = lazy(() =>
  import("./grading/GradingPanel").then((m) => ({ default: m.GradingPanel })),
);
const ResultsView = lazy(() =>
  import("./results/ResultsView").then((m) => ({ default: m.ResultsView })),
);
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const AdminPage = lazy(() => import("./AdminPanel").then((m) => ({ default: m.AdminPage })));
// Development only, and absent from the production bundle: behind the
// `import.meta.env.DEV` constant the dynamic import is dead code, so Rollup
// emits no DevGallery chunk at all. `parsePath` still returns the view; its
// entry in `PAGES` renders the teacher home in its place (no redirect).
const DevGallery = import.meta.env.DEV
  ? lazy(() => import("./DevGallery").then((m) => ({ default: m.DevGallery })))
  : () => null;

/*
 * Signed-out page. The four decisions, so the door looks like the house:
 * - Type: the drawn wordmark at 220 px over the 16 px step for the tagline;
 *   the mark carries the jump a 28 px title used to carry here.
 * - Color: one accent, the sign-in button. The mark brings its own four
 *   colours, as it does in the sidebar; everything else is fg / fg-muted /
 *   fg-faint.
 * - Space: 24 between the mark and the tagline (one group), 32 before the
 *   action, 48 down to the footer.
 * - Finish: a sheet of paper (`surface` + hairline + card radius) on the warm
 *   canvas. No shadow: it sits in the page flow.
 */
function Landing() {
  const t = useT();
  // The one unauthenticated endpoint. A failure is not an error state here:
  // the OIDC button is the real door and it is always there.
  const config = useQuery<PublicConfig>({
    queryKey: configKey,
    queryFn: () => api("/app/api/config"),
    retry: false,
  });
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-115 rounded-card border border-line bg-surface px-8 py-10 text-center">
        {/* The wordmark IS the name, so it is the heading: the 28 px title
            under it used to say "Quiz" a second time. */}
        <h1>
          <Logo className="mx-auto w-55" />
        </h1>
        <p className="mt-6 text-base leading-relaxed text-fg-muted">{t("landing.tagline")}</p>
        <LinkButton href="/app/auth/login" variant="primary" size="lg" className="mt-8 w-full">
          {t("landing.signin")}
        </LinkButton>
        {config.data?.devLogin ? (
          <>
            <Button
              variant="secondary"
              size="lg"
              className="mt-3 w-full"
              onClick={() => {
                window.location.href = "/app/auth/dev";
              }}
            >
              {t("landing.devSignin")}
            </Button>
            <p className="mt-2 text-xs text-fg-faint">{t("landing.devHint")}</p>
          </>
        ) : null}
      </div>
      <p className="mt-12 text-xs text-fg-faint">{t("landing.footer")}</p>
    </main>
  );
}

// The poll screens. The participant page is the ONE route that renders with
// no session at all: a guest who scanned a QR has nothing to log into.
const PollProjection = lazy(() =>
  import("./poll/PollProjection").then((m) => ({ default: m.PollProjection })),
);
const PollJoin = lazy(() => import("./poll/PollJoin").then((m) => ({ default: m.PollJoin })));
const OAuthConsent = lazy(() => import("./oauth/OAuthConsent").then((m) => ({ default: m.OAuthConsent })));
const PollLauncher = lazy(() =>
  import("./poll/PollLauncher").then((m) => ({ default: m.PollLauncher })),
);

/** What every page of the table may need beside its own route. */
interface PageContext {
  me: Me;
  navigate: Navigate;
  /** The teacher UI is on: a teacher or an admin, not in student view. */
  teacherUi: boolean;
}

type Page<V extends Route["view"]> = (route: RouteOf<V>, ctx: PageContext) => ReactNode;

/**
 * The page of every view, ONE entry per member of `Route` (the mapped type
 * makes a missing one a compile error, like `ROUTES` in `router.ts`).
 *
 * The student UI only ever reaches the `studentSafe` entries: `App` sends
 * every other view to `home` first. So a teacher-only entry below can assume
 * the teacher UI, and `home` is the one entry that asks which UI is on.
 */
const PAGES: { readonly [V in Route["view"]]: Page<V> } = {
  home: (_, c) =>
    c.teacherUi ? (
      <TeacherHome navigate={c.navigate} />
    ) : (
      // WP9: student player — the student home is their evaluations.
      <StudentHome me={c.me} navigate={c.navigate} />
    ),
  settings: (_, c) => <SettingsPage me={c.me} />,
  // WP10: the student's own feedback page, reachable in either UI — a teacher
  // checking the student view opens the same page a student does. It is the
  // ONE student results page: WP9's `/results/:id` is gone.
  feedback: (r, c) => <Feedback attemptId={r.attemptId} navigate={c.navigate} />,
  // WP9: student player — the attempt takes the whole screen (`FULL_SCREEN`).
  attempt: (r, c) => <AttemptPage evaluationId={r.evaluationId} navigate={c.navigate} />,
  join: (r, c) => <PollJoin code={r.code} me={c.me} navigate={c.navigate} />,
  oauthConsent: (r, c) => <OAuthConsent id={r.id} me={c.me} />,
  // Invariant 3: the gallery exists in development only. The
  // route parses in every build; this is what refuses to render it.
  devUi: (_, c) => (import.meta.env.DEV ? <DevGallery /> : <TeacherHome navigate={c.navigate} />),
  admin: (_, c) => (c.me.role === "admin" ? <AdminPage /> : <TeacherHome navigate={c.navigate} />),
  classroom: (r, c) => <ClassroomView id={r.id} navigate={c.navigate} />,
  polls: (_, c) => <PollLauncher navigate={c.navigate} />,
  // The projection is for a beamer: no sidebar, no chrome (mockup 10).
  poll: (r, c) => <PollProjection id={r.id} navigate={c.navigate} />,
  pools: (_, c) => <PoolsPage navigate={c.navigate} />,
  pool: (r, c) => <PoolView id={r.id} navigate={c.navigate} />,
  poolCategories: (r, c) => <CategoriesPage id={r.id} navigate={c.navigate} />,
  question: (r, c) => <QuestionEditor id={r.id} navigate={c.navigate} />,
  // The student preview of ONE question: the player, and therefore the whole
  // screen, for exactly the reason the attempt takes it — a preview framed by
  // the teacher's sidebar previews the wrong thing.
  questionPreview: (r) => <StudentPreviewPage id={r.id} />,
  // WP8: evaluation + dashboard
  evaluation: (r, c) => <EvaluationConfig id={r.id} navigate={c.navigate} />,
  live: (r, c) => <LiveDashboard id={r.id} navigate={c.navigate} />,
  // The whole evaluation as a student gets it, statelessly (issue #75): the
  // player, and therefore the whole screen, like the question preview.
  evaluationPreview: (r, c) => <EvaluationPreviewPage id={r.id} navigate={c.navigate} />,
  // WP10: grading + results
  grading: (r, c) => <GradingPanel evaluationId={r.evaluationId} navigate={c.navigate} />,
  results: (r, c) => <ResultsView evaluationId={r.evaluationId} navigate={c.navigate} />,
};

/** The page of `route` (the one cast of the table, as in `router.ts`). */
function renderPage(route: Route, ctx: PageContext): ReactNode {
  return (PAGES[route.view] as Page<Route["view"]>)(route, ctx);
}

/**
 * The views drawn on the whole screen, with no sidebar. The attempt: a zen
 * player beside a navigation sidebar is not a zen player, and an exam is the
 * one place the rest of the app must go away. The question and evaluation previews,
 * for the same reason. The poll projection, for a beamer. And the join page, which a
 * guest with no account reaches as well.
 */
const FULL_SCREEN: ReadonlySet<Route["view"]> = new Set([
  "attempt",
  "questionPreview",
  "evaluationPreview",
  "poll",
  "join",
  "oauthConsent",
]);

/**
 * The views drawn inside the frame but WITHOUT the reading-width cap of the
 * shell. The live dashboard only: its grid is a matrix that grows with the
 * number of questions, and at 70 rem it scrolled sideways between two empty
 * margins (#93). Every other page keeps the cap.
 */
const WIDE: ReadonlySet<Route["view"]> = new Set(["live"]);

/**
 * No session. The participant of a poll may have no account
 * (`settings.poll.anonymous`), and the page itself sends to login otherwise.
 * The OAuth consent page is the other one: it offers the sign-in with a
 * `next` back to itself. Everything else is the landing page.
 */
function SignedOut({ route, navigate }: { route: Route; navigate: (r: Route) => void }) {
  if (route.view === "join") {
    return (
      <Suspense fallback={<Spinner className="py-24" />}>
        <PollJoin code={route.code} me={null} navigate={navigate} />
      </Suspense>
    );
  }
  // An assistant's sign-in (ADR-023) must come back to its consent page.
  if (route.view === "oauthConsent") {
    return (
      <Suspense fallback={<Spinner className="py-24" />}>
        <OAuthConsent id={route.id} me={null} />
      </Suspense>
    );
  }
  return <Landing />;
}

/**
 * The student-view switch, both ways. Going IN remembers the page it was
 * thrown from and lands on that page's student twin — the evaluation's own
 * `/take/:id` for the two screens that have one, the student home otherwise
 * (`studentRouteFor`). Coming OUT goes back to the page it was thrown from
 * (ADR-018), so the walk that began on a live dashboard ends on it and not on
 * the teacher home.
 */
function toggleStudentView(inStudentView: boolean, route: Route, navigate: (r: Route) => void) {
  if (inStudentView) navigate(leaveStudentView());
  else {
    enterStudentView(route);
    navigate(studentRouteFor(route));
  }
}

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  // Persisted, with the route to come back to (`studentView.ts`, ADR-018).
  const studentView = useStudentView();
  const { setLocale } = useI18n();
  // The hint stream drives a blanket `invalidateQueries()`, which is right on
  // a teacher screen and wrong during an exam: `/take/:id` runs on a POST
  // behind a query (`AttemptPage`), and invalidating it mid-flight cancels the
  // in-flight refetch — the lobby then never advances to the player, however
  // many 200s the server sends. The player and the lobby carry their own watch
  // stream (`attempt:`/`evaluation:`), which delivers the start, the deadline,
  // the pause and the closure as typed frames, so the attempt route needs no
  // hints at all.
  useLiveUpdates(me.data != null && route.view !== "attempt");
  // The account's saved language wins on load, so the choice follows the user
  // across devices (no re-persist: adopt only).
  const serverLocale = me.data?.locale ?? null;
  useEffect(() => {
    if (serverLocale) setLocale(serverLocale, false);
  }, [serverLocale, setLocale]);
  // Same for the date format, but synchronously: it must be set before the
  // first view renders a date (module-level store in ui/page.tsx, idempotent).
  setDateFormat(me.data?.dateFormat);

  // The role computation, once: a teacher (or an admin) in the teacher UI,
  // or in their own student view; everybody else is a student.
  const teacher = me.data?.role === "teacher" || me.data?.role === "admin";
  const inStudentView = teacher && studentView;
  const teacherUi = teacher && !inStudentView;
  // The student UI has a screen for the student-safe views only; every other
  // one is the student home. The address bar must name the page the reader
  // got: `replaceState` and not `navigate`, because there is nothing to go
  // back to, the screen does not change, and pushing a second entry would
  // make Back a no-op.
  const onTeacherRoute = me.data != null && !teacherUi && !STUDENT_ROUTES.has(route.view);
  useEffect(() => {
    if (onTeacherRoute) window.history.replaceState(null, "", "/");
  }, [onTeacherRoute]);

  if (me.isLoading) return null;
  if (!me.data) return <SignedOut route={route} navigate={navigate} />;
  const shown: Route = onTeacherRoute ? { view: "home" } : route;
  const page = (
    <Suspense fallback={<Spinner className="py-24" />}>
      {renderPage(shown, { me: me.data, navigate, teacherUi })}
    </Suspense>
  );
  const toggleView = teacher
    ? () => toggleStudentView(inStudentView, route, navigate)
    : undefined;
  if (FULL_SCREEN.has(shown.view)) {
    // The attempt has no frame, and so no Teacher | Student switch: the
    // banner carries the way back, which leaves the attempt open (ADR-018).
    return inStudentView && shown.view === "attempt" ? (
      <>
        <StudentViewBanner onLeave={toggleView} />
        {page}
      </>
    ) : (
      page
    );
  }

  return (
    <>
    <Shell
      me={me.data}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
      studentView={inStudentView}
      onToggleStudentView={toggleView}
      wide={WIDE.has(shown.view)}
    >
      {page}
    </Shell>
    {/* Inside the frame only: a full-screen view (an exam, a projection)
        returned above and never gets a bubble. */}
    <CoachLayer me={me.data} view={shown.view} teacherUi={teacherUi} />
    </>
  );
}
