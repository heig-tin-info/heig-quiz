import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Eye, Library, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import type {
  PoolSummary,
  PreviewResult,
  QuestionPage,
  QuestionRow,
} from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { EMPTY_FILTERS, questionQuery, type QuestionFilters } from "../pool/filters";
import { DifficultyDots } from "../pool/QuestionTable";
import { QUESTION_TYPE_IDS, typeLabel } from "../questionTypes";
import { routeToPath } from "../router";
import {
  Alert,
  ASIDE_MIN_WIDTH,
  Badge,
  Button,
  Checkbox,
  cx,
  EmptyState,
  FormError,
  LinkButton,
  listboxIndex,
  QueryError,
  SearchInput,
  Select,
  Sheet,
  Skeleton,
  Tip,
  useMinWidth,
} from "../ui";
import { poolQuestionsKey } from "../queryKeys";
import { useTargetRefresh, type EditTarget } from "./editTarget";
import { questionPreviewQuery } from "../question/previewQuery";
import { PreviewedQuestion, type StudentQuestion } from "./PreviewedQuestion";

/**
 * The question picker (F-EVAL-01): a pool on the left of the filter bar, a
 * search, a type and a difficulty, and a list of checkboxes.
 *
 * It is a Sheet and not a dialog because it is a long form that must not hide
 * the list it feeds — the teacher ticks five questions, closes, and sees them
 * land in order. The list is deliberately flat (no category tree here): the
 * tree belongs to the pool screen, where a teacher is organising; here they
 * are shopping, and a search box is faster than a tree.
 *
 * A question with no published version is shown and disabled rather than
 * hidden: "where is my question?" is a worse five minutes than "ah, I never
 * published it" (the server would answer `422 no_published_version` anyway).
 * So is a question kept after an opinion poll, which has no correct answer
 * (`keyless`, `422 question_keyless`): it runs polls, never an evaluation.
 *
 * A name alone does not say what a question asks (issue #207), so LOOKING and
 * TICKING are two gestures: the checkbox ticks, the rest of the row shows the
 * question as a student will read it — in a pane docked to the left of the
 * sheet when the window has room for both, in place of the list otherwise
 * (a sheet never opens another sheet). Every row can be looked at, the
 * disabled ones included: "what is this draft?" is the question they raise.
 *
 * It fills an evaluation or a template alike: the `target` names the pools
 * to offer (the course's linked pools, either way) and where the pick goes.
 */
export function AddQuestionsSheet({
  target,
  existing,
  onClose,
}: {
  target: EditTarget;
  /** Question ids already in the list; they are ticked and disabled. */
  existing: Set<string>;
  onClose: () => void;
}) {
  const t = useT();
  const refresh = useTargetRefresh(target);
  const [poolId, setPoolId] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [difficulty, setDifficulty] = useState<number | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  // The row last looked at. Kept as the row, not its id: the question stays
  // on screen while the teacher narrows the search around it.
  const [shown, setShown] = useState<QuestionRow | null>(null);
  const docked = useMinWidth(ASIDE_MIN_WIDTH);
  const rowButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const nameId = useId();
  // On a narrow window the preview takes the list's place; "Back" hands the
  // focus to the row it came from, not to the top of the sheet.
  const backTo = useRef<string | null>(null);

  const pools = useQuery<PoolSummary[]>({
    queryKey: target.poolsKey,
    queryFn: () => api(`${target.base}/pools`),
  });
  const current = poolId ?? pools.data?.[0]?.id ?? null;

  // The pool screen's own filter state and query string (`pool/filters.ts`),
  // so an equal search is the SAME request under the SAME key as the pool
  // screen's list: a question created there is not stale here, and whatever
  // invalidates the pool invalidates this list too.
  const filters = useMemo<QuestionFilters>(
    () => ({
      ...EMPTY_FILTERS,
      q,
      types: type ? [type] : [],
      difficulties: difficulty === null ? [] : [difficulty],
    }),
    [q, type, difficulty],
  );
  const search = questionQuery(filters);
  const questions = useInfiniteQuery<QuestionPage>({
    queryKey: poolQuestionsKey(current ?? "", search),
    enabled: current !== null,
    queryFn: ({ pageParam }) =>
      api(
        `/app/api/pools/${current}/questions${questionQuery(filters, pageParam as string | null)}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = useMemo(
    () => (questions.data?.pages ?? []).flatMap((page) => page.items),
    [questions.data],
  );

  const add = useMutation({
    mutationFn: () =>
      api(`${target.base}/items`, {
        method: "POST",
        body: JSON.stringify({ questionIds: picked }),
      }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });

  const toggle = (id: string) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  // ↑/↓ walk the list and the preview follows; only from a row, never from
  // inside the preview, whose fields take the arrows for themselves.
  // Space ticks the row, as on the checkbox beside it: shopping a list with
  // the keyboard is ↓ to read, Space to take. Enter (and a click) looks.
  const walk = (e: React.KeyboardEvent, index: number, tickable: boolean) => {
    if (e.key === " ") {
      e.preventDefault();
      if (tickable) toggle(rows[index]!.id);
      return;
    }
    // Docked only: on a narrow window the preview takes the list's place, so
    // an arrow would open it rather than walk to the next row.
    if (!docked) return;
    const next = listboxIndex(e.key, index, rows.length);
    if (next === null || next === index) return;
    e.preventDefault();
    setShown(rows[next]!);
    rowButtons.current[next]?.focus();
  };

  const preview = shown ? <QuestionPreview row={shown} /> : null;
  const back = () => {
    backTo.current = shown?.id ?? null;
    setShown(null);
  };
  useEffect(() => {
    if (shown !== null || backTo.current === null) return;
    rowButtons.current[rows.findIndex((r) => r.id === backTo.current)]?.focus();
    backTo.current = null;
  }, [shown, rows]);

  return (
    <Sheet
      title={t("picker.title")}
      subtitle={picked.length > 0 ? t("picker.selected", { n: picked.length }) : undefined}
      onClose={onClose}
      width="lg"
      aside={docked && preview ? <div className="p-6">{preview}</div> : undefined}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={() => add.mutate()}
            loading={add.isPending}
            disabled={picked.length === 0}
          >
            {picked.length === 0
              ? t("picker.title")
              : picked.length === 1
                ? t("picker.addOne")
                : t("picker.add", { n: picked.length })}
          </Button>
        </>
      }
    >
      {preview && !docked ? (
        <div className="space-y-4">
          <Button variant="secondary" size="sm" onClick={back} autoFocus>
            <ArrowLeft /> {t("picker.preview.back")}
          </Button>
          {preview}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Select
              label={t("picker.pool")}
              value={current ?? ""}
              onChange={(e) => {
                setPoolId(e.target.value);
                setPicked([]);
              }}
              width="w-56"
            >
              {(pools.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select
              label={t("picker.type")}
              value={type}
              onChange={(e) => setType(e.target.value)}
              width="w-40"
            >
              <option value="">{t("picker.allTypes")}</option>
              {QUESTION_TYPE_IDS.map((id) => (
                <option key={id} value={id}>
                  {typeLabel(t, id)}
                </option>
              ))}
            </Select>
            <Select
              label={t("picker.difficulty")}
              value={difficulty === null ? "" : String(difficulty)}
              onChange={(e) => setDifficulty(e.target.value === "" ? null : Number(e.target.value))}
              width="w-40"
            >
              <option value="">{t("picker.allDifficulties")}</option>
              {[1, 2, 3, 4, 5].map((d) => (
                <option key={d} value={String(d)}>
                  {"●".repeat(d)}
                </option>
              ))}
            </Select>
          </div>
          <SearchInput
            className="w-full"
            aria-label={t("picker.search")}
            placeholder={t("picker.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />

          {pools.isLoading || questions.isLoading ? (
            <div className="space-y-2">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : pools.isError ? (
            <QueryError
              title={t("picker.noPool.title")}
              error={pools.error}
              onRetry={() => void pools.refetch()}
              retrying={pools.isFetching}
              fallback={t("error.server")}
            />
          ) : (pools.data ?? []).length === 0 ? (
            <EmptyState icon={Library} title={t("picker.noPool.title")}>
              {t("picker.noPool.body")}
            </EmptyState>
          ) : questions.isError ? (
            <QueryError
              title={t("picker.empty.title")}
              error={questions.error}
              onRetry={() => void questions.refetch()}
              retrying={questions.isFetching}
              fallback={t("error.server")}
            />
          ) : rows.length === 0 ? (
            <EmptyState icon={Search} title={t("picker.empty.title")}>
              {t("picker.empty.body")}
            </EmptyState>
          ) : (
            <>
              <ul className="divide-y divide-line rounded-field border border-line">
                {rows.map((row, index) => {
                  const unpublished = row.latestNumber === null;
                  // Kept after an opinion poll: no key, so it would grade the
                  // class against nothing (`422 question_keyless`).
                  const keyless = !unpublished && row.keyless;
                  const already = existing.has(row.id);
                  const looked = shown?.id === row.id;
                  return (
                    <li
                      key={row.id}
                      className={cx("flex items-center gap-3 px-3", looked && "bg-accent-soft")}
                    >
                      <Checkbox
                        checked={already || picked.includes(row.id)}
                        disabled={unpublished || keyless || already}
                        onChange={() => toggle(row.id)}
                        label={null}
                        aria-labelledby={`${nameId}-${index}`}
                      />
                      <button
                        type="button"
                        ref={(el) => {
                          rowButtons.current[index] = el;
                        }}
                        aria-pressed={looked}
                        aria-label={t("picker.preview.show", {
                          name: row.internalName,
                        })}
                        onClick={() => setShown(row)}
                        onKeyDown={(e) => walk(e, index, !(unpublished || keyless || already))}
                        className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-2 text-left text-sm"
                      >
                        <span id={`${nameId}-${index}`} className="truncate font-medium">
                          {row.internalName}
                        </span>
                        <span className="text-xs text-fg-faint">{typeLabel(t, row.type)}</span>
                        <DifficultyDots value={row.difficulty} />
                        {row.deprecated ? (
                          <Badge tone="amber">{t("eval.questions.deprecated")}</Badge>
                        ) : null}
                        {unpublished ? (
                          <Tip label={t("picker.unpublishedHint")}>
                            <Badge tone="zinc">{t("picker.unpublished")}</Badge>
                          </Tip>
                        ) : null}
                        {keyless ? (
                          <Tip label={t("picker.keylessHint")}>
                            <Badge tone="zinc">{t("picker.keyless")}</Badge>
                          </Tip>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
              {/* One page is what the pool screen asks for too; the rest is one
                click away, never silently cut off. */}
              {questions.hasNextPage ? (
                <div className="flex justify-center">
                  <Button
                    variant="secondary"
                    loading={questions.isFetchingNextPage}
                    onClick={() => void questions.fetchNextPage()}
                  >
                    {t("pool.loadMore")}
                  </Button>
                </div>
              ) : null}
            </>
          )}

          <FormError error={add.error} title={t("eval.saveFailed")} />
        </div>
      )}
    </Sheet>
  );
}

/**
 * One question of the picker as a student will read it: the latest PUBLISHED
 * version — the one "Add" would freeze into the evaluation — or the draft of
 * a question never published, said so. Same request and cache entry as the
 * editor's own preview (`questionPreviewKey`), through `studentView` on the
 * server (invariant 4). The editor opens in a new tab: leaving would close
 * the sheet and drop the ticks.
 */
function QuestionPreview({ row }: { row: QuestionRow }) {
  const t = useT();
  const source = row.latestNumber ?? "draft";
  const query = useQuery<PreviewResult, Error, StudentQuestion>({
    ...questionPreviewQuery(row.id, source),
    select: (r) => ({ type: r.type, student: r.student, points: r.itemPoints }),
    // A published version never changes; a draft may, in another tab.
    staleTime: source === "draft" ? 0 : Infinity,
  });
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate font-semibold">{row.internalName}</h3>
          <p className="mt-0.5 text-sm text-fg-muted">
            {source === "draft"
              ? typeLabel(t, row.type)
              : t("picker.preview.version", {
                  type: typeLabel(t, row.type),
                  n: source,
                })}
          </p>
        </div>
        {/* An anchor, not a button: middle-click and "open in a new window"
            must work too, and `noopener` keeps the editor tab detached. */}
        <LinkButton
          variant="ghost"
          size="sm"
          href={routeToPath({ view: "question", id: row.id })}
          target="_blank"
          rel="noopener"
        >
          {t("picker.preview.openEditor")} <ExternalLink />
        </LinkButton>
      </div>
      {source === "draft" ? (
        <Alert icon={Eye} title={t("picker.preview.draftTitle")}>
          {t("picker.preview.draftBody")}
        </Alert>
      ) : null}
      <PreviewedQuestion query={query} />
    </div>
  );
}
