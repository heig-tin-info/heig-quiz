/**
 * The Journal section of a classroom's Settings (F-JRN-01 to F-JRN-05,
 * `docs/merge/05-web.md` §5.3, D24, D27, D28).
 *
 * A journal is one repository of the classroom's organization, so the
 * section is enabled once the classroom is connected to GitHub; before that
 * it is one line that says so. Then:
 *   - no journal: "Create a journal" (a new private repository, under the
 *     name the API proposes; a name already taken is never adopted, and the
 *     free one it suggests is one click away) and "Use a repository" (any
 *     repository of the organization; its branch and folder behind a
 *     disclosure, docs/spec/08);
 *   - a journal: the repository (a link to GitHub), its branch and folder,
 *     where its copy stands with a check level, Refresh, and "Remove the
 *     journal", confirmed, which keeps the repository on GitHub. Removing it
 *     is what lets the GitHub section disconnect the classroom (D28).
 *
 * Nothing here is accented (F-ORG-13): a classroom connected for its
 * projects is not pushed towards a journal. The sheets' own submit is the
 * primary of the sheet, not of the tab.
 *
 * Without Quiz's App on the platform the journal's routes are absent (404),
 * as the GitHub ones are: no section at all, as on a classroom never
 * connected. Nor while the first answers are awaited (the GitHub section
 * draws nothing then either).
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronUp, ExternalLink, RefreshCw, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";

import {
  GithubRepoName,
  JournalCreate,
  JournalUse,
  type ClassroomDetail,
  type JournalRepository,
  type JournalStaff,
} from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { githubAbsent, useClassroomGithub } from "../github/api";
import { useT } from "../i18n";
import { useToast } from "../notify";
import { journalKey } from "../queryKeys";
import {
  Alert,
  Button,
  Card,
  cx,
  ErrorText,
  Field,
  GithubIcon,
  LEVEL_ICON,
  QueryError,
  SectionHeading,
  SettingRow,
  Sheet,
} from "../ui";
import {
  journalBase,
  journalErrorText,
  journalRefusal,
  nameTakenSuggestion,
  useJournalRefresh,
  useStaffJournal,
} from "./api";
import { syncLevel, SyncText } from "./SyncState";
import { SYNC_ERRORS } from "./words";

type OpenSheet = "create" | "use" | null;

export function JournalSettings({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const github = useClassroomGithub(room.id);
  const journal = useStaffJournal(room.id);
  const [sheet, setSheet] = useState<OpenSheet>(null);

  // No App on this platform, or still waiting: nothing, as the GitHub section.
  // A GitHub failure is said once, by the GitHub section above.
  if (githubAbsent(github.error) || githubAbsent(journal.error)) return null;
  if (github.isPending || journal.isPending || github.isError) return null;

  const org = github.data.link?.org.login ?? null;
  let body;
  if (journal.isError) {
    body = (
      <QueryError
        title={t("journalSettings.loadFailed")}
        error={journal.error}
        onRetry={() => void journal.refetch()}
        retrying={journal.isFetching}
      />
    );
  } else if (journal.data.repository) {
    body = <Attached room={room} repository={journal.data.repository} />;
  } else if (org === null) {
    body = (
      <Card className="px-5">
        <SettingRow title={t("journalSettings.none")} desc={t("journalSettings.connectFirst")} />
      </Card>
    );
  } else {
    body = (
      <Card className="divide-y divide-line px-5">
        <SettingRow title={t("journalSettings.create")} desc={t("journalSettings.createDesc", { org })}>
          <Button variant="secondary" onClick={() => setSheet("create")}>
            {t("journalSettings.createOpen")}
          </Button>
        </SettingRow>
        <SettingRow title={t("journalSettings.use")} desc={t("journalSettings.useDesc", { org })}>
          <Button variant="secondary" onClick={() => setSheet("use")}>
            {t("journalSettings.useOpen")}
          </Button>
        </SettingRow>
      </Card>
    );
  }

  return (
    <section className="space-y-3">
      <SectionHeading icon={BookOpen} title={t("journalSettings.section")} />
      {body}
      {sheet === "create" && org !== null && journal.data ? (
        <CreateSheet
          room={room}
          org={org}
          proposedName={journal.data.proposedName}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "use" && org !== null ? <UseSheet room={room} org={org} onClose={() => setSheet(null)} /> : null}
    </section>
  );
}

// ------------------------------------------------------------------ a journal

function Attached({ room, repository }: { room: ClassroomDetail; repository: JournalRepository }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const onError = (error: unknown) => toast(journalErrorText(error, t), "error");
  const { refresh, refreshing } = useJournalRefresh(room.id, repository, onError);
  const remove = useMutation({
    mutationFn: () => api(journalBase(room.id), { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["journal", room.id] });
      toast(t("journalSettings.removed", { name: repository.fullName }), "success");
    },
    onError,
  });
  const onRemove = async () => {
    if (
      await confirm({
        title: t("journalSettings.removeConfirm", { name: room.name }),
        message: t("journalSettings.removeBody", { name: repository.fullName }),
        confirmLabel: t("journalSettings.remove"),
        cancelLabel: t("common.cancel"),
        danger: true,
      })
    ) {
      remove.mutate();
    }
  };

  const level = syncLevel(repository, refreshing);
  const { icon: LevelIcon, className: levelClass } = LEVEL_ICON[level];
  const reason =
    !refreshing && repository.syncStatus === "error"
      ? `${repository.syncError ? `${t(SYNC_ERRORS[repository.syncError])} ` : ""}${t("journal.sync.errorHint")}`
      : null;

  return (
    <Card className="divide-y divide-line px-5">
      <SettingRow
        title={
          <a
            href={repository.htmlUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 items-center gap-1.5 hover:underline"
          >
            <GithubIcon className="size-4 shrink-0" />
            <span className="truncate">{repository.fullName}</span>
            <ExternalLink className="size-3.5 shrink-0 text-fg-faint" />
          </a>
        }
        desc={
          repository.rootPath
            ? t("journalSettings.where.folder", { ref: repository.ref, folder: repository.rootPath })
            : t("journalSettings.where.root", { ref: repository.ref })
        }
      />
      <SettingRow
        title={
          <span className="inline-flex items-center gap-2" data-level={level}>
            <span role="img" aria-label={t(`github.level.${level}`)} className={cx("shrink-0", levelClass)}>
              <LevelIcon className="size-4" />
            </span>
            <span aria-live="polite">
              <SyncText repository={repository} refreshing={refreshing} />
            </span>
          </span>
        }
        desc={reason ?? t("journalSettings.syncDesc")}
      >
        <Button variant="secondary" loading={refreshing} onClick={refresh}>
          {refreshing ? null : <RefreshCw />} {t("journal.refresh")}
        </Button>
      </SettingRow>
      <SettingRow title={t("journalSettings.remove")} desc={t("journalSettings.removeDesc")}>
        <Button variant="secondary" loading={remove.isPending} onClick={() => void onRemove()}>
          <Trash2 /> {t("journalSettings.removeOpen")}
        </Button>
      </SettingRow>
    </Card>
  );
}

// ------------------------------------------------------------------ the sheets

/** A create or a use answered 201 with the staff journal: it becomes the cache's, and the pages are read again. */
function useAttach(room: ClassroomDetail, onDone: () => void) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  return async (next: JournalStaff) => {
    qc.setQueryData(journalKey(room.id, "staff"), next);
    await qc.invalidateQueries({ queryKey: ["journal", room.id] });
    toast(t("journalSettings.attached", { name: next.repository?.fullName ?? "" }), "success");
    onDone();
  };
}

function CreateSheet({
  room,
  org,
  proposedName,
  onClose,
}: {
  room: ClassroomDetail;
  org: string;
  proposedName: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const attach = useAttach(room, onClose);
  const [name, setName] = useState(proposedName ?? "");
  const body = JournalCreate.safeParse({ name: name.trim() });
  const create = useMutation({
    mutationFn: (wanted: string) =>
      api<JournalStaff>(journalBase(room.id), {
        method: "POST",
        body: JSON.stringify({ name: wanted } satisfies JournalCreate),
      }),
    onSuccess: attach,
  });
  const suggestion = nameTakenSuggestion(create.error);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (body.success && body.data.name) create.mutate(body.data.name);
  };

  return (
    <Sheet
      title={t("journalSettings.createTitle")}
      subtitle={room.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="journal-create" disabled={!body.success || !name.trim()} loading={create.isPending}>
            {t("journalSettings.createSubmit")}
          </Button>
        </>
      }
    >
      <form id="journal-create" className="space-y-5" onSubmit={submit}>
        <p className="text-sm text-fg-muted">{t("journalSettings.createIntro", { org })}</p>
        <RepoNameField value={name} onChange={setName} org={org} autoFocus />
        {suggestion ? (
          <Alert
            tone="warning"
            title={t("journalSettings.nameTaken", { name: `${org}/${create.variables ?? name}` })}
            action={
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setName(suggestion);
                  create.mutate(suggestion);
                }}
              >
                {t("journalSettings.createAs", { name: suggestion })}
              </Button>
            }
          >
            {t("journalSettings.nameTakenHint")}
          </Alert>
        ) : create.error ? (
          <Alert tone="danger" title={t("journalSettings.createFailed")}>
            {journalErrorText(create.error, t)}
          </Alert>
        ) : null}
      </form>
    </Sheet>
  );
}

/** The codes a use may meet whose fix is in the expert fields: the disclosure opens on them. */
const EXPERT_REFUSALS = new Set(["ref_not_found", "root_not_found"]);

function UseSheet({ room, org, onClose }: { room: ClassroomDetail; org: string; onClose: () => void }) {
  const t = useT();
  const attach = useAttach(room, onClose);
  const [name, setName] = useState("");
  const [ref, setRef] = useState("");
  const [rootPath, setRootPath] = useState("");
  const [expert, setExpert] = useState(false);
  const body = JournalUse.safeParse({
    name: name.trim(),
    ...(ref.trim() ? { ref: ref.trim() } : {}),
    ...(rootPath.trim() ? { rootPath: rootPath.trim() } : {}),
  });
  const use = useMutation({
    mutationFn: (payload: JournalUse) =>
      api<JournalStaff>(`${journalBase(room.id)}/use`, { method: "POST", body: JSON.stringify(payload) }),
    onSuccess: attach,
  });
  const refused = journalRefusal(use.error);
  const open = expert || (refused !== null && EXPERT_REFUSALS.has(refused));
  // Which field the API refused, when the schema already does: said under it.
  const issue = (field: "ref" | "rootPath") =>
    !body.success && body.error.issues.some((i) => i.path[0] === field);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (body.success) use.mutate(body.data);
  };

  return (
    <Sheet
      title={t("journalSettings.useTitle")}
      subtitle={room.name}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="journal-use" disabled={!body.success} loading={use.isPending}>
            {t("journalSettings.useSubmit")}
          </Button>
        </>
      }
    >
      <form id="journal-use" className="space-y-5" onSubmit={submit}>
        <p className="text-sm text-fg-muted">{t("journalSettings.useIntro", { org })}</p>
        <RepoNameField value={name} onChange={setName} org={org} autoFocus />

        {open ? (
          <div className="space-y-4">
            <Button variant="ghost" size="sm" onClick={() => setExpert(false)} aria-expanded>
              <ChevronUp /> {t("journalSettings.expert")}
            </Button>
            <div className="space-y-1.5">
              <Field
                label={t("journalSettings.ref")}
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder={t("journalSettings.refPlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                fullWidth
              />
              {issue("ref") ? <ErrorText>{t("journalSettings.refInvalid")}</ErrorText> : null}
            </div>
            <div className="space-y-1.5">
              <Field
                label={t("journalSettings.root")}
                value={rootPath}
                onChange={(e) => setRootPath(e.target.value)}
                placeholder={t("journalSettings.rootPlaceholder")}
                spellCheck={false}
                autoCapitalize="off"
                fullWidth
              />
              {issue("rootPath") ? <ErrorText>{t("journalSettings.rootInvalid")}</ErrorText> : null}
            </div>
          </div>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setExpert(true)} aria-expanded={false}>
            <ChevronDown /> {t("journalSettings.expert")}
          </Button>
        )}

        {use.error ? (
          <Alert tone="danger" title={t("journalSettings.useFailed")}>
            {journalErrorText(use.error, t)}
          </Alert>
        ) : null}
      </form>
    </Sheet>
  );
}

/** The repository's name, as GitHub accepts one, under the organization it lives in. */
function RepoNameField({
  value,
  onChange,
  org,
  autoFocus,
}: {
  value: string;
  onChange: (name: string) => void;
  org: string;
  autoFocus?: boolean;
}) {
  const t = useT();
  const trimmed = value.trim();
  const invalid = trimmed !== "" && !GithubRepoName.safeParse(trimmed).success;
  return (
    <div className="space-y-1.5">
      <Field
        label={t("journalSettings.name")}
        hint={<span className="font-mono text-xs text-fg-faint">{`${org}/`}</span>}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoFocus={autoFocus}
        aria-invalid={invalid || undefined}
        fullWidth
      />
      {invalid ? <ErrorText>{t("journalSettings.nameInvalid")}</ErrorText> : null}
    </div>
  );
}
