import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import type { PublicConfig } from "@quiz/contracts";

import { api, useMe } from "./api";
import { Logo } from "./Header";
import { useI18n, useT } from "./i18n";
import { useLiveUpdates } from "./live";
import { useRoute } from "./router";
import { Shell } from "./Shell";
import { Button, LinkButton, setDateFormat, Spinner } from "./ui";

// One chunk per page: a student never downloads the teacher UI and vice versa.
const TeacherHome = lazy(() => import("./TeacherHome").then((m) => ({ default: m.TeacherHome })));
const StudentHome = lazy(() => import("./StudentHome").then((m) => ({ default: m.StudentHome })));
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
// WP10: grading + results. Three more page chunks, for the same reason as
// the pool ones: a student never downloads the grading panel, and a teacher
// who only runs quizzes never downloads the student feedback page.
const GradingPanel = lazy(() =>
  import("./grading/GradingPanel").then((m) => ({ default: m.GradingPanel })),
);
const ResultsView = lazy(() =>
  import("./results/ResultsView").then((m) => ({ default: m.ResultsView })),
);
const Feedback = lazy(() => import("./student/Feedback").then((m) => ({ default: m.Feedback })));
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })));
const AdminPage = lazy(() => import("./AdminPanel").then((m) => ({ default: m.AdminPage })));
// Development only. The chunk is still built in production (Vite has no way
// to know otherwise), but nothing routes to it: `parsePath` returns the view
// and the guard below sends it home.
const DevGallery = lazy(() => import("./DevGallery").then((m) => ({ default: m.DevGallery })));

/*
 * Signed-out page. The four decisions, so the door looks like the house:
 * - Type: the page-title step (28 px / 700 / -0.02em) over the 16 px step for
 *   the tagline, the same 2x jump every page header uses.
 * - Color: one accent, the sign-in button. The mark keeps the red square it
 *   has in the sidebar; everything else is fg / fg-muted / fg-faint.
 * - Space: 20 between the mark and the name, 12 between the name and the
 *   tagline (one group), 32 before the action, 48 down to the footer.
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
        <Logo className="size-7" />
        <h1 className="mt-5 text-[28px] font-bold leading-tight tracking-[-0.02em]">
          {t("app.title")}
        </h1>
        <p className="mt-3 text-base leading-relaxed text-fg-muted">{t("landing.tagline")}</p>
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

export default function App() {
  const me = useMe();
  const [route, navigate] = useRoute();
  const [studentView, setStudentView] = useState(
    () => localStorage.getItem(VIEW_AS_KEY) === "student",
  );
  const { setLocale } = useI18n();
  useLiveUpdates(me.data != null);
  // The account's saved language wins on load, so the choice follows the user
  // across devices (no re-persist: adopt only).
  const serverLocale = me.data?.locale ?? null;
  useEffect(() => {
    if (serverLocale) setLocale(serverLocale, false);
  }, [serverLocale, setLocale]);
  // Same for the date format, but synchronously: it must be set before the
  // first view renders a date (module-level store in ui.tsx, idempotent).
  setDateFormat(me.data?.dateFormat);
  if (me.isLoading) return null;
  if (!me.data) return <Landing />;
  const role = me.data.role;
  const teacher = role === "teacher" || role === "admin";
  const inStudentView = teacher && studentView;
  const teacherUi = teacher && !inStudentView;

  const page =
    route.view === "settings" ? (
      <SettingsPage me={me.data} />
    ) : // WP10: the student's own feedback page, reachable in either UI — a
    // teacher checking the student view opens the same page a student does.
    route.view === "feedback" ? (
      <Feedback attemptId={route.attemptId} />
    ) : !teacherUi ? (
      <StudentHome />
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
