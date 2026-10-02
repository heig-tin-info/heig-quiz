import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  ClipboardList,
  Dumbbell,
  GraduationCap,
  Settings as SettingsIcon,
  UserPlus,
  Users,
} from "lucide-react";
import { useEffect, useState } from "react";

import { ClassroomPatch, type ClassroomDetail, type EvaluationSummary } from "@quiz/contracts";

import { NewActivity } from "./activities/NewActivity";
import { api, useMe } from "./api";
import { PeriodFields, periodBody, periodInvalid, type PeriodDraft } from "./ClassroomPeriod";
import { ClassroomSettings } from "./ClassroomSettings";
import { ClassroomDrill } from "./drill/ClassroomDrill";
import { githubAbsent, useClassroomGithub } from "./github/api";
import { useT } from "./i18n";
import { useStaffJournal } from "./journal/api";
import { JournalReader } from "./journal/JournalReader";
// WP8: evaluation + dashboard
import { EvaluationList, NewEvaluationModal } from "./evaluation/EvaluationList";
import { useErrorToast, useToast } from "./notify";
import { ProjectGroup } from "./project/ProjectGroup";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import { useSearchParam, type ClassroomQueryTab, type Navigate, type Route } from "./router";
import { useScreenCommands } from "./screenCommands";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FormDialog,
  GithubIcon,
  PageHeader,
  ParentLink,
  QueryError,
  Skeleton,
  Tabs,
  Tip,
} from "./ui";
import { classroomKey, evaluationsKey } from "./queryKeys";
import { invalidateHint } from "./realtime/hints";

/**
 * One classroom: its roster, its evaluations, its drill and its settings,
 * one tab each.
 *
 * Two lists that never answer the same question sat stacked on one page, so
 * a teacher looking for a quiz scrolled past thirty names to find it. The
 * tabs also settle the primary action, and the page header carries it in the
 * same slot whichever tab is open: "Add students" on the roster — an empty
 * roster is the only thing that blocks everything a classroom is for — and
 * "New evaluation" on the evaluations (#295), a "New ▾" of Evaluation and
 * Project since M3-10 (`NewActivity`), whose projects are a group under the
 * evaluations (`ProjectGroup`). The third tab, the drill
 * (ADR-041, #317), is a read view — each student's practice — so the slot
 * stays empty there. The fourth, Settings (F-ORG-13, D24), is a route of its
 * own (`/classrooms/:id/settings`): rename, archive, delete and the drill
 * switch moved there from the header and the Drill tab, beside GitHub; its
 * one accent is its own ("Connect to GitHub"), so the header's slot stays
 * empty there too. The header keeps the name and the period. The Journal
 * (F-JRN-07, M4-05) is a route too (`/classrooms/:id/journal/<path>`), and a
 * tab only while the classroom has a journal (F-JRN-01): the reader, whose
 * staff bar holds Refresh; Edit, its primary inside a page, is M4-06's.
 */

type RouteTab = "journal" | "settings";
export type ClassroomTab = ClassroomQueryTab | RouteTab;
type Tab = ClassroomTab;

/**
 * The tabs that are routes of their own (`/classrooms/:id/<tab>`), not a
 * `?tab=` on the classroom's address: the Journal and the Settings.
 */
const ROUTE_TABS: Record<RouteTab, (id: string) => Route> = {
  journal: (id) => ({ view: "classroomJournal", id }),
  settings: (id) => ({ view: "classroomSettings", id }),
};
const isRouteTab = (t: Tab): t is RouteTab => t in ROUTE_TABS;

/**
 * The period: its dates and its label (F-ORG-03, #156), in a dialog.
 *
 * It opens from the period beside the title, and from the "Set period" link
 * that stands there when there is none (#295): an empty period still has
 * something on screen to click. It does not edit in place like the name,
 * because it is two fields (the dates with their presets, and the label) —
 * so a modal, and not a sheet.
 */
function PeriodModal({ room, onClose }: { room: ClassroomDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toastError = useErrorToast();
  const [draft, setDraft] = useState<PeriodDraft>({
    period: room.period,
    periodStart: room.periodStart ?? "",
    periodEnd: room.periodEnd ?? "",
  });
  const body = ClassroomPatch.safeParse(periodBody(draft));
  const save = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}`, {
        method: "PATCH",
        body: JSON.stringify(body.data),
      }),
    onSuccess: async () => {
      await invalidateHint(qc, ["classrooms"]);
      onClose();
    },
    onError: toastError("error.save"),
  });
  return (
    <FormDialog
      title={t("classrooms.setPeriod")}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel={t("common.save")}
      submitting={save.isPending}
      canSubmit={body.success}
    >
      <PeriodFields value={draft} onChange={setDraft} invalid={periodInvalid(body)} />
    </FormDialog>
  );
}

/**
 * The period beside the title, as the door to its dialog (#295): the label —
 * or the months, for a dated period left without one — in the title's quiet
 * 16 px grey, with no pencil, since it is a detail of the name and not a
 * second title. Same hover as ParentLink. Without a period it reads "Set
 * period", so there is always something to click.
 */
function PeriodLink({ room, onOpen }: { room: ClassroomDetail; onOpen: () => void }) {
  const t = useT();
  const value =
    room.period ||
    (room.periodStart && room.periodEnd ? `${room.periodStart} – ${room.periodEnd}` : "");
  return (
    <button
      type="button"
      onClick={onOpen}
      // The value is in the name, as the classroom's is in its rename button.
      aria-label={value ? t("classrooms.changePeriod", { period: value }) : undefined}
      className="text-base font-normal text-fg-muted transition-colors hover:text-fg hover:underline"
    >
      {value || t("classrooms.setPeriodLink")}
    </button>
  );
}

export function ClassroomView({
  id,
  navigate,
  routeTab,
  journalPath,
}: {
  id: string;
  navigate: Navigate;
  /** The tab the route names, for a tab that is a route (`ROUTE_TABS`). */
  routeTab?: Tab;
  /** On the Journal tab, the page the address names (absent: the journal's home). */
  journalPath?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const toastError = useErrorToast();
  const me = useMe();
  const [importing, setImporting] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState(false);
  const [creating, setCreating] = useState(false);
  // The evaluations are where the page opens, whatever the roster holds: the
  // sidebar and the course page land there, the Roster is one click away.
  const [tabParam, setTab] = useSearchParam("tab", "evaluations");
  // The Settings' GitHub connect sheet, in the address so the palette's
  // "Connect this classroom to GitHub" can open it from any tab.
  const [connectParam, setConnect] = useSearchParam("connect", "");
  const github = useClassroomGithub(id);
  // F-JRN-01: the Journal tab exists exactly while the classroom has a
  // journal, in either mode (ADR-057). A 404 is no journal routes: no tab.
  const journal = useStaffJournal(id);
  const hasJournal = journal.data?.mode != null;
  const noJournal = journal.data?.mode === null || githubAbsent(journal.error);

  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(id),
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });
  /**
   * The evaluations, for the number on their tab. It is the query the list
   * itself runs, key included, so the count and the rows are one cache entry
   * and can never disagree — a count carried by the classroom payload would
   * still read "2" the moment after a third evaluation was created.
   */
  const evaluations = useQuery<EvaluationSummary[]>({
    queryKey: evaluationsKey(id),
    queryFn: () => api(`/app/api/classrooms/${id}/evaluations`),
  });

  /**
   * The teacher takes a (staff) seat in their own classroom, to walk the
   * student flow without a second account. It stays out of the headcount.
   */
  const join = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}/self-enroll`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: classroomKey(id) });
      toast(t("roster.joinDone"), "success");
    },
    onError: toastError("roster.joinFailed"),
  });

  /** A tab: a route of its own (`ROUTE_TABS`), or a `?tab=` on the classroom's address. */
  const openTab = (next: Tab) => {
    if (isRouteTab(next)) navigate(ROUTE_TABS[next](id));
    else if (routeTab) navigate({ view: "classroom", id, tab: next });
    else setTab(next);
  };
  const openConnect = () => {
    if (routeTab !== "settings") openTab("settings");
    setConnect("1");
  };
  const link = github.data?.link;
  // The Journal's address on a classroom without one (removed meanwhile, or
  // no App): the classroom's page, in place, rather than an error.
  useEffect(() => {
    if (routeTab === "journal" && noJournal) navigate({ view: "classroom", id }, { replace: true });
  }, [routeTab, noJournal, navigate, id]);
  // F-GH-02: the palette's door to the connect sheet, on a classroom that
  // has none (and on a platform whose App exists: the route answered).
  useScreenCommands(
    github.data && link === null
      ? [
          {
            id: "classroom-github-connect",
            label: t("github.connectTitle"),
            icon: GithubIcon,
            group: "action",
            run: openConnect,
          },
        ]
      : [],
  );

  if (room.isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (room.isError || !room.data) {
    return (
      <QueryError
        title={t("classrooms.notFound")}
        error={room.error}
        onRetry={() => void room.refetch()}
        retrying={room.isFetching}
        fallback={t("error.server")}
      />
    );
  }

  const data = room.data;
  const tab: Tab =
    routeTab ?? (tabParam === "roster" || tabParam === "drill" ? tabParam : "evaluations");
  const mine = me.data;
  const seat = mine
    ? data.roster.find(
        (r) => r.userId === mine.id || r.email.toLowerCase() === mine.email.toLowerCase(),
      )
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <ParentLink onClick={() => navigate({ view: "course", id: data.course.id })}>
            {data.course.code} — {data.course.name}
          </ParentLink>
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            {data.name}
            <PeriodLink room={data} onOpen={() => setEditingPeriod(true)} />
            {data.archivedAt ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
            {link ? (
              <Badge tone="zinc" icon={GithubIcon}>
                {link.org.login}
              </Badge>
            ) : null}
          </span>
        }
        help="classroom"
        actions={
          <>
            {/* Secondary, and to the left of the primary: it is a detour into
                the student view, not what the page is for. A seat already
                taken is not an action but an answer — the button stays and
                says so on hover, rather than vanishing and shifting the row
                under the pointer. */}
            <Tip label={seat ? t("roster.joined") : null}>
              <Button
                variant="secondary"
                data-coach="classroom.join"
                disabled={seat != null}
                loading={join.isPending}
                onClick={() => join.mutate()}
              >
                <GraduationCap /> {t("roster.join")}
              </Button>
            </Tip>
            {/* The open tab's one primary action, always in this slot: the
                page never shows both, so the squint test has one answer. */}
            {tab === "roster" ? (
              <Button data-coach="classroom.add" onClick={() => setImporting(true)}>
                <UserPlus /> {t("roster.add")}
              </Button>
            ) : tab === "evaluations" ? (
              <NewActivity
                classroomId={id}
                github={github.isSuccess ? github.data : undefined}
                navigate={navigate}
                onEvaluation={() => setCreating(true)}
                onConnect={openConnect}
              />
            ) : null}
          </>
        }
      />

      <div className="space-y-4">
        <Tabs
          value={tab}
          onChange={openTab}
          label={t("classrooms.tabs")}
          items={[
            {
              value: "evaluations",
              label: t("eval.title"),
              // No number while the list is loading or failed: a "0" that
              // means "not known yet" is worse than no count at all.
              count: evaluations.data?.length,
              icon: ClipboardList,
              coach: "classroom.tab.evaluations",
            },
            ...(hasJournal ? [{ value: "journal" as const, label: t("journal.tab"), icon: BookOpen }] : []),
            // ADR-041 (#317): the students' drill, and its switch.
            { value: "drill", label: t("nav.drill"), icon: Dumbbell },
            // The whole roster, staff seats included: the number on a tab
            // promises the number of rows behind it. Last before Settings:
            // the content tabs come first, the people and the setup after.
            { value: "roster", label: t("roster.title"), count: data.roster.length, icon: Users },
            { value: "settings", label: t("classroomSettings.tab"), icon: SettingsIcon },
          ]}
        />

        {tab === "roster" ? (
          <section className="space-y-3">
            {/* No heading: the tab above already names and counts it. */}
            <Card>
              {data.roster.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title={t("roster.empty.title")}
                  action={
                    <Button onClick={() => setImporting(true)}>
                      <UserPlus /> {t("roster.add")}
                    </Button>
                  }
                >
                  {t("roster.empty.body")}
                </EmptyState>
              ) : (
                <RosterTable
                  classroomId={id}
                  roster={data.roster}
                  // ADR-054: a link to act as a student takes Super Powers.
                  canImpersonate={me.data?.session?.superPowersUntil != null}
                />
              )}
            </Card>
          </section>
        ) : tab === "evaluations" ? (
          <div className="space-y-8">
            {/* WP8: evaluation + dashboard */}
            <EvaluationList classroomId={id} navigate={navigate} onNew={() => setCreating(true)} />
            {/* M3-10: the projects, a group of their own under the evaluations. */}
            <ProjectGroup classroomId={id} navigate={navigate} />
          </div>
        ) : tab === "journal" ? (
          <JournalReader classroomId={id} path={journalPath} navigate={navigate} studentView={false} />
        ) : tab === "drill" ? (
          <ClassroomDrill room={data} onSettings={() => openTab("settings")} />
        ) : (
          <ClassroomSettings
            room={data}
            navigate={navigate}
            connecting={connectParam === "1"}
            onConnecting={(open) => setConnect(open ? "1" : "")}
          />
        )}
      </div>

      {importing ? (
        <RosterImport classroomId={id} onClose={() => setImporting(false)} />
      ) : null}
      {editingPeriod ? <PeriodModal room={data} onClose={() => setEditingPeriod(false)} /> : null}
      {creating ? (
        <NewEvaluationModal
          classroomId={id}
          onClose={() => setCreating(false)}
          onCreated={(evaluation) => {
            setCreating(false);
            navigate({ view: "evaluation", id: evaluation });
          }}
        />
      ) : null}
    </div>
  );
}
