import { useMutation, useQuery } from "@tanstack/react-query";
import { FileQuestion } from "lucide-react";
import { useMemo, useState } from "react";

import type {
  CourseSummary,
  PollAudience,
  PollQuestionPick,
  PollTeacherView,
  ZodIssueLite,
} from "@quiz/contracts";
import { emptyMcqDraft } from "@quiz/qt-mcq/client";
import { emptyShortDraft } from "@quiz/qt-short/client";

import { api, ApiError } from "../api";
import { fuzzyFilter } from "../fuzzy";
import { useT } from "../i18n";
import { OutcomeBadge, OutcomeLegend } from "./OutcomeDonut";
import { PickRow, promptLine } from "./PickRow";
import { PoolPicks } from "./PoolPicks";
import { QuestionTypePicker } from "../pool/QuestionTypePicker";
import { toConfigIssues } from "../question/issues";
import { QuestionEditorHost } from "../questionTypes";
import type { Route } from "../router";
import {
  Alert,
  Button,
  EmptyState,
  FormError,
  PageHeader,
  QueryError,
  RelativeTime,
  SearchInput,
  Select,
  SettingRow,
  Skeleton,
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
 * Three tabs, because there are three ways to have a question: one you
 * already ran ("Recent polls", issue #161: the questions of your polls, kept
 * or not, each with a donut of how its last runs went), one that waits in a
 * pool ("From pools", issue #162: the pool screen's own search, over every
 * pool you reach, narrowed to the classroom's pools when the audience is
 * one), or one you write now. The first is the default when it has rows. All
 * end in the same primary action, "Start the poll", and the audience above
 * the tabs applies to each.
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
 * in no pool (ADR-014, addendum 2026-09-23), and "Recent polls" lists it to
 * run again all the same (addendum 2026-09-27). A teacher who wants it for
 * next year, in a pool, presses "Keep this question" on the poll screen: it
 * joins the `Polls` pool — created by that first keep.
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

/*
 * One audience, not a classroom and a switch. Who answers is ONE choice
 * (ADR-014, addendum 2026-09-27): anyone with the code, anonymously — the
 * poll then belongs to no classroom — or the students of one classroom,
 * signed in and by name. The launcher used to ask for a classroom AND
 * whether the poll was anonymous, and "a classroom, anonymously" was a poll
 * filed under a class that anybody could answer.
 */

/**
 * The audience of the last poll — a classroom id, or {@link ANYONE}; a
 * convenience, never state. The key predates the audience and still holds
 * the classroom a teacher last polled, which stays a valid choice.
 */
const ROOM_KEY = "quiz-poll-classroom";

/** The audience value of "anyone with the code". A classroom id never reads so. */
const ANYONE = "anonymous";

/** Any stored value is taken; a classroom that no longer exists falls back below. */
const anyRoom = (raw: string): raw is string => true;

/** What the Select holds, as the contract's audience. */
function audienceOf(choice: string): PollAudience {
  return choice === ANYONE ? { kind: "anonymous" } : { kind: "classroom", classroomId: choice };
}

/** A row of "Recent polls": how often it ran, and how its last runs went. */
function RecentRow({
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
    <PickRow
      type={pick.type}
      name={pick.internalName}
      prompt={pick.prompt}
      selected={selected}
      onSelect={onSelect}
      aside={<OutcomeBadge outcome={pick.outcome} />}
      meta={
        <>
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
          {pick.saved ? null : ` · ${t("poll.unsaved")}`}
        </>
      }
    />
  );
}

export function PollLauncher({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  // No tab chosen yet: "Recent polls" when it has rows (or is still loading
  // them), "Ask a new question" when there is nothing to run again.
  const [chosenTab, setTab] = useState<"pick" | "pools" | "new" | null>(null);
  const [query, setQuery] = useState("");
  const [questionId, setQuestionId] = useState<string | null>(null);
  // One selection per list: a question picked in one tab is never started
  // from the other, where it is not on screen.
  const [poolQuestionId, setPoolQuestionId] = useState<string | null>(null);
  const [room, setRoom] = usePersistentChoice<string>(ROOM_KEY, anyRoom, ANYONE);
  const [type, setType] = useState<PollType>(POLL_TYPES[0]);
  // One working copy per type, so a switch back and forth loses nothing.
  const [drafts, setDrafts] = useState<Partial<Record<PollType, unknown>>>({});
  const config = drafts[type] ?? EMPTY[type]();

  const picks = useQuery<PollQuestionPick[]>({
    queryKey: pollQuestionsKey,
    queryFn: () => api("/app/api/polls/questions"),
  });
  const tab = chosenTab ?? (picks.data?.length === 0 ? "new" : "pick");
  const donutLegend = useMemo(() => {
    const keyed = (picks.data ?? []).map((p) => p.outcome).filter((o) => o.kind === "keyed");
    return keyed.length === 0 ? null : { abstention: keyed.some((o) => o.abstention !== null) };
  }, [picks.data]);
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
  // The remembered audience, when its classroom still exists; otherwise
  // anyone with the code, which needs no classroom at all.
  const choice = room !== ANYONE && rooms.some((r) => r.id === room) ? room : ANYONE;
  const audience = audienceOf(choice);
  // Until the classrooms are known, the remembered one cannot be shown, and
  // a start would silently go to "anyone".
  const audienceReady = !courses.isLoading;

  const filtered = useMemo(
    () =>
      fuzzyFilter(query, picks.data ?? [], (p) => `${p.internalName} ${promptLine(p.prompt, 400)}`),
    [query, picks.data],
  );

  const picked = tab === "pools" ? poolQuestionId : questionId;
  const start = useMutation({
    mutationFn: () =>
      api<PollTeacherView>("/app/api/polls", {
        method: "POST",
        body: JSON.stringify({ questionId: picked, audience }),
      }),
    onSuccess: (view) => {
      setRoom(view.evaluation.classroomId ?? ANYONE);
      navigate({ view: "poll", id: view.evaluation.id });
    },
  });

  const inline = useMutation({
    mutationFn: () =>
      api<PollTeacherView>("/app/api/polls/inline", {
        method: "POST",
        body: JSON.stringify({ type, config, audience }),
      }),
    onSuccess: (view) => {
      setRoom(view.evaluation.classroomId ?? ANYONE);
      navigate({ view: "poll", id: view.evaluation.id });
    },
  });
  const refused = refusedIssues(inline.error);
  const issues = useMemo(() => (refused ? toConfigIssues(t, refused) : undefined), [refused, t]);

  // ONE primary action per screen, whichever tab: start the poll — on the
  // picked question, or on the one written below.
  const primary =
    tab !== "new" ? (
      <Button
        data-coach="polls.launch"
        onClick={() => start.mutate()}
        loading={start.isPending}
        disabled={picked === null || !audienceReady}
      >
        {t("poll.startAction")}
      </Button>
    ) : (
      <Button
        data-coach="polls.launch"
        onClick={() => inline.mutate()}
        loading={inline.isPending}
        disabled={!audienceReady}
      >
        {t("poll.startAction")}
      </Button>
    );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={t("poll.launcher")} description={t("poll.launcherHint")} actions={primary} />
      <div className="divide-y divide-line border-b border-line pb-1">
        <SettingRow title={t("poll.audience")} desc={t("poll.audienceHint")} className="pt-0">
          {courses.isLoading ? (
            <Skeleton className="h-9 w-full sm:w-80" />
          ) : (
            <Select
              aria-label={t("poll.audience")}
              width="w-full sm:w-80"
              value={choice}
              onChange={(e) => setRoom(e.currentTarget.value)}
            >
              <option value={ANYONE}>{t("poll.audience.anonymous")}</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </Select>
          )}
        </SettingRow>
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        label={t("poll.launcher")}
        items={[
          { value: "pick", label: t("poll.tab.pick"), count: picks.data?.length },
          { value: "pools", label: t("poll.tab.pools") },
          { value: "new", label: t("poll.tab.new") },
        ]}
      />

      {tab === "pools" ? (
        <div className="mt-5 space-y-4">
          <PoolPicks
            classroomId={audience.kind === "classroom" ? audience.classroomId : null}
            selected={poolQuestionId}
            onSelect={setPoolQuestionId}
            onAsk={() => setTab("new")}
          />
          <FormError error={start.error} title={t("poll.startFailed")} />
        </div>
      ) : tab === "pick" ? (
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
            <div className="space-y-2">
              {donutLegend ? <OutcomeLegend abstention={donutLegend.abstention} /> : null}
              <ul className="space-y-2">
                {filtered.map((pick) => (
                  <RecentRow
                    key={pick.id}
                    pick={pick}
                    selected={questionId === pick.id}
                    onSelect={() => setQuestionId(pick.id)}
                  />
                ))}
              </ul>
            </div>
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
