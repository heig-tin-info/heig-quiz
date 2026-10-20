import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Check, Pencil } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import {
  CONCEPT_LANGS,
  CONCEPT_PROPOSE_EXCLUDE_MAX,
  ConceptDuplicatesAi,
  ConceptRelationProposals,
  type AdminConcept,
  type AdminConceptList,
  type ConceptLang,
  type ConceptRelationsAiRequest,
} from "@quiz/contracts";
import { unplaced } from "@quiz/domain";

import { api, refusalCodeOf } from "../api";
import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  ErrorText,
  QueryError,
  RelativeTime,
  SearchInput,
  SectionHeading,
  Segmented,
  Skeleton,
  usePersistentChoice,
  ViewSwitch,
} from "../ui";
import { aiPairsOf, ConceptDuplicates, duplicatePairs } from "./ConceptDuplicates";
import { ConceptRelationReview } from "./ConceptRelationReview";
import { ConceptSheet } from "./ConceptSheet";
import { ConceptStatusBadge } from "./ConceptStatusBadge";
import { conceptName, usesLabel } from "./names";
import { rankConcepts } from "./ranking";
import { BroaderPath } from "./refs";
import { conceptTree } from "./tree";

type Filter = "all" | "proposed" | "validated" | "unplaced" | "duplicates" | "relations";
/** The filters a tree means something on: Unplaced concepts have no edge, their tree is their list. */
const TREEABLE: readonly Filter[] = ["all", "proposed", "validated"];
type QueueView = "list" | "tree";
const VIEW_KEY = "quiz-admin-concepts-view";
const VIEWS: readonly QueueView[] = ["list", "tree"];

/** The languages a concept has no label in: what stops its validation. */
const missingLangs = (c: AdminConcept): ConceptLang[] => CONCEPT_LANGS.filter((lang) => c.labels[lang] === null);

/**
 * The admin's curation queue (ADR-081, fifth addendum): the shared
 * vocabulary, the concepts teachers proposed first, each with how many
 * questions of the instance use it. The screen's one primary action is
 * **Validate**; a concept is renamed, completed in its other language or
 * deleted (when nothing uses it) or merged into a validated concept from its sheet.
 *
 * The vocabulary is loaded whole, as the pickers load it: the filter is a
 * status, the search is `rankConcepts`, the one rule of the picker. The
 * **Probable duplicates** filter lists the pairs `probableDuplicates` finds in
 * that same list (quadratic, fine for hundreds of concepts): no route, nothing
 * stored. "Ask the AI" there (`POST /admin/concepts/duplicates/ai`) adds the
 * model's pairs below, kept in this component's state only.
 *
 * The hierarchy shows on each row as the path above the concept
 * (`broaderTrail`, the picker's rule), and **Unplaced** lists the concepts
 * with no broader and no narrower concept (`unplaced`), whatever their status.
 * **Relations** lists the relations proposed without a model (ADR-114), and
 * the model's on demand (`POST /admin/concepts/relations/ai`, kept here), to
 * tick and accept: its own primary action, so Validate is not there.
 *
 * On All, To validate and Validated, the rows can also be read as a tree
 * (`conceptTree`), a habit remembered per browser: the same rows, indented
 * under the broader concept their path follows, the ancestors of a shown row drawn
 * as its path only.
 */
export function ConceptQueue() {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [view, setView] = usePersistentChoice(VIEW_KEY, VIEWS, "list");
  const treeable = TREEABLE.includes(filter);

  const list = useQuery<AdminConceptList>({
    queryKey: adminConceptsKey,
    queryFn: () => api("/app/api/admin/concepts"),
  });
  const all = list.data?.concepts;
  const proposed = all?.filter((c) => c.status === "proposed").length ?? 0;
  const byId = useMemo(() => new Map((all ?? []).map((c) => [c.id, c])), [all]);
  const loose = useMemo(() => unplaced(all ?? []), [all]);
  const q = typed.trim();
  const rows = useMemo(() => {
    if (filter === "duplicates" || filter === "relations") return [];
    const byStatus =
      filter === "unplaced" ? loose : (all ?? []).filter((c) => filter === "all" || c.status === filter);
    if (q === "") return byStatus;
    // The proposed ones stay ahead of the validated ones, as without a search (the picker's `first`).
    const proposedIds = new Set(byStatus.filter((c) => c.status === "proposed").map((c) => c.id));
    return rankConcepts(q, byStatus, locale, proposedIds);
  }, [all, loose, filter, q, locale]);
  const tree = useMemo(
    () => (treeable && view === "tree" ? conceptTree(byId, rows, locale) : null),
    [treeable, view, byId, rows, locale],
  );

  const found = useMemo(() => duplicatePairs(all ?? []), [all]);
  // Under a search, the pairs of which a concept matches.
  const narrowed = useMemo(() => {
    if (q === "") return () => true;
    const matched = new Set(rankConcepts(q, all ?? [], locale).map((c) => c.id));
    return (p: { a: AdminConcept; b: AdminConcept }) => matched.has(p.a.id) || matched.has(p.b.id);
  }, [all, q, locale]);
  const pairs = useMemo(() => found.filter(narrowed), [found, narrowed]);
  const asked = useMutation({
    mutationFn: async () => ConceptDuplicatesAi.parse(await api("/app/api/admin/concepts/duplicates/ai", { method: "POST" })),
  });
  const aiPairs = useMemo(() => aiPairsOf(asked.data, all ?? [], found).filter(narrowed), [asked.data, all, found, narrowed]);
  // The model's relations (ADR-114 §2), kept here like its pairs so that they survive a filter switch;
  // `seen` accumulates what the page asked about, which Ask again excludes, the latest kept past the cap.
  const proposals = useMutation({
    mutationFn: async (exclude: string[]) => {
      const reply = ConceptRelationProposals.parse(
        await api("/app/api/admin/concepts/relations/ai", { method: "POST", body: JSON.stringify({ exclude } satisfies ConceptRelationsAiRequest) }),
      );
      return { reply, seen: [...exclude, ...reply.asked].slice(-CONCEPT_PROPOSE_EXCLUDE_MAX) };
    },
  });
  const ai = {
    data: proposals.data?.reply,
    isPending: proposals.isPending,
    error: proposals.error,
    ask: () => proposals.mutate(proposals.data?.seen ?? []),
  };
  const edited = all?.find((c) => c.id === editing);

  const validate = useMutation({
    mutationFn: (id: string) => api(`/app/api/admin/concepts/${id}/validate`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: adminConceptsKey });
      void qc.invalidateQueries({ queryKey: conceptsKey });
    },
  });

  return (
    <section className="space-y-4">
      <SectionHeading icon={BookMarked} title={t("admin.concepts.title")} description={t("admin.concepts.hint")} />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          name="concept-filter"
          label={t("admin.concepts.filter")}
          size="sm"
          wrap
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: t("admin.concepts.filter.all") },
            {
              value: "proposed",
              label: proposed > 0 ? t("admin.concepts.filter.proposedCount", { n: proposed }) : t("admin.concepts.filter.proposed"),
            },
            { value: "validated", label: t("admin.concepts.filter.validated") },
            {
              value: "unplaced",
              label: loose.length > 0 ? t("admin.concepts.filter.unplacedCount", { n: loose.length }) : t("admin.concepts.filter.unplaced"),
            },
            {
              value: "duplicates",
              label: found.length > 0 ? t("admin.concepts.filter.duplicatesCount", { n: found.length }) : t("admin.concepts.filter.duplicates"),
            },
            { value: "relations", label: t("admin.concepts.filter.relations") },
          ]}
        />
        <SearchInput
          className="w-full sm:w-64"
          aria-label={t("admin.concepts.search")}
          placeholder={t("admin.concepts.search")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        {treeable ? (
          <div className="ml-auto">
            <ViewSwitch name="concept-view" size="sm" label={t("admin.concepts.view")} views={VIEWS} value={view} onChange={setView} />
          </div>
        ) : null}
      </div>

      {filter === "unplaced" && loose.length > 0 ? (
        <p className="text-[13px] text-fg-muted">{t("admin.concepts.unplaced.hint")}</p>
      ) : null}

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <QueryError title={t("admin.concepts.title")} query={list} />
      ) : filter === "duplicates" ? (
        <ConceptDuplicates
          pairs={pairs}
          aiPairs={aiPairs}
          ai={asked}
          concepts={all ?? []}
          onEdit={setEditing}
        />
      ) : filter === "relations" ? (
        <ConceptRelationReview concepts={all ?? []} ai={ai} narrowed={narrowed} onEdit={setEditing} />
      ) : rows.length === 0 ? (
        <Card>
          {q !== "" ? (
            <EmptyState icon={BookMarked} title={t("admin.concepts.noMatch")} />
          ) : filter === "unplaced" ? (
            <EmptyState icon={Check} title={t("admin.concepts.unplaced.empty")} />
          ) : filter === "proposed" ? (
            <EmptyState icon={Check} title={t("admin.concepts.done.title")} />
          ) : (
            <EmptyState icon={BookMarked} title={t("admin.concepts.empty.title")}>
              {t("admin.concepts.empty.body")}
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {(tree ?? rows.map((concept) => ({ concept, depth: null, alsoUnder: [], pathOnly: false }))).map(
              ({ concept: c, depth, alsoUnder, pathOnly }) =>
                pathOnly && depth !== null ? (
                  <PathRow key={c.id} concept={c} depth={depth} />
                ) : (
                  <ConceptRow
                    key={c.id}
                    concept={c}
                    indent={depth === null ? undefined : indentOf(depth)}
                    path={
                      // In the tree the indentation shows the path; a screen reader still hears it.
                      <>
                        <BroaderPath concept={c} byId={byId} locale={locale} className={depth === null ? undefined : "sr-only"} />
                        {alsoUnder.length > 0 ? (
                          <p className="text-xs text-fg-muted">
                            {t("admin.concepts.tree.alsoUnder", { names: alsoUnder.map((b) => conceptName(b, locale)).join(", ") })}
                          </p>
                        ) : null}
                      </>
                    }
                    validating={validate.isPending && validate.variables === c.id}
                    failed={validate.isError && validate.variables === c.id ? validate.error : null}
                    onValidate={() => validate.mutate(c.id)}
                    onEdit={() => setEditing(c.id)}
                  />
                ),
            )}
          </ul>
        </Card>
      )}

      {edited ? (
        <ConceptSheet concept={edited} concepts={all ?? []} byId={byId} locale={locale} onClose={() => setEditing(null)} />
      ) : null}
    </section>
  );
}

/**
 * A row's place in the tree: 16 px a level, the indent no longer growing past
 * six levels, so a deep row keeps its actions on a phone (they wrap under the
 * name); `aria-level` says the depth. A nested row has a hairline at its left
 * ({@link hairline}).
 */
type Indent = { "aria-level": number; style: { marginInlineStart: string } };
const indentOf = (depth: number): Indent => ({
  "aria-level": depth + 1,
  style: { marginInlineStart: `${Math.min(depth, 6)}rem` },
});
const hairline = (indent: Indent | undefined) => indent !== undefined && indent["aria-level"] > 1 && "border-l border-line";

/** An ancestor of a shown concept that is not shown itself: its name only, dimmed, no action. */
function PathRow({ concept, depth }: { concept: AdminConcept; depth: number }) {
  const t = useT();
  const { locale } = useI18n();
  const indent = indentOf(depth);
  return (
    <li {...indent} className={cx("px-4 py-2 text-sm text-fg-muted", hairline(indent))}>
      {conceptName(concept, locale)}
      <span className="sr-only">, {t("admin.concepts.tree.path")}</span>
    </li>
  );
}

function ConceptRow({
  concept: c,
  indent,
  path,
  validating,
  failed,
  onValidate,
  onEdit,
}: {
  concept: AdminConcept;
  /** Its place in the tree reading. */
  indent?: Indent;
  /** Under the name: the path above it in the list, its other broader concepts in the tree. */
  path: ReactNode;
  validating: boolean;
  failed: unknown;
  onValidate: () => void;
  onEdit: () => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const name = conceptName(c, locale);
  const missing = missingLangs(c);
  const reasonId = `concept-${c.id}-why`;
  const description = c.descriptions[locale] || c.descriptions[locale === "fr" ? "en" : "fr"];

  return (
    <li {...indent} className={cx("flex flex-wrap items-start gap-x-4 gap-y-3 p-4", hairline(indent))}>
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{name}</span>
          <ConceptStatusBadge status={c.status} />
          {missing.map((lang) => (
            <Badge key={lang} tone="red">
              {lang === "fr" ? t("admin.concepts.missing.fr") : t("admin.concepts.missing.en")}
            </Badge>
          ))}
        </div>
        {path}
        {description ? <p className="line-clamp-2 text-xs text-fg-muted">{description}</p> : null}
        <p className="flex flex-wrap gap-x-2 text-xs text-fg-muted">
          <span className="tabular-nums">
            {usesLabel(t, c.questionCount)}
          </span>
          {c.creator ? <span>· {t("admin.concepts.by", { name: c.creator })}</span> : null}
          <span>
            · <RelativeTime iso={c.createdAt} />
          </span>
        </p>
        {failed ? (
          <ErrorText className="text-xs">
            {refusalCodeOf(failed) === "concept_label_missing"
              ? t("admin.concepts.error.missing")
              : t("admin.concepts.error.save")}
          </ErrorText>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {c.status === "proposed" ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              loading={validating}
              disabled={missing.length > 0}
              aria-describedby={missing.length > 0 ? reasonId : undefined}
              aria-label={t("admin.concepts.validateNamed", { name })}
              onClick={onValidate}
            >
              {validating ? null : <Check />} {t("admin.concepts.validate")}
            </Button>
            {missing[0] ? (
              <span id={reasonId} className="sr-only">
                {missing[0] === "fr" ? t("admin.concepts.validate.needs.fr") : t("admin.concepts.validate.needs.en")}
              </span>
            ) : null}
          </>
        ) : null}
        <Button size="sm" variant="ghost" aria-label={t("admin.concepts.editNamed", { name })} onClick={onEdit}>
          <Pencil /> {t("admin.concepts.edit")}
        </Button>
      </div>
    </li>
  );
}
