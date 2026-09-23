import { useMutation, useQuery } from "@tanstack/react-query";
import { FileQuestion } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  CourseSummary,
  PollQuestionPick,
  PollTeacherView,
  QuestionDetail,
} from "@quiz/contracts";

import { api } from "../api";
import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { TypeGlyph } from "../pool/QuestionTable";
import { NewQuestionForm } from "../question/NewQuestionForm";
import type { Route } from "../router";
import {
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
 * already wrote, or one you are about to. They do NOT share a primary
 * action, and that is the point — picking one ends in "Start poll", writing
 * one ends in the editor.
 *
 * ### Why writing a question does not come back here by itself
 *
 * The obvious trick would be a `?then=poll` hint on the editor's URL, so
 * that Publish returns to a launcher with the new question selected. It is
 * not done, deliberately: it gives the product's most-used screen a second,
 * invisible mode that depends on where the teacher came from, and it breaks
 * the moment they reload, open the editor in a second tab, or leave the
 * draft for tomorrow — the three things a teacher writing a question
 * actually does.
 *
 * So the flow is the honest one: "Create question" leaves for the editor and
 * says so. The launcher is one click (or one Ctrl+K) away afterwards, and
 * the question is waiting at the top of the list, because the API orders
 * them by `COALESCE(lastUsedAt, updatedAt) DESC` — a question you have never
 * polled but just published IS the most recent thing you did.
 */

/** A poll runs these two types; the picker is limited to them. */
const POLL_TYPES = ["mcq", "short"] as const;

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
  const [type, setType] = useState<string>(POLL_TYPES[0]);
  const [name, setName] = useState("");

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

  const create = useMutation({
    mutationFn: () =>
      api<QuestionDetail>("/app/api/polls/questions", {
        method: "POST",
        body: JSON.stringify({ type, internalName: name.trim() }),
      }),
    onSuccess: (question) => {
      navigate({ view: "question", id: question.meta.id });
    },
  });

  // ONE primary action per screen, and it follows the tab: start the poll
  // from a picked question, or create the question that will be polled.
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
        onClick={() => create.mutate()}
        loading={create.isPending}
        disabled={name.trim() === ""}
      >
        {t("poll.createQuestion")}
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("poll.launcher")} description={t("poll.launcherHint")} actions={primary} />
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
        <div className="mt-5 space-y-4">
          <NewQuestionForm
            types={POLL_TYPES}
            value={type}
            onChange={setType}
            name={name}
            onName={setName}
          />
          <p className="text-[13px] text-fg-muted">{t("poll.newHint")}</p>
          <FormError error={create.error} title={t("pool.createFailed")} />
        </div>
      )}
    </div>
  );
}
