import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  ClipboardList,
  GraduationCap,
  Pencil,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail } from "@quiz/contracts";

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
  EmptyState,
  Field,
  Menu,
  Modal,
  PageHeader,
  QueryError,
  Skeleton,
  Tabs,
} from "./ui";

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

function RenameModal({ room, onClose }: { room: ClassroomDetail; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: room.name, period: room.period });
  const save = useMutation({
    mutationFn: () =>
      api(`/app/api/classrooms/${room.id}`, { method: "PATCH", body: JSON.stringify(form) }),
    onSuccess: async () => {
      await qc.invalidateQueries();
      onClose();
    },
  });
  return (
    <Modal
      title={t("classrooms.rename")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field
          label={t("classrooms.name")}
          required
          fullWidth
          autoFocus
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Field
          label={t("classrooms.period")}
          fullWidth
          value={form.period}
          onChange={(e) => setForm({ ...form, period: e.target.value })}
        />
      </div>
    </Modal>
  );
}

export function ClassroomView({ id, navigate }: { id: string; navigate: (r: Route) => void }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const me = useMe();
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // "" and not a tab name: which tab opens depends on the roster, which is
  // not loaded yet when this runs. The empty value means "whatever the page
  // decides"; a click always writes a real one.
  const [tabParam, setTab] = useSearchParam("tab", "");

  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });

  const invalidate = () => qc.invalidateQueries();
  /**
   * The teacher takes a (staff) seat in their own classroom, to walk the
   * student flow without a second account. It stays out of the headcount.
   */
  const join = useMutation({
    mutationFn: () => api(`/app/api/classrooms/${id}/self-enroll`, { method: "POST" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["classroom", id] });
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
  // on; once there are students, the work is in the evaluations.
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
            {data.name}
            {data.period ? (
              <span className="text-base font-normal text-fg-muted">{data.period}</span>
            ) : null}
            {data.archivedAt ? <Badge tone="zinc">{t("classrooms.archived")}</Badge> : null}
          </span>
        }
        actions={
          <>
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
                {
                  label: seat ? t("roster.joined") : t("roster.join"),
                  icon: GraduationCap,
                  // The state when the menu opened: a seat already taken is
                  // not an action, it is an answer.
                  disabled: seat != null,
                  onSelect: () => join.mutate(),
                },
                { label: t("classrooms.rename"), icon: Pencil, onSelect: () => setRenaming(true) },
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
            { value: "roster", label: t("roster.title"), count: students.length, icon: Users },
            { value: "evaluations", label: t("eval.title"), icon: ClipboardList },
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
      {renaming ? <RenameModal room={data} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}
