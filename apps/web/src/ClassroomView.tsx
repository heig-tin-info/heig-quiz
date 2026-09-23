import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  CalendarRange,
  ClipboardList,
  GraduationCap,
  Pencil,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail, EvaluationSummary } from "@quiz/contracts";

import { api, apiErrorMessage, useMe } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
// WP8: evaluation + dashboard
import { EvaluationList } from "./evaluation/EvaluationList";
import { useToast } from "./notify";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import { useSearchParam, type Route } from "./router";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  inputClass,
  Menu,
  PageHeader,
  QueryError,
  Skeleton,
  Tabs,
  Tip,
} from "./ui";
import { classroomKey, evaluationsKey } from "./queryKeys";

/**
 * One classroom: its roster and its evaluations, one tab each.
 *
 * Two lists that never answer the same question sat stacked on one page, so
 * a teacher looking for a quiz scrolled past thirty names to find it. The
 * tabs also settle the primary action: on the roster it is "Add students" —
 * an empty roster is the only thing that blocks everything a classroom is
 * for — and on the evaluations it is the list's own "New evaluation".
 */

type Tab = "roster" | "evaluations";

/**
 * The classroom name, renamed where it is written.
 *
 * Hovering the title reveals a pencil — the affordance that says this name is
 * a control and not a heading — and a click on either the name or the pencil
 * swaps it for an input holding the name, selected. Enter saves, Escape
 * cancels and LEAVING THE FIELD SAVES, the same contract as the points field
 * of the evaluation question list (`evaluation/ItemsStep.tsx`), the app's
 * other edit-in-place: a teacher who clicks away does not silently lose what
 * they typed. A blank name is not a name, so it cancels instead of saving.
 *
 * The request is the PATCH the "Rename" menu item used to open a modal for;
 * the modal is gone, this is the whole of it.
 */
function ClassroomName({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(room.name);

  const rename = useMutation({
    mutationFn: (name: string) =>
      api(`/app/api/classrooms/${room.id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    // The name is on the course page and in the classroom list too, so
    // everything that carries it is dropped, exactly as the modal did.
    onSuccess: () => qc.invalidateQueries(),
    onError: (error) => toast(apiErrorMessage(error, t("classrooms.renameFailed")), "error"),
  });

  if (editing) {
    const commit = () => {
      const next = value.trim();
      setEditing(false);
      if (next !== "" && next !== room.name) rename.mutate(next);
    };
    return (
      <input
        aria-label={t("classrooms.name")}
        value={value}
        autoFocus
        // The whole name is selected, so the common case — a new name rather
        // than an edit of this one — is one keystroke away.
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Both keys unmount the input, so neither leaves a blur behind that
          // would save a second time.
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setValue(room.name);
            setEditing(false);
          }
        }}
        // The title's own type at the height of its own line box (28 px over
        // `leading-tight`, so 36 px), which is what keeps the tabs below from
        // jumping when the heading turns into a field. `size` keeps the field
        // about as wide as what it holds.
        className={cx(
          inputClass,
          "h-9 max-w-full text-[28px] font-bold leading-tight tracking-[-0.02em]",
        )}
        size={Math.max(value.length, 8)}
      />
    );
  }

  return (
    <button
      type="button"
      // The name is IN the label: this button is the whole text of the <h1>,
      // and a bare "Rename classroom" would leave the heading naming no
      // classroom at all. Same shape as the roster's per-row menu label.
      aria-label={t("classrooms.renameName", { name: room.name })}
      onClick={() => {
        // From the server, not from the last edit: another session may have
        // renamed the classroom since this component was mounted.
        setValue(room.name);
        setEditing(true);
      }}
      className="group inline-flex items-center gap-1.5 rounded-sm text-left"
    >
      {/* While the PATCH is in flight the new name is already on screen: the
          old one coming back for one frame reads as a failed save. */}
      <span>{rename.isPending ? (rename.variables ?? room.name) : room.name}</span>
      <Pencil
        aria-hidden
        className="size-5 shrink-0 text-fg-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
      />
    </button>
  );
}

/**
 * The period ("2026-A"), one field in a dialog.
 *
 * The name renames in the title; the period does not, because an empty one
 * leaves nothing on screen to hover and click. One field, so a modal and not
 * a sheet.
 */
function PeriodModal({ room, onClose }: { room: ClassroomDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [period, setPeriod] = useState(room.period);
  const save = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}`, {
        method: "PATCH",
        body: JSON.stringify({ period: period.trim() }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onClose();
    },
    onError: (error) => toast(apiErrorMessage(error, t("error.save")), "error"),
  });
  return (
    <FormDialog
      title={t("classrooms.setPeriod")}
      onClose={onClose}
      onSubmit={() => save.mutate()}
      submitLabel={t("common.save")}
      submitting={save.isPending}
    >
      <Field
        label={t("classrooms.period")}
        fullWidth
        autoFocus
        placeholder={t("classrooms.periodPlaceholder")}
        value={period}
        onChange={(e) => setPeriod(e.target.value)}
      />
    </FormDialog>
  );
}

export function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const me = useMe();
  const [importing, setImporting] = useState(false);
  const [editingPeriod, setEditingPeriod] = useState(false);
  // "" and not a tab name: which tab opens depends on the roster, which is
  // not loaded yet when this runs. The empty value means "whatever the page
  // decides"; a click always writes a real one.
  const [tabParam, setTab] = useSearchParam("tab", "");

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

  const invalidate = () => qc.invalidateQueries();
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
    onError: (error) => toast(apiErrorMessage(error, t("roster.joinFailed")), "error"),
  });
  const archive = useMutation({
    mutationFn: (to: "archive" | "unarchive") =>
      api(`/app/api/classrooms/${id}/${to}`, { method: "POST" }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await invalidate();
      navigate({ view: "home" });
    },
  });

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
  const students = data.roster.filter((r) => !r.staff);
  // An empty roster is what blocks everything, so it is what the page opens
  // on; once there are students, the work is in the evaluations. The teacher's
  // own seat does not count: a classroom holding nothing else is still one to
  // fill.
  const tab: Tab =
    tabParam === "roster" || tabParam === "evaluations"
      ? tabParam
      : students.length > 0
        ? "evaluations"
        : "roster";
  const mine = me.data;
  const seat = mine
    ? data.roster.find(
        (r) => r.userId === mine.id || r.email.toLowerCase() === mine.email.toLowerCase(),
      )
    : undefined;

  return (
    <div className="space-y-6">
      <PageHeader
        help="classroom"
        eyebrow={
          <button
            type="button"
            onClick={() => navigate({ view: "home" })}
            className="hover:text-fg hover:underline"
          >
            {data.course.code} — {data.course.name}
          </button>
        }
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <ClassroomName room={data} />
            {data.period ? (
              <span className="text-base font-normal text-fg-muted">{data.period}</span>
            ) : null}
            {data.archivedAt ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
          </span>
        }
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
                disabled={seat != null}
                loading={join.isPending}
                onClick={() => join.mutate()}
              >
                <GraduationCap /> {t("roster.join")}
              </Button>
            </Tip>
            {/* The roster tab's one primary action. On the evaluations tab the
                list carries its own, and two accent fills would make the
                squint test ambiguous. */}
            {tab === "roster" ? (
              <Button onClick={() => setImporting(true)}>
                <UserPlus /> {t("roster.add")}
              </Button>
            ) : null}
            <Menu
              label={t("common.actions")}
              items={[
                data.archivedAt
                  ? {
                      label: t("classrooms.unarchive"),
                      icon: ArchiveRestore,
                      onSelect: () => archive.mutate("unarchive"),
                    }
                  : {
                      label: t("classrooms.archive"),
                      icon: Archive,
                      onSelect: () => archive.mutate("archive"),
                    },
                {
                  label: t("classrooms.setPeriod"),
                  icon: CalendarRange,
                  onSelect: () => setEditingPeriod(true),
                },
                {
                  label: t("classrooms.delete"),
                  icon: Trash2,
                  danger: true,
                  separator: true,
                  onSelect: async () => {
                    if (
                      await confirm({
                        title: t("classrooms.deleteConfirm", { name: data.name }),
                        confirmLabel: t("common.delete"),
                        cancelLabel: t("common.cancel"),
                        danger: true,
                      })
                    ) {
                      remove.mutate();
                    }
                  },
                },
              ]}
            />
          </>
        }
      />

      <div className="space-y-4">
        <Tabs
          value={tab}
          onChange={setTab}
          label={t("classrooms.tabs")}
          items={[
            // The whole roster, staff seats included: the number on a tab
            // promises the number of rows behind it.
            { value: "roster", label: t("roster.title"), count: data.roster.length, icon: Users },
            {
              value: "evaluations",
              label: t("eval.title"),
              // No number while the list is loading or failed: a "0" that
              // means "not known yet" is worse than no count at all.
              count: evaluations.data?.length,
              icon: ClipboardList,
            },
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
                <RosterTable classroomId={id} roster={data.roster} />
              )}
            </Card>
          </section>
        ) : (
          // WP8: evaluation + dashboard
          <EvaluationList classroomId={id} navigate={navigate} />
        )}
      </div>

      {importing ? (
        <RosterImport classroomId={id} onClose={() => setImporting(false)} />
      ) : null}
      {editingPeriod ? <PeriodModal room={data} onClose={() => setEditingPeriod(false)} /> : null}
    </div>
  );
}
