import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookMarked, Check, Pencil } from "lucide-react";
import { useMemo, useState } from "react";

import { CONCEPT_LANGS, type AdminConcept, type AdminConceptList, type ConceptLang } from "@quiz/contracts";
import { probableDuplicates } from "@quiz/domain";

import { api, refusalCodeOf } from "../api";
import { useI18n, useT } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorText,
  QueryError,
  RelativeTime,
  SearchInput,
  SectionHeading,
  Segmented,
  Skeleton,
} from "../ui";
import { ConceptDuplicates } from "./ConceptDuplicates";
import { ConceptSheet } from "./ConceptSheet";
import { conceptName, usesLabel } from "./names";
import { rankConcepts } from "./ranking";

type Filter = "all" | "proposed" | "validated" | "duplicates";

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
 * stored.
 */
export function ConceptQueue() {
  const t = useT();
  const { locale } = useI18n();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const [typed, setTyped] = useState("");
  const [editing, setEditing] = useState<string | null>(null);

  const list = useQuery<AdminConceptList>({
    queryKey: adminConceptsKey,
    queryFn: () => api("/app/api/admin/concepts"),
  });
  const all = list.data?.concepts;
  const proposed = all?.filter((c) => c.status === "proposed").length ?? 0;
  const q = typed.trim();
  const rows = useMemo(() => {
    const byStatus = (all ?? []).filter((c) => filter === "all" || filter === "duplicates" || c.status === filter);
    if (q === "") return byStatus;
    // The proposed ones stay ahead of the validated ones, as without a search (the picker's `first`).
    const proposedIds = new Set(byStatus.filter((c) => c.status === "proposed").map((c) => c.id));
    return rankConcepts(q, byStatus, locale, proposedIds);
  }, [all, filter, q, locale]);

  const found = useMemo(() => probableDuplicates(all ?? []), [all]);
  // Under a search, the pairs of which a concept matches.
  const pairs = useMemo(() => {
    if (q === "") return found;
    const matched = new Set(rankConcepts(q, all ?? [], locale).map((c) => c.id));
    return found.filter((p) => matched.has(p.a) || matched.has(p.b));
  }, [found, all, q, locale]);
  const duplicates = found.length;
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
              value: "duplicates",
              label: duplicates > 0 ? t("admin.concepts.filter.duplicatesCount", { n: duplicates }) : t("admin.concepts.filter.duplicates"),
            },
          ]}
        />
        <SearchInput
          className="w-full sm:w-64"
          aria-label={t("admin.concepts.search")}
          placeholder={t("admin.concepts.search")}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>

      {list.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError ? (
        <QueryError title={t("admin.concepts.title")} query={list} />
      ) : filter === "duplicates" ? (
        <ConceptDuplicates pairs={pairs} concepts={all ?? []} onEdit={setEditing} />
      ) : rows.length === 0 ? (
        <Card>
          {q !== "" ? (
            <EmptyState icon={BookMarked} title={t("admin.concepts.noMatch")} />
          ) : filter === "proposed" ? (
            <EmptyState icon={Check} title={t("admin.concepts.done.title")}>
              {t("admin.concepts.done.body")}
            </EmptyState>
          ) : (
            <EmptyState icon={BookMarked} title={t("admin.concepts.empty.title")}>
              {t("admin.concepts.empty.body")}
            </EmptyState>
          )}
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((c) => (
              <ConceptRow
                key={c.id}
                concept={c}
                validating={validate.isPending && validate.variables === c.id}
                failed={validate.isError && validate.variables === c.id ? validate.error : null}
                onValidate={() => validate.mutate(c.id)}
                onEdit={() => setEditing(c.id)}
              />
            ))}
          </ul>
        </Card>
      )}

      {edited ? <ConceptSheet concept={edited} concepts={all ?? []} locale={locale} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function ConceptRow({
  concept: c,
  validating,
  failed,
  onValidate,
  onEdit,
}: {
  concept: AdminConcept;
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
    <li className="flex flex-wrap items-start gap-x-4 gap-y-3 p-4">
      <div className="min-w-0 flex-1 basis-60 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-semibold">{name}</span>
          <Badge tone={c.status === "validated" ? "green" : "amber"}>
            {c.status === "validated" ? t("admin.concepts.status.validated") : t("admin.concepts.status.proposed")}
          </Badge>
          {missing.map((lang) => (
            <Badge key={lang} tone="red">
              {lang === "fr" ? t("admin.concepts.missing.fr") : t("admin.concepts.missing.en")}
            </Badge>
          ))}
        </div>
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
