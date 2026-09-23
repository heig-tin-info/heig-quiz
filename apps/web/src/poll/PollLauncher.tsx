import { useMutation, useQuery } from "@tanstack/react-query";
import { FileQuestion } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  CourseSummary,
  PollQuestionPick,
  PollTeacherView,
  ZodIssueLite,
} from "@quiz/contracts";
import { emptyMcqDraft } from "@quiz/qt-mcq/client";
import { emptyShortDraft } from "@quiz/qt-short/client";

import { api, ApiError } from "../api";
import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { TypeGlyph } from "../pool/QuestionTable";
import { QuestionTypePicker } from "../pool/QuestionTypePicker";
import { toConfigIssues } from "../question/issues";
import { QuestionEditorHost } from "../questionTypes";
import type { Route } from "../router";
import {
  Alert,
  Button,
  cx,
  EmptyState,
  FormError,
  PageHeader,
  pressable,
  QueryError,
  RelativeTime,
  SearchInput,
  Select,
  SettingRow,
  Skeleton,
  Switch,
  Tabs,
  usePersistentChoice,
} from "../ui";
import { coursesKey, pollQuestionsKey } from "../queryKeys";

/**
 * "Start a poll" (F-LIVE-13): one question, thrown on the wall, answered by
 * whoever is in the room.
 *
 * It is a LAYER and not a page, because starting a poll is something a
 * teacher does in the middle of a lecture, from wherever they happen to be —
 * the navbar entry and the palette both open this, and Escape puts the
 * lecture back. A sheet rather than a dialog: the list of questions scrolls,
 * and a dialog holding a scrolling list plus two options is a page with a
 * backdrop.
 *
 * Two tabs, because there are exactly two ways to have a question: one you
 * already wrote, or one you write now. Both end in the same primary action,
 * "Start the poll", and the classroom and the anonymity above the tabs apply
 * to either.
 *
 * ### Why a new question is not saved
 *
 * "Ask a new question" used to create a question in the teacher's `Polls`
 * pool and send them to the full editor, to publish it and come back. In the
 * middle of a lecture that is four screens for one question. So the tab now
 * holds the type's own editor, stripped of everything that only decides a
 * mark (`ungraded`: no scoring policy, no points, no prefilters) — a poll
 * gives none — and "Start the poll" sends the content itself
 * (`POST /app/api/polls/inline`). The question is kept with its poll only,
 * in no pool (ADR-014, addendum 2026-09-23); a teacher who wants it for next
 * year writes it in the `Polls` pool, and it shows up in the other tab.
 *
 * The key is optional there: with no correct answer marked, the poll asks
 * for opinions and its reveal is the distribution. One muted line under the
 * type picker says so; nothing blocks on it.
 */

/** A poll runs these two types; the picker is limited to them. */
const POLL_TYPES = ["mcq", "short"] as const;
type PollType = (typeof POLL_TYPES)[number];

/**
 * The blank question of each type: what the editor starts from — with NO
 * key. A poll may ask an opinion (ADR-014, addendum 2026-09-23), and a
 * choice ticked in advance would be a "correct answer" on the wall that the
 * teacher never chose.
 */
const EMPTY: Record<PollType, () => unknown> = {
  mcq: () => {
    const draft = emptyMcqDraft();
    return { ...draft, choices: draft.choices.map((c) => ({ ...c, correct: false })) };
  },
  short: () => ({ ...emptyShortDraft(), matchers: [] }),
};

/** The schema's issues of a refused content, when that is why it was refused. */
function refusedIssues(error: unknown): readonly ZodIssueLite[] | null {
  if (!(error instanceof ApiError) || error.status !== 422) return null;
  const body = error.body as { error?: string; details?: ZodIssueLite[] } | null;
  return body?.error === "config_invalid" ? (body.details ?? []) : null;
}

/** The classroom the last poll was thrown in; a convenience, never state. */
const ROOM_KEY = "quiz-poll-classroom";

/** Any stored id is taken; one that no longer exists falls back below. */
const anyRoom = (raw: string): raw is string => true;

/** The first line of a prompt, short enough for a row. */
export function promptLine(prompt: string, max = 120): string {
  const line = prompt.replace(/[`*_#>\n]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

function QuestionRow({
  pick,
  selected,
  onSelect,
}: {
  pick: PollQuestionPick;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <li>
      <div
        {...pressable(onSelect)}
        aria-pressed={selected}
        onClick={onSelect}
        className={cx(
          "flex w-full cursor-pointer items-start gap-3 rounded-field border p-3 text-left transition-colors",
          selected
            ? "border-accent bg-accent-soft"
            : "border-line bg-surface hover:bg-surface-2",
        )}
      >
        <span className="mt-0.5">
          <TypeGlyph type={pick.type} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[13px] font-bold">
            {pick.internalName}
          </span>
          <span className="mt-0.5 block text-[13px] text-fg-muted">
            {promptLine(pick.prompt)}
          </span>
          <span className="mt-1 block text-xs text-fg-faint">
            {pick.useCount === 0 ? (
              t("poll.neverUsed")
            ) : (
              <>
                {t(pick.useCount === 1 ? "poll.usedOnce" : "poll.usedTimes", {
                  n: pick.useCount,
                })}
                {pick.lastUsedAt ? (
                  <>
                    {" · "}
                    <RelativeTime iso={pick.lastUsedAt} />
                  </>
                ) : null}
              </>
            )}
          </span>
        </span>
      </div>
    </li>
  );
}

export function PollLauncher({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const [tab, setTab] = useState<"pick" | "new">("pick");
  const [query, setQuery] = useState("");
  const [questionId, setQuestionId] = useState<string | null>(null);
  const [anonymous, setAnonymous] = useState(true);
  const [room, setRoom] = usePersistentChoice<string>(ROOM_KEY, anyRoom, "");
  const [type, setType] = useState<PollType>(POLL_TYPES[0]);
  // One working copy per type, so a switch back and forth loses nothing.
  const [drafts, setDrafts] = useState<Partial<Record<PollType, unknown>>>({});
  const config = drafts[type] ?? EMPTY[type]();

  const picks = useQuery<PollQuestionPick[]>({
    queryKey: pollQuestionsKey,
    queryFn: () => api("/app/api/polls/questions"),
  });
  // The same key the sidebar and the palette already hold: no extra request.
  const courses = useQuery<CourseSummary[]>({
    queryKey: coursesKey,
    queryFn: () => api("/app/api/courses"),
  });

  const rooms = useMemo(
    () =>
      (courses.data ?? []).flatMap((course) =>
        course.classrooms.map((r) => ({ id: r.id, label: `${course.code} · ${r.name}` })),
      ),
    [courses.data],
  );
  // The remembered classroom, when it still exists; otherwise the first one.
  const classroomId = rooms.some((r) => r.id === room) ? room : (rooms[0]?.id ?? "");

  const filtered = useMemo(
    () =>
      fuzzyFilter(query, picks.data ?? [], (p) => `${p.internalName} ${promptLine(p.prompt, 400)}`),
    [query, picks.data],
  );

  const start = useMutation({
    mutationFn: () =>
      api<PollTeacherView>("/app/api/polls", {
        method: "POST",
        body: JSON.stringify({ questionId, classroomId, anonymous }),
      }),
    onSuccess: (view) => {
      setRoom(view.evaluation.classroomId);
      navigate({ view: "poll", id: view.evaluation.id });
    },
  });

  const inline = useMutation({
    mutationFn: () =>
      api<PollTeacherView>("/app/api/polls/inline", {
        method: "POST",
        body: JSON.stringify({ type, config, classroomId, anonymous }),
      }),
    onSuccess: (view) => {
      setRoom(view.evaluation.classroomId);
      navigate({ view: "poll", id: view.evaluation.id });
    },
  });
  const refused = refusedIssues(inline.error);
  const issues = useMemo(() => (refused ? toConfigIssues(t, refused) : undefined), [refused, t]);

  // ONE primary action per screen, whichever tab: start the poll — on the
  // picked question, or on the one written below.
  const primary =
    tab === "pick" ? (
      <Button
        onClick={() => start.mutate()}
        loading={start.isPending}
        disabled={questionId === null || classroomId === ""}
      >
        {t("poll.startAction")}
      </Button>
    ) : (
      <Button
        onClick={() => inline.mutate()}
        loading={inline.isPending}
        disabled={classroomId === ""}
      >
        {t("poll.startAction")}
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("poll.launcher")} description={t("poll.launcherHint")} actions={primary} />
      <div className="divide-y divide-line border-b border-line pb-1">
        <SettingRow title={t("poll.classroom")} desc={t("poll.classroomHint")} className="pt-0">
          {courses.isLoading ? (
            <Skeleton className="h-9 w-56" />
          ) : (
            <Select
              aria-label={t("poll.classroom")}
              width="w-56"
              value={classroomId}
              onChange={(e) => setRoom(e.currentTarget.value)}
            >
              {rooms.length === 0 ? <option value="">{t("poll.noClassroom")}</option> : null}
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </SettingRow>
        <SettingRow title={t("poll.anonymous")} desc={t("poll.anonymousHint")}>
          <Switch checked={anonymous} label={t("poll.anonymous")} onChange={setAnonymous} />
        </SettingRow>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        label={t("poll.launcher")}
        items={[
          { value: "pick", label: t("poll.tab.pick"), count: picks.data?.length },
          { value: "new", label: t("poll.tab.new") },
        ]}
      />

      {tab === "pick" ? (
        <div className="mt-5 space-y-4">
          <SearchInput
            className="w-full"
            aria-label={t("poll.searchLabel")}
            placeholder={t("poll.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {picks.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }, (_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : picks.isError || !picks.data ? (
            <QueryError
              title={t("poll.questionsFailed")}
              error={picks.error}
              onRetry={() => void picks.refetch()}
              retrying={picks.isFetching}
              fallback={t("error.server")}
            />
          ) : picks.data.length === 0 ? (
            <EmptyState
              icon={FileQuestion}
              title={t("poll.noQuestions")}
              action={
                <Button variant="secondary" onClick={() => setTab("new")}>
                  {t("poll.tab.new")}
                </Button>
              }
            >
              {t("poll.noQuestionsBody")}
            </EmptyState>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-fg-muted">{t("poll.noMatch")}</p>
          ) : (
            <ul className="space-y-2">
              {filtered.map((pick) => (
                <QuestionRow
                  key={pick.id}
                  pick={pick}
                  selected={questionId === pick.id}
                  onSelect={() => setQuestionId(pick.id)}
                />
              ))}
            </ul>
          )}

          <FormError error={start.error} title={t("poll.startFailed")} />
        </div>
      ) : (
        <div className="mt-5 space-y-6">
          {refused ? (
            <Alert tone="danger" title={t("poll.startFailed")}>
              {t("poll.incomplete")}
            </Alert>
          ) : (
            <FormError error={inline.error} title={t("poll.startFailed")} />
          )}
          <fieldset>
            <legend className="mb-2 text-[13px] font-medium">{t("pool.questionType")}</legend>
            <QuestionTypePicker
              types={POLL_TYPES}
              value={type}
              onChange={(next) => {
                setType(next as PollType);
                inline.reset();
              }}
            />
            <p className="mt-2 text-[13px] text-fg-muted">{t("poll.keyOptional")}</p>
          </fieldset>
          <QuestionEditorHost
            t={t}
            type={type}
            config={config}
            onChange={(next) => setDrafts((all) => ({ ...all, [type]: next }))}
            ungraded
            {...(issues === undefined ? {} : { issues })}
          />
          <p className="border-t border-line pt-4 text-[13px] text-fg-muted">{t("poll.newHint")}</p>
        </div>
      )}
    </div>
  );
}
