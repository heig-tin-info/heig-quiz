/**
 * The Journal section of a classroom's Settings (F-JRN-01 to F-JRN-05,
 * `docs/merge/05-web.md` §5.3, D24, D27, D28, ADR-057).
 *
 * A journal has a mode, chosen when it is created (ADR-057):
 *   - no journal: a segmented control "In Quiz" (the default) / "In a GitHub
 *     repository", the current choice explained in one line under the
 *     title (DESIGN.md, Settings row). In Quiz needs nothing else: one
 *     Create. In a GitHub repository keeps "Create a journal" (a new
 *     private repository, under the name the API proposes; a name already
 *     taken is never adopted, and the free one it suggests is one click
 *     away) and "Use a repository" (its branch and folder behind a
 *     disclosure, docs/spec/08) once the classroom is connected; before
 *     that, one line pointing at the GitHub section above. On a platform
 *     without Quiz's App there is no choice to make: In Quiz only.
 *   - a Quiz-mode journal: its mode and how many pages it holds, and
 *     "Remove the journal", which deletes them (the only copy), so with
 *     pages the classroom's name is typed (F-JRN-04, `?confirm=`).
 *   - a GitHub-mode journal: the repository (a link to GitHub), its branch
 *     and folder, where its copy stands with a check level, Refresh, and
 *     "Remove the journal", confirmed, which keeps the repository on
 *     GitHub. Removing it is what lets the GitHub section disconnect the
 *     classroom (D28).
 *
 * Nothing here is accented (F-ORG-13): the Settings' one accent stays
 * "Connect to GitHub" while the classroom is not connected, whatever the
 * journal (the product owner, M4-09: projects need it too). Create and Use
 * are one-field forms (the expert fields folded), so dialogs; their submit
 * is the primary of the dialog, not of the tab.
 *
 * Without the journal's routes (404) there is no section; nor while the
 * first answers are awaited.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronDown, ChevronUp, ExternalLink, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  GithubRepoName,
  JournalCreate,
  JournalUse,
  type ClassroomDetail,
  type JournalMode,
  type JournalRepository,
  type JournalStaff,
} from "@quiz/contracts";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { githubAbsent, useClassroomGithub } from "../github/api";
import { useT, type TFunction } from "../i18n";
import { useToast } from "../notify";
import {
  Alert,
  Button,
  Card,
  ErrorText,
  Field,
  FormDialog,
  FormError,
  GithubIcon,
  LevelIcon,
  QueryError,
  SectionHeading,
  Segmented,
  SettingRow,
} from "../ui";
import {
  journalBase,
  journalErrorText,
  journalRefusal,
  journalRemoveUrl,
  nameTakenSuggestion,
  removalNeedsName,
  useJournalRefresh,
  useStaffJournal,
} from "./api";
import { syncLevel, SyncText } from "./SyncState";
import { SYNC_ERRORS } from "./words";

type OpenDialog = "create" | "use" | null;

/** "{count} pages", the one-page case worded on its own. */
export function pagesText(t: TFunction, count: number): string {
  return count === 1 ? t("journalSettings.pages.one") : t("journalSettings.pages", { count });
}

export function JournalSettings({ room }: { room: ClassroomDetail }) {
  const t = useT();
  const github = useClassroomGithub(room.id);
  const journal = useStaffJournal(room.id);
  const [dialog, setDialog] = useState<OpenDialog>(null);

  // No journal routes, or still waiting: nothing. A GitHub failure is said
  // once, by the GitHub section above; here it only hides the GitHub mode's
  // actions (no organization known).
  if (githubAbsent(journal.error)) return null;
  if (github.isPending || journal.isPending) return null;

  const withGithub = !githubAbsent(github.error);
  const org = github.data?.link?.org.login ?? null;
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
  } else if (journal.data.mode === "quiz") {
    body = <QuizAttached room={room} journal={journal.data} />;
  } else if (journal.data.mode === "github" && journal.data.repository) {
    body = <Attached room={room} journal={journal.data} repository={journal.data.repository} />;
  } else {
    body = <NewJournal room={room} org={org} withGithub={withGithub} onOpen={setDialog} />;
  }

  return (
    <section className="space-y-3">
      <SectionHeading icon={BookOpen} title={t("journalSettings.section")} />
      {body}
      {dialog === "create" && org !== null && journal.data ? (
        <CreateDialog
          room={room}
          org={org}
          proposedName={journal.data.proposedName}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "use" && org !== null ? <UseDialog room={room} org={org} onClose={() => setDialog(null)} /> : null}
    </section>
  );
}

// ------------------------------------------------------------------ no journal yet

/**
 * The mode, then what creating a journal of that mode takes. The choice is
 * this card's state only: nothing is written until Create.
 */
function NewJournal({
  room,
  org,
  withGithub,
  onOpen,
}: {
  room: ClassroomDetail;
  /** The connected organization, null while the classroom is not connected. */
  org: string | null;
  /** The platform has Quiz's App: the GitHub mode exists. */
  withGithub: boolean;
  onOpen: (dialog: OpenDialog) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<JournalMode>("quiz");
  const create = useMutation({
    mutationFn: () =>
      api<JournalStaff>(journalBase(room.id), {
        method: "POST",
        body: JSON.stringify({ mode: "quiz" } satisfies JournalCreate),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["journal", room.id] });
      toast(t("journalSettings.createdQuiz"), "success");
    },
    onError: (error) => toast(journalErrorText(error, t), "error"),
  });

  let actions;
  if (mode === "quiz") {
    actions = (
      <SettingRow title={t("journalSettings.create")} desc={t("journalSettings.createQuizDesc")}>
        <Button variant="secondary" loading={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? null : <Plus />} {t("journalSettings.createQuiz")}
        </Button>
      </SettingRow>
    );
  } else if (org === null) {
    actions = <SettingRow title={t("journalSettings.notConnected")} desc={t("journalSettings.connectFirst")} />;
  } else {
    actions = (
      <>
        <SettingRow title={t("journalSettings.create")} desc={t("journalSettings.createDesc", { org })}>
          <Button variant="secondary" onClick={() => onOpen("create")}>
            {t("journalSettings.createOpen")}
          </Button>
        </SettingRow>
        <SettingRow title={t("journalSettings.use")} desc={t("journalSettings.useDesc", { org })}>
          <Button variant="secondary" onClick={() => onOpen("use")}>
            {t("journalSettings.useOpen")}
          </Button>
        </SettingRow>
      </>
    );
  }

  return (
    <Card className="divide-y divide-line px-5">
      {withGithub ? (
        <SettingRow
          title={t("journalSettings.mode")}
          desc={mode === "quiz" ? t("journalSettings.mode.quiz.desc") : t("journalSettings.mode.github.desc")}
        >
          <Segmented
            name="journal-mode"
            label={t("journalSettings.mode")}
            value={mode}
            onChange={setMode}
            options={[
              { value: "quiz", label: t("journalSettings.mode.quiz") },
              { value: "github", label: t("journalSettings.mode.github") },
            ]}
          />
        </SettingRow>
      ) : null}
      {actions}
    </Card>
  );
}

// ------------------------------------------------------------------ a journal

/**
 * Remove the journal (F-JRN-04), confirmed: a GitHub-mode one leaves its
 * repository on GitHub; a Quiz-mode one holding pages destroys the only
 * copy of them, so the classroom's name is typed and sent as `?confirm=`.
 */
function RemoveRow({ room, journal }: { room: ClassroomDetail; journal: JournalStaff }) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const typed = removalNeedsName(journal);
  const repository = journal.repository;
  const remove = useMutation({
    mutationFn: () => api(journalRemoveUrl(room.id, typed ? room.name : undefined), { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["journal", room.id] });
      toast(
        repository ? t("journalSettings.removed", { name: repository.fullName }) : t("journalSettings.removedQuiz"),
        "success",
      );
    },
    onError: (error) => toast(journalErrorText(error, t), "error"),
  });
  const onRemove = async () => {
    let message: string;
    if (repository) message = t("journalSettings.removeBody", { name: repository.fullName });
    else if (typed) message = t("journalSettings.removeBodyQuiz", { pages: pagesText(t, journal.pageCount) });
    else message = t("journalSettings.removeBodyQuizEmpty");
    if (
      await confirm({
        title: t("journalSettings.removeConfirm", { name: room.name }),
        message,
        ...(typed ? { typeToConfirm: room.name } : {}),
        confirmLabel: t("journalSettings.remove"),
        cancelLabel: t("common.cancel"),
        danger: true,
      })
    ) {
      remove.mutate();
    }
  };
  return (
    <SettingRow
      title={t("journalSettings.remove")}
      desc={repository ? t("journalSettings.removeDesc") : t("journalSettings.removeDescQuiz")}
    >
      <Button variant="danger-quiet" loading={remove.isPending} onClick={() => void onRemove()}>
        <Trash2 /> {t("journalSettings.removeOpen")}
      </Button>
    </SettingRow>
  );
}

/** A Quiz-mode journal: its mode, its pages, and Remove. The pages are edited from the Journal tab. */
function QuizAttached({ room, journal }: { room: ClassroomDetail; journal: JournalStaff }) {
  const t = useT();
  return (
    <Card className="divide-y divide-line px-5">
      <SettingRow
        title={t("journalSettings.mode.quiz")}
        desc={t("journalSettings.quizSet", { pages: pagesText(t, journal.pageCount) })}
      />
      <RemoveRow room={room} journal={journal} />
    </Card>
  );
}

/** A GitHub-mode journal: the repository, the copy's state with Refresh, and Remove. */
function Attached({
  room,
  journal,
  repository,
}: {
  room: ClassroomDetail;
  journal: JournalStaff;
  repository: JournalRepository;
}) {
  const t = useT();
  const toast = useToast();
  const onError = (error: unknown) => toast(journalErrorText(error, t), "error");
  const { refresh, refreshing } = useJournalRefresh(room.id, repository, onError);

  const level = syncLevel(repository, refreshing);
  const reason =
    !refreshing && repository.syncStatus === "error"
      ? `${repository.syncError ? `${t(SYNC_ERRORS[repository.syncError])} ` : ""}${t("journal.sync.errorHint")}`
      : null;
  const where = repository.rootPath
    ? t("journalSettings.where.folder", { ref: repository.ref, folder: repository.rootPath })
    : t("journalSettings.where.root", { ref: repository.ref });

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
        desc={`${t("journalSettings.mode.github")} · ${where}`}
      />
      <SettingRow
        title={
          <span className="inline-flex items-center gap-2">
            <LevelIcon level={level} label={t(`github.level.${level}`)} />
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
      <RemoveRow room={room} journal={journal} />
    </Card>
  );
}

// ------------------------------------------------------------------ the dialogs

/** A create or a use answered 201: the journal and its pages are read again. */
function useAttach(room: ClassroomDetail, onDone: () => void) {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  return async (next: JournalStaff) => {
    await qc.invalidateQueries({ queryKey: ["journal", room.id] });
    toast(t("journalSettings.attached", { name: next.repository?.fullName ?? "" }), "success");
    onDone();
  };
}

function CreateDialog({
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
  const body = JournalCreate.safeParse({ mode: "github", name: name.trim() });
  const create = useMutation({
    mutationFn: (wanted: string) =>
      api<JournalStaff>(journalBase(room.id), {
        method: "POST",
        body: JSON.stringify({ mode: "github", name: wanted } satisfies JournalCreate),
      }),
    onSuccess: attach,
  });
  const suggestion = nameTakenSuggestion(create.error);

  return (
    <FormDialog
      title={t("journalSettings.createTitle")}
      onClose={onClose}
      onSubmit={() => body.data?.mode === "github" && body.data.name && create.mutate(body.data.name)}
      submitLabel={t("journalSettings.createSubmit")}
      submitting={create.isPending}
      canSubmit={body.success && name.trim() !== ""}
      error={
        suggestion ? (
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
        ) : (
          <FormError error={create.error} describe={(e) => journalErrorText(e, t)} />
        )
      }
    >
      <p className="text-sm text-fg-muted">{t("journalSettings.createIntro", { org })}</p>
      <RepoNameField value={name} onChange={setName} org={org} autoFocus />
    </FormDialog>
  );
}

/** The codes a use may meet whose fix is in the expert fields: the disclosure opens on them. */
const EXPERT_REFUSALS: ReadonlySet<string> = new Set(["ref_not_found", "root_not_found"]);

function UseDialog({ room, org, onClose }: { room: ClassroomDetail; org: string; onClose: () => void }) {
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
    onError: (error) => {
      const code = journalRefusal(error);
      if (code && EXPERT_REFUSALS.has(code)) setExpert(true);
    },
  });
  // Which expert field the schema refuses: said under it, before asking.
  const issue = (field: "ref" | "rootPath") =>
    !body.success && body.error.issues.some((i) => i.path[0] === field);

  return (
    <FormDialog
      title={t("journalSettings.useTitle")}
      onClose={onClose}
      onSubmit={() => body.success && use.mutate(body.data)}
      submitLabel={t("journalSettings.useSubmit")}
      submitting={use.isPending}
      canSubmit={body.success}
      error={<FormError error={use.error} describe={(e) => journalErrorText(e, t)} />}
    >
      <p className="text-sm text-fg-muted">{t("journalSettings.useIntro", { org })}</p>
      <RepoNameField value={name} onChange={setName} org={org} autoFocus />
      <Button variant="ghost" size="sm" aria-expanded={expert} onClick={() => setExpert((v) => !v)}>
        {expert ? <ChevronUp /> : <ChevronDown />} {t("journalSettings.expert")}
      </Button>
      {expert ? (
        <>
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
        </>
      ) : null}
    </FormDialog>
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
