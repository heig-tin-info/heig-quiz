/**
 * The three decisions of the tag sorting screen, each in its layer: map the
 * selection onto an existing concept, name a new one, or drop it with a
 * reason. Each sets a PENDING decision; Accept, on the screen, writes it.
 */
import { useState } from "react";

import { TAG_DROP_REASONS, TagSortingChoice, type Concept, type TagDropReason, type TagSortingRow } from "@quiz/contracts";

import { useT, type Locale } from "../i18n";
import { Badge, Button, Field, FormDialog, QueryError, RadioRow, Sheet, Spinner, Textarea } from "../ui";
import { rankConcepts } from "./ranking";
import { byUse, conceptName, conceptSide } from "./sorting";
import { useConcepts } from "./useConcepts";

/**
 * The searchable list of the vocabulary, to map the selection onto one
 * concept. The search starts on the most worn selected tag, which is what the
 * admin would type: `pointeurs` finds `Pointeur` first.
 */
export function MapDialog({
  pairs,
  locale,
  onClose,
  onPick,
}: {
  pairs: readonly TagSortingRow[];
  locale: Locale;
  onClose: () => void;
  onPick: (concept: Concept) => void;
}) {
  const t = useT();
  const concepts = useConcepts();
  const [query, setQuery] = useState(() => byUse(pairs)[0]?.tag ?? "");
  const [picked, setPicked] = useState<string | null>(null);

  const all = concepts.data?.concepts ?? [];
  const matches = rankConcepts(query, all, locale);
  const choice = all.find((c) => c.id === picked);

  return (
    <FormDialog
      title={t(pairs.length === 1 ? "admin.concepts.map.title.one" : "admin.concepts.map.title", { n: pairs.length })}
      onClose={onClose}
      onSubmit={() => choice && onPick(choice)}
      submitLabel={t("admin.concepts.map.submit")}
      canSubmit={choice !== undefined}
    >
      <Field
        label={t("admin.concepts.map.search")}
        type="search"
        fullWidth
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {concepts.isLoading ? (
        <Spinner className="py-6" />
      ) : concepts.isError ? (
        <QueryError title={t("admin.concepts.map.list")} query={concepts} />
      ) : matches.length === 0 ? (
        <p className="text-[13px] text-fg-muted">{t("admin.concepts.map.none")}</p>
      ) : (
        <fieldset className="max-h-72 divide-y divide-line overflow-y-auto rounded-field border border-line">
          <legend className="sr-only">{t("admin.concepts.map.list")}</legend>
          {matches.map((c) => {
            const { description } = conceptSide(c, locale);
            return (
              <RadioRow key={c.id} name="concept" value={c.id} checked={picked === c.id} onPick={setPicked}>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-semibold">{conceptName(c, locale)}</span>
                  {/* `GET /concepts` leaves merged concepts out: two statuses remain. */}
                  <Badge tone={c.status === "validated" ? "green" : "zinc"}>
                    {t(c.status === "validated" ? "admin.concepts.status.validated" : "admin.concepts.status.proposed")}
                  </Badge>
                </span>
                {description ? <span className="mt-0.5 block text-xs text-fg-muted">{description}</span> : null}
              </RadioRow>
            );
          })}
        </fieldset>
      )}
    </FormDialog>
  );
}

/** `lecture-de-code` → `Lecture de code`: a starting point, never the label as is. */
const labelOf = (tag: string) => {
  const words = tag.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

type Side = { label: string; qualifier: string; description: string };

/**
 * A new concept for the selection, in both languages (a validated concept has
 * both, second addendum §2). The French side starts from the most worn tag
 * and the first pool description; the English one is the admin's to write.
 * Six fields, so a sheet (DESIGN.md › layers).
 */
export function NewConceptSheet({
  pairs,
  onClose,
  onApply,
}: {
  pairs: readonly TagSortingRow[];
  onClose: () => void;
  onApply: (choice: TagSortingChoice) => void;
}) {
  const t = useT();
  const [sides, setSides] = useState<{ fr: Side; en: Side }>(() => {
    const ranked = byUse(pairs);
    return {
      fr: {
        label: ranked[0] ? labelOf(ranked[0].tag) : "",
        qualifier: "",
        description: ranked.find((p) => p.description)?.description ?? "",
      },
      en: { label: "", qualifier: "", description: "" },
    };
  });
  const edit = (lang: "fr" | "en", field: keyof Side) => (e: { target: { value: string } }) =>
    setSides((s) => ({ ...s, [lang]: { ...s[lang], [field]: e.target.value } }));
  const parsed = TagSortingChoice.safeParse({ kind: "new", ...sides });
  const n = pairs.length;

  return (
    <Sheet
      title={t(n === 1 ? "admin.concepts.new.title.one" : "admin.concepts.new.title", { n })}
      subtitle={t("admin.concepts.new.hint")}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!parsed.success} onClick={() => parsed.success && onApply(parsed.data)}>
            {t(n === 1 ? "admin.concepts.apply.one" : "admin.concepts.apply", { n })}
          </Button>
        </>
      }
    >
      <div className="space-y-8">
        {(["fr", "en"] as const).map((lang) => (
          <fieldset key={lang} className="space-y-4">
            <legend className="mb-3 text-base font-bold tracking-tight">{t(`admin.concepts.lang.${lang}`)}</legend>
            <Field
              label={t("admin.concepts.label")}
              required
              fullWidth
              lang={lang}
              autoFocus={lang === "en"}
              value={sides[lang].label}
              onChange={edit(lang, "label")}
            />
            <Field
              label={t("admin.concepts.qualifier")}
              hint={t("admin.concepts.optional")}
              description={lang === "fr" ? t("admin.concepts.qualifier.desc") : undefined}
              fullWidth
              lang={lang}
              value={sides[lang].qualifier}
              onChange={edit(lang, "qualifier")}
            />
            <Textarea
              label={t("admin.concepts.description")}
              lang={lang}
              maxLength={500}
              value={sides[lang].description}
              onChange={edit(lang, "description")}
            />
          </fieldset>
        ))}
      </div>
    </Sheet>
  );
}

/** Why the selection is not a concept: one of three reasons (ADR-081 §1). */
export function DropDialog({
  count,
  onClose,
  onApply,
}: {
  count: number;
  onClose: () => void;
  onApply: (reason: TagDropReason) => void;
}) {
  const t = useT();
  const [reason, setReason] = useState<TagDropReason | null>(null);
  return (
    <FormDialog
      title={t(count === 1 ? "admin.concepts.drop.title.one" : "admin.concepts.drop.title", { n: count })}
      onClose={onClose}
      onSubmit={() => reason && onApply(reason)}
      submitLabel={t("admin.concepts.drop")}
      canSubmit={reason !== null}
    >
      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("admin.concepts.drop.reason")}</legend>
        <div className="divide-y divide-line overflow-hidden rounded-field border border-line">
          {TAG_DROP_REASONS.map((r) => (
            <RadioRow key={r} name="drop-reason" value={r} checked={reason === r} onPick={setReason}>
              <span className="block font-medium">{t(`admin.concepts.reason.${r}`)}</span>
              <span className="block text-xs text-fg-muted">{t(`admin.concepts.reason.${r}.desc`)}</span>
            </RadioRow>
          ))}
        </div>
      </fieldset>
    </FormDialog>
  );
}
