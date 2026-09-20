import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, Pencil, Trash2, UserPlus, Users } from "lucide-react";
import { useState } from "react";

import type { ClassroomDetail } from "@quiz/contracts";

import { api } from "./api";
import { useConfirm } from "./confirm";
import { useT } from "./i18n";
// WP8: evaluation + dashboard
import { EvaluationList } from "./evaluation/EvaluationList";
import { RosterImport } from "./RosterImport";
import { RosterTable } from "./RosterTable";
import type { Route } from "./router";
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
  SectionHeading,
  Skeleton,
} from "./ui";

/**
 * One classroom: its roster, and nothing else yet. The ONE primary action is
 * "Add students" — an empty roster is the only thing that blocks everything
 * a classroom is for.
 */

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
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState(false);

  const room = useQuery<ClassroomDetail>({
    queryKey: ["classroom", id],
    queryFn: () => api(`/app/api/classrooms/${id}`),
  });

  const invalidate = () => qc.invalidateQueries();
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

  return (
    <div className="space-y-6">
      <PageHeader
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
            <Button onClick={() => setImporting(true)}>
              <UserPlus /> {t("roster.add")}
            </Button>
            <Menu
              label={t("common.actions")}
              items={[
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

      <section className="space-y-3">
        <SectionHeading
          icon={Users}
          title={t("roster.title")}
          count={students.length}
          help="roster"
        />
        {data.roster.length === 0 ? (
          <Card>
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
          </Card>
        ) : (
          <Card>
            <RosterTable classroomId={id} roster={data.roster} />
          </Card>
        )}
      </section>

      {/* WP8: evaluation + dashboard */}
      <EvaluationList classroomId={id} navigate={navigate} />

      {importing ? (
        <RosterImport classroomId={id} onClose={() => setImporting(false)} />
      ) : null}
      {renaming ? <RenameModal room={data} onClose={() => setRenaming(false)} /> : null}
    </div>
  );
}
