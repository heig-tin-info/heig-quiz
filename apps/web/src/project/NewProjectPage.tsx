import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, RotateCw } from "lucide-react";
import { useState, type FormEvent } from "react";

import type {
  ClassroomDetail,
  ProjectCreate,
  ProjectSourceDetail,
  ProjectSourceRepo,
  ProjectSummary,
} from "@quiz/contracts";

import { api } from "../api";
import { toLocalInput } from "../evaluation/timing";
import { useT } from "../i18n";
import { useToast } from "../notify";
import {
  activitiesKey,
  classroomGroupSetsKey,
  classroomKey,
  classroomProjectsKey,
  projectSourceKey,
  projectSourcesKey,
} from "../queryKeys";
import type { Navigate } from "../router";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  FieldError,
  fieldErrorProps,
  GithubIcon,
  PageHeader,
  ParentLink,
  QueryError,
  RelativeTime,
  Select,
  Skeleton,
} from "../ui";
import {
  byDuration,
  emptyDraft,
  FIELD_ID,
  foreignZone,
  projectBody,
  refusalPlace,
  type ProjectDraft,
  type ProjectField,
} from "./newProject";
import { ProjectAdvanced } from "./ProjectAdvanced";

/** The fields under "Advanced options": a message there unfolds it. */
const ADVANCED_FIELDS: readonly ProjectField[] = ["grace", "groupSet"];

/**
 * The new project (F-PROJ-01, M3-11), one page at `/classrooms/:id/projects/
 * new`, one primary action: **Create**, which builds the students'
 * distribution repository and leaves a draft. Publishing is the project
 * page's (F-PROJ-13).
 *
 * The novice reads three fields (docs/spec/08): a name, a source picked from
 * the organization (most recently pushed first, as the API sorts them), a
 * deadline. Everything else keeps its default under "Advanced options",
 * folded and not remembered, like an evaluation's — and the protected files
 * the source holds are sent even while it stays folded, read from the
 * source's detail as soon as one is picked.
 *
 * Times are the browser's zone (`datetime-local`, as for an evaluation),
 * named under the dates when it is not the school's (`SCHOOL_TIME_ZONE`).
 *
 * A refusal is said where it belongs: the source, the deadline, the name; a
 * classroom that is not (or no longer) connected replaces the form with the
 * way to its Settings' connect sheet; a failed build stays above the form,
 * the values kept for the retry. The create takes seconds: once sent, the
 * whole form is disabled and Create says what is happening, nothing more.
 */
export function NewProjectPage({ classroomId, navigate }: { classroomId: string; navigate: Navigate }) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState<ProjectDraft>(emptyDraft);
  const [tried, setTried] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [reading, setReading] = useState(false);

  const room = useQuery<ClassroomDetail>({
    queryKey: classroomKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}`),
  });
  const sources = useQuery<ProjectSourceRepo[]>({
    queryKey: projectSourcesKey(classroomId),
    queryFn: () => api(`/app/api/classrooms/${classroomId}/projects/sources`),
  });
  /** One source in detail: its branches, its tree, the protected files it suggests. */
  const detailOf = (repo: string) => ({
    queryKey: projectSourceKey(classroomId, repo),
    queryFn: () =>
      api<ProjectSourceDetail>(`/app/api/classrooms/${classroomId}/projects/sources/${encodeURIComponent(repo)}`),
  });
  const detail = useQuery({ ...detailOf(draft.sourceRepo), enabled: draft.sourceRepo !== "" });

  const create = useMutation({
    mutationFn: (body: ProjectCreate) =>
      api<ProjectSummary>(`/app/api/classrooms/${classroomId}/projects`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: async (project) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: classroomProjectsKey(classroomId) }),
        qc.invalidateQueries({ queryKey: activitiesKey }),
      ]);
      toast(t("project.created"), "success");
      navigate({ view: "project", id: project.id });
    },
    onError: (error) => {
      const place = refusalPlace(error);
      if (place?.at === "field" && place.field === "source") {
        // The organization moved under the form: read it again.
        void qc.invalidateQueries({ queryKey: projectSourcesKey(classroomId) });
        if (place.branches) setAdvanced(true);
      }
      if (place?.at === "field" && place.field === "groupSet") {
        // The set was deleted under the form: read the sets again, clear the
        // choice, keep the refusal said under the field.
        void qc.invalidateQueries({ queryKey: classroomGroupSetsKey(classroomId) });
        setDraft((d) => ({ ...d, groupSetId: null }));
        setAdvanced(true);
      }
    },
  });
  const refusal = refusalPlace(create.error);

  /** A change to the form; a refusal stops standing once the teacher acts on it. */
  const update = (patch: Partial<ProjectDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (create.isError) create.reset();
  };

  const back = () => navigate({ view: "classroom", id: classroomId });
  const header = (
    <PageHeader
      eyebrow={
        room.data ? <ParentLink onClick={back}>{room.data.name}</ParentLink> : <Skeleton className="h-4 w-24" />
      }
      title={t("project.new")}
      description={t("project.new.desc")}
    />
  );

  const pageRefusal = refusal?.at === "page" ? refusal.code : sourcesRefusal(sources.error);
  if (pageRefusal) {
    return (
      <div className="space-y-6">
        {header}
        <Card className="px-6 py-4">
          <EmptyState
            icon={GithubIcon}
            title={t(pageRefusal === "not_connected" ? "project.notConnected.title" : "project.appNotInstalled.title")}
            action={
              <Button onClick={() => navigate({ view: "classroomSettings", id: classroomId, connect: true })}>
                {t("github.connectTitle")}
              </Button>
            }
          >
            {t(pageRefusal === "not_connected" ? "project.notConnected.body" : "project.appNotInstalled.body")}
          </EmptyState>
        </Card>
      </div>
    );
  }
  if (sources.isError) {
    return (
      <div className="space-y-6">
        {header}
        <QueryError
          title={t("project.sourcesFailed")}
          error={sources.error}
          onRetry={() => void sources.refetch()}
          retrying={sources.isFetching}
        />
      </div>
    );
  }

  const built = projectBody(draft, detail.data);
  const shown = tried && built.missing ? built.missing : {};
  /** The message under a field: a source that could not be read, the server's refusal, else what the form misses. */
  const message = (field: ProjectField): string | undefined => {
    if (field === "source" && detail.isError) return t("project.source.detailFailed");
    if (refusal?.at === "field" && refusal.field === field) {
      return t(refusal.message, { branches: refusal.branches?.join(", ") ?? "" });
    }
    const key = shown[field];
    return key ? t(key) : undefined;
  };
  const advancedOpen = advanced || ADVANCED_FIELDS.some((f) => shown[f]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending || reading) return;
    setTried(true);
    // A Create pressed while the picked source is still being read waits
    // for it: its protected files are part of the body.
    let read = detail.data;
    if (!read && draft.sourceRepo !== "" && !detail.isError) {
      setReading(true);
      read = await qc.ensureQueryData(detailOf(draft.sourceRepo)).catch(() => undefined);
      setReading(false);
    }
    // No body without the source's detail: the source field says it could not be read.
    if (draft.sourceRepo !== "" && !read) return;
    const next = projectBody(draft, read);
    if (next.body) {
      create.mutate(next.body);
      return;
    }
    const first = (Object.keys(FIELD_ID) as ProjectField[]).find((f) => next.missing[f]);
    if (first && ADVANCED_FIELDS.includes(first)) setAdvanced(true);
    // After the render that unfolds it, for a field under Advanced.
    if (first) setTimeout(() => document.getElementById(FIELD_ID[first])?.focus(), 0);
  };

  const zone = foreignZone();
  const picked = sources.data?.find((s) => s.name === draft.sourceRepo);
  const scheduled = draft.publishMode === "scheduled";

  return (
    <div className="space-y-6">
      {header}
      <form onSubmit={(e) => void submit(e)} noValidate className="max-w-2xl">
        {/* Disabled as one while the repository is built: no second create. */}
        <fieldset disabled={create.isPending} className="min-w-0 space-y-6">
          {refusal?.at === "form" ? (
            <Alert
              tone="danger"
              title={t("project.refusal.distributionFailed.title")}
              action={
                <Button type="submit" variant="secondary" size="sm">
                  <RotateCw /> {t("common.retry")}
                </Button>
              }
            >
              {t(refusal.message)}
            </Alert>
          ) : create.isError && !refusal ? (
            <Alert tone="danger" title={t("eval.createFailed")}>
              {t("error.server")}
            </Alert>
          ) : null}

          <Card className="space-y-5 px-5 py-5">
            <div className="flex flex-col gap-1">
              <Field
                id={FIELD_ID.name}
                label={t("project.name")}
                fullWidth
                maxLength={200}
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
                {...fieldErrorProps(FIELD_ID.name, message("name"))}
              />
              <FieldError id={FIELD_ID.name}>{message("name")}</FieldError>
            </div>

            <div className="flex flex-col gap-1">
              {sources.isLoading ? (
                <div className="flex flex-col gap-1.5">
                  <span className="text-[13px] font-medium text-fg-muted">{t("project.source")}</span>
                  <Skeleton className="h-[34px] w-full" />
                </div>
              ) : sources.data && sources.data.length === 0 ? (
                <Alert tone="neutral" title={t("project.source.none")}>
                  {t("project.source.noneBody")}
                </Alert>
              ) : (
                <Select
                  id={FIELD_ID.source}
                  label={t("project.source")}
                  value={draft.sourceRepo}
                  onChange={(e) => update({ sourceRepo: e.target.value, branches: null, protectedFiles: null })}
                  className="font-mono"
                  {...fieldErrorProps(FIELD_ID.source, message("source"))}
                >
                  <option value="">{t("project.source.pick")}</option>
                  {sources.data?.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              )}
              {picked && !detail.isError ? (
                <p className="text-[13px] text-fg-muted">
                  {t("project.source.branch", { branch: picked.defaultBranch })}
                  {picked.pushedAt ? (
                    <>
                      {" · "}
                      {t("project.source.pushed")} <RelativeTime iso={picked.pushedAt} />
                    </>
                  ) : null}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <FieldError id={FIELD_ID.source}>{message("source")}</FieldError>
                {detail.isError ? (
                  <Button size="sm" variant="ghost" loading={detail.isFetching} onClick={() => void detail.refetch()}>
                    <RotateCw /> {t("common.retry")}
                  </Button>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex flex-wrap items-start gap-4">
                {scheduled ? (
                  <DateInput
                    field="start"
                    label={t("project.start")}
                    value={draft.startLocal}
                    message={message("start")}
                    onChange={(startLocal) => update({ startLocal })}
                  />
                ) : null}
                {byDuration(draft) ? (
                  <div className="flex flex-col gap-1">
                    <Field
                      id={FIELD_ID.duration}
                      label={t("project.duration")}
                      type="number"
                      min={1}
                      max={400}
                      width="w-32"
                      className="text-right tabular-nums"
                      value={draft.durationDays}
                      onChange={(e) => update({ durationDays: e.target.value })}
                      {...fieldErrorProps(FIELD_ID.duration, message("duration"))}
                    />
                    <FieldError id={FIELD_ID.duration}>{message("duration")}</FieldError>
                  </div>
                ) : (
                  <DateInput
                    field="deadline"
                    label={t("project.deadline")}
                    value={draft.deadlineLocal}
                    message={message("deadline")}
                    onChange={(deadlineLocal) => update({ deadlineLocal })}
                  />
                )}
              </div>
              {zone ? <p className="text-[13px] text-fg-muted">{t("project.zone", { zone })}</p> : null}
            </div>
          </Card>

          <div className="space-y-3">
            <Button variant="secondary" aria-expanded={advancedOpen} onClick={() => setAdvanced(!advancedOpen)}>
              {advancedOpen ? <ChevronUp /> : <ChevronDown />}{" "}
              {t(advancedOpen ? "eval.advanced.hide" : "eval.advanced")}
            </Button>
            {advancedOpen ? (
              <ProjectAdvanced
                classroomId={classroomId}
                draft={draft}
                detail={detail.data}
                update={update}
                message={message}
              />
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line pt-5">
            <Button variant="secondary" onClick={back}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" loading={create.isPending || reading}>
              {create.isPending ? t("project.building") : t("common.create")}
            </Button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}

/** A date of the form, held as typed (`datetime-local`, the browser's zone). */
function DateInput({
  field,
  label,
  value,
  message,
  onChange,
}: {
  field: "start" | "deadline";
  label: string;
  value: string;
  message: string | undefined;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Field
        id={FIELD_ID[field]}
        label={label}
        type="datetime-local"
        width="w-56"
        min={toLocalInput(new Date().toISOString())}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...fieldErrorProps(FIELD_ID[field], message)}
      />
      <FieldError id={FIELD_ID[field]}>{message}</FieldError>
    </div>
  );
}

/** The sources' read refused because the classroom cannot hand anything out: a state of the page. */
function sourcesRefusal(error: unknown): "not_connected" | "app_not_installed" | null {
  const place = refusalPlace(error);
  return place?.at === "page" ? place.code : null;
}
