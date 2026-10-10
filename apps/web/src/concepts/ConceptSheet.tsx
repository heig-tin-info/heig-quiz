import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitMerge, Trash2 } from "lucide-react";
import { useState } from "react";

import { CONCEPT_LANGS, ConceptPatch, type AdminConcept, type ConceptLang } from "@quiz/contracts";

import { api, refusalCodeOf } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Locale } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Button, Field, FormError, Sheet, Textarea } from "../ui";
import { ConceptMergeDialog } from "./ConceptMergeDialog";
import { conceptName } from "./names";

type Side = { label: string; qualifier: string; description: string };
type Sides = Record<ConceptLang, Side>;

const sidesOf = (c: AdminConcept): Sides => ({
  fr: { label: c.labels.fr ?? "", qualifier: c.qualifiers.fr, description: c.descriptions.fr },
  en: { label: c.labels.en ?? "", qualifier: c.qualifiers.en, description: c.descriptions.en },
});

/**
 * What changed, per language, as `PATCH /concepts/:id` takes it: only the
 * fields that differ. A cleared label is not a change the API accepts (a
 * label is never emptied), so it is left out and the save is refused here.
 */
function patchOf(was: Sides, now: Sides) {
  const patch: Record<string, Partial<Side>> = {};
  for (const lang of CONCEPT_LANGS) {
    const changed: Partial<Side> = {};
    for (const field of ["label", "qualifier", "description"] as const) {
      if (now[lang][field].trim() !== was[lang][field]) changed[field] = now[lang][field];
    }
    if (Object.keys(changed).length > 0) patch[lang] = changed;
  }
  return patch;
}

/**
 * One concept's sheet (DESIGN.md › layers): both languages' label, qualifier
 * and description, saved through the existing `PATCH`, and one way to retire
 * it: **Delete** when nothing refers to it, otherwise **Merge into…**, which
 * opens the dialog that folds it into a validated concept (a concept in use
 * is merged, never deleted: ADR-081 third addendum §7). A merge waits for the
 * edits to be saved, so it never drops them silently.
 */
export function ConceptSheet({
  concept,
  concepts,
  locale,
  onClose,
}: {
  concept: AdminConcept;
  /** The whole queue: the validated ones are the targets of a merge. */
  concepts: readonly AdminConcept[];
  locale: Locale;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const was = sidesOf(concept);
  const [sides, setSides] = useState<Sides>(was);
  const [merging, setMerging] = useState(false);
  const name = conceptName(concept, locale);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: adminConceptsKey });
    void qc.invalidateQueries({ queryKey: conceptsKey });
    onClose();
  };
  const save = useMutation({
    mutationFn: (patch: ConceptPatch) =>
      api(`/app/api/concepts/${concept.id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api(`/app/api/admin/concepts/${concept.id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const edit = (lang: ConceptLang, field: keyof Side) => (e: { target: { value: string } }) =>
    setSides((s) => ({ ...s, [lang]: { ...s[lang], [field]: e.target.value } }));
  const patch = patchOf(was, sides);
  const parsed = ConceptPatch.safeParse(patch);
  const dirty = Object.keys(patch).length > 0;
  // A label that had a value is never emptied; a language without one needs it before its qualifier or description.
  const labelCleared = CONCEPT_LANGS.some((lang) => was[lang].label !== "" && sides[lang].label.trim() === "");

  const ask = async () => {
    const ok = await confirm({
      title: t("admin.concepts.delete.title", { name }),
      message: t("admin.concepts.delete.body"),
      confirmLabel: t("admin.concepts.delete"),
      danger: true,
    });
    if (ok) remove.mutate();
  };
  const describe = (error: unknown) => {
    switch (refusalCodeOf(error)) {
      case "concept_exists":
        return t("admin.concepts.error.exists");
      case "concept_dropped":
        return t("admin.concepts.error.dropped");
      case "concept_in_use":
        return t("admin.concepts.error.inUse");
      default:
        return t("admin.concepts.error.save");
    }
  };

  return (
    <Sheet
      title={t("admin.concepts.sheet.title")}
      subtitle={name}
      onClose={onClose}
      footer={
        <>
          {concept.deletable ? (
            <Button variant="danger-quiet" className="mr-auto" loading={remove.isPending} onClick={() => void ask()}>
              {remove.isPending ? null : <Trash2 />} {t("admin.concepts.delete")}
            </Button>
          ) : (
            <Button
              variant="danger-quiet"
              className="mr-auto"
              disabled={dirty}
              aria-describedby={dirty ? "concept-merge-why" : undefined}
              onClick={() => setMerging(true)}
            >
              <GitMerge /> {t("admin.concepts.merge")}
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            loading={save.isPending}
            disabled={!parsed.success || labelCleared}
            onClick={() => parsed.success && save.mutate(parsed.data)}
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-8">
        {CONCEPT_LANGS.map((lang) => (
          <fieldset key={lang} className="space-y-4">
            <legend className="mb-3 text-base font-bold tracking-tight">
              {lang === "fr" ? t("admin.concepts.lang.fr") : t("admin.concepts.lang.en")}
            </legend>
            <Field
              label={t("admin.concepts.label")}
              fullWidth
              lang={lang}
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
        {!concept.deletable && dirty ? (
          <p id="concept-merge-why" className="text-[13px] text-fg-muted">
            {t("admin.concepts.merge.unsaved")}
          </p>
        ) : null}
        <FormError error={save.error ?? remove.error} describe={describe} />
      </div>
      {merging ? (
        <ConceptMergeDialog concept={concept} candidates={concepts} onClose={() => setMerging(false)} onMerged={refresh} />
      ) : null}
    </Sheet>
  );
}
