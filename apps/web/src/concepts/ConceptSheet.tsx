import { useMutation, useQueryClient } from "@tanstack/react-query";
import { GitMerge, TriangleAlert, Trash2, X } from "lucide-react";
import { useState } from "react";

import { CONCEPT_LANGS, ConceptPatch, type AdminConcept, type AliasCollision, type Concept, type ConceptLang } from "@quiz/contracts";
import { conceptKey } from "@quiz/domain";

import { api, ApiError, refusalCodeOf } from "../api";
import { useConfirm } from "../confirm";
import { useT, type Locale } from "../i18n";
import { adminConceptsKey, conceptsKey } from "../queryKeys";
import { Alert, Button, Field, FormError, Sheet, Textarea } from "../ui";
import { ConceptMergeDialog } from "./ConceptMergeDialog";
import { conceptName, refName } from "./names";

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
 * The curated aliases (ADR-081 §6, fifth addendum): chips with a remove
 * button, and a field to add one. Each change is saved at once, apart from
 * the labels' Save (it is a separate decision, audited alone). An alias that
 * is the label or an alias of another concept comes back as a 409
 * `alias_collision`: the warning names those concepts and the admin confirms
 * with "Add anyway" or drops it.
 */
function Aliases({ concept }: { concept: AdminConcept }) {
  const t = useT();
  const qc = useQueryClient();
  const [typed, setTyped] = useState("");
  const [collision, setCollision] = useState<{ alias: string; collisions: AliasCollision["collisions"] } | null>(null);
  const base = `/app/api/admin/concepts/${concept.id}/aliases`;
  const changed = () => {
    void qc.invalidateQueries({ queryKey: adminConceptsKey });
    void qc.invalidateQueries({ queryKey: conceptsKey });
  };
  const add = useMutation({
    mutationFn: (v: { alias: string; force?: boolean }) =>
      api<Concept>(base, { method: "POST", body: JSON.stringify(v) }),
    onSuccess: () => {
      setTyped("");
      setCollision(null);
      changed();
    },
    onError: (error, v) => {
      if (error instanceof ApiError && refusalCodeOf(error) === "alias_collision") {
        setCollision({ alias: v.alias, collisions: (error.body as AliasCollision).collisions });
      }
    },
  });
  const remove = useMutation({
    mutationFn: (alias: string) => api<Concept>(`${base}/${encodeURIComponent(conceptKey(alias))}`, { method: "DELETE" }),
    onSuccess: changed,
  });
  const describe = (error: unknown) => {
    switch (refusalCodeOf(error)) {
      case "alias_redundant":
        return t("admin.concepts.error.aliasRedundant");
      case "alias_exists":
        return t("admin.concepts.error.aliasExists");
      case "concept_merged":
        return t("admin.concepts.error.merged");
      default:
        return t("admin.concepts.error.alias");
    }
  };
  const submit = () => {
    const alias = typed.trim();
    if (alias === "") return;
    setCollision(null);
    add.mutate({ alias });
  };

  return (
    <fieldset className="space-y-3">
      <legend className="mb-1 text-base font-bold tracking-tight">{t("admin.concepts.aliases")}</legend>
      <p className="text-xs text-fg-muted">{t("admin.concepts.aliases.desc")}</p>
      {concept.aliases.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("admin.concepts.aliases.none")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {concept.aliases.map((alias) => (
            <li key={alias} className="inline-flex items-center gap-1 rounded-full bg-surface-3 py-0.5 pl-2.5 pr-1 text-sm">
              {alias}
              <button
                type="button"
                disabled={remove.isPending}
                aria-label={t("admin.concepts.aliases.remove", { name: alias })}
                onClick={() => remove.mutate(alias)}
                className="shrink-0 rounded-full p-0.5 text-fg-faint transition-colors hover:bg-line-strong hover:text-fg"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-end gap-2">
        <Field
          label={t("admin.concepts.aliases.field")}
          fullWidth
          maxLength={120}
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            setCollision(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Button variant="secondary" loading={add.isPending && !collision} disabled={typed.trim() === ""} onClick={submit}>
          {t("admin.concepts.aliases.add")}
        </Button>
      </div>
      {collision ? (
        <Alert
          tone="warning"
          icon={TriangleAlert}
          title={t("admin.concepts.aliases.collision.title", { alias: collision.alias })}
          action={
            <span className="flex gap-2">
              <Button variant="secondary" onClick={() => setCollision(null)}>
                {t("admin.concepts.aliases.collision.cancel")}
              </Button>
              <Button
                variant="secondary"
                loading={add.isPending}
                onClick={() => add.mutate({ alias: collision.alias, force: true })}
              >
                {t("admin.concepts.aliases.collision.confirm")}
              </Button>
            </span>
          }
        >
          <ul className="list-disc pl-4">
            {collision.collisions.map(({ concept: other, via }) => (
              <li key={other.id}>
                {t(via === "label" ? "admin.concepts.aliases.collision.label" : "admin.concepts.aliases.collision.alias", {
                  name: refName(other),
                })}
              </li>
            ))}
          </ul>
          <p className="mt-1">{t("admin.concepts.aliases.collision.body")}</p>
        </Alert>
      ) : null}
      <FormError error={add.error && !collision ? add.error : remove.error} describe={describe} />
    </fieldset>
  );
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
        <Aliases concept={concept} />
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
