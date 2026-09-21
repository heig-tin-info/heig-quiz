import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { PublicConfig } from "@quiz/contracts";

import { api, useMe } from "./api";
import { Logo } from "./Header";
import { useI18n, useT } from "./i18n";
import { useLiveUpdates } from "./live";
import { useRoute, type Route } from "./router";
import { Shell } from "./Shell";
import { Button, LinkButton, setDateFormat, Spinner } from "./ui";

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
const QuestionEditor = lazy(() =>
  import("./question/QuestionEditor").then((m) => ({ default: m.QuestionEditor })),
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
// Development only. The chunk is still built in production (Vite has no way
// to know otherwise), but nothing routes to it: `parsePath` returns the view
// and the guard below sends it home.
const DevGallery = lazy(() => import("./DevGallery").then((m) => ({ default: m.DevGallery })));

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
    queryKey: ["config"],
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

// Persisted teacher choice: "student" keeps the student view across reloads.
const VIEW_AS_KEY = "quiz-view-as";

/**
 * The routes a student (or a teacher in student view) actually has a screen
 * for. Everything else falls through to `StudentHome` — which is right — but
 * it used to render it UNDER the teacher URL, so a reload or a Back landed
 * on the same wrong address again (W20).
 */
const STUDENT_ROUTES = new Set<Route["view"]>(["home", "settings", "feedback", "attempt"]);

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  const [studentView, setStudentView] = useState(
    () => localStorage.getItem(VIEW_AS_KEY) === "student",
  );
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
  // first view renders a date (module-level store in ui.tsx, idempotent).
  setDateFormat(me.data?.dateFormat);

  // The address bar must name the page the reader got. `replaceState` and not
  // `navigate`: there is nothing to go back to, the screen does not change,
  // and pushing a second entry would make Back a no-op.
  const viewer = me.data;
  const onTeacherRoute =
    viewer != null &&
    !STUDENT_ROUTES.has(route.view) &&
    !((viewer.role === "teacher" || viewer.role === "admin") && !studentView);
  useEffect(() => {
    if (onTeacherRoute) window.history.replaceState(null, "", "/");
  }, [onTeacherRoute]);

  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  const role = me.data.role;
  const teacher = role === "teacher" || role === "admin";
  const inStudentView = teacher && studentView;
  const teacherUi = teacher && !inStudentView;

  // WP9: student player — the attempt takes the whole screen. A zen player
  // (one question, one action) beside a navigation sidebar is not a zen
  // player, and an exam is the one place the rest of the app must go away.
  if (route.view === "attempt") {
    return (
      <Suspense fallback={<Spinner className="py-24" />}>
        <AttemptPage evaluationId={route.evaluationId} navigate={navigate} />
      </Suspense>
    );
  }

  const page =
    route.view === "settings" ? (
      <SettingsPage me={me.data} />
    ) : // WP10: the student's own feedback page, reachable in either UI — a
    // teacher checking the student view opens the same page a student does.
    // It is the ONE student results page: WP9's `/results/:id` is gone.
    route.view === "feedback" ? (
      <Feedback attemptId={route.attemptId} />
    ) : !teacherUi ? (
      <StudentHome me={me.data} navigate={navigate} />
    ) : route.view === "devUi" && import.meta.env.DEV ? (
      <DevGallery />
    ) : route.view === "admin" && role === "admin" ? (
      <AdminPage />
    ) : route.view === "classroom" ? (
      <ClassroomView id={route.id} navigate={navigate} />
    ) : route.view === "pools" ? (
      <PoolsPage navigate={navigate} />
    ) : route.view === "pool" ? (
      <PoolView id={route.id} navigate={navigate} />
    ) : route.view === "question" ? (
      <QuestionEditor id={route.id} navigate={navigate} />
    ) : // WP8: evaluation + dashboard
    route.view === "evaluation" ? (
      <EvaluationConfig id={route.id} navigate={navigate} />
    ) : route.view === "live" ? (
      <LiveDashboard id={route.id} navigate={navigate} />
    ) : // WP10: grading + results
    route.view === "grading" ? (
      <GradingPanel evaluationId={route.evaluationId} navigate={navigate} />
    ) : route.view === "results" ? (
      <ResultsView evaluationId={route.evaluationId} navigate={navigate} />
    ) : (
      <TeacherHome navigate={navigate} />
    );

  return (
    <Shell
      me={me.data}
      route={route}
      navigate={navigate}
      teacherUi={teacherUi}
      studentView={inStudentView}
      onToggleStudentView={
        teacher
          ? () => {
              setStudentView((v) => {
                localStorage.setItem(VIEW_AS_KEY, v ? "teacher" : "student");
                return !v;
              });
              navigate({ view: "home" });
            }
          : undefined
      }
    >
      <Suspense fallback={<Spinner className="py-24" />}>{page}</Suspense>
    </Shell>
  );
}
