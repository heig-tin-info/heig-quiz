import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import { CONCEPT_LANGS, ConceptFill, ConceptFillRequest, type ConceptLang } from "@quiz/contracts";

import { api, apiErrorMessage } from "../api";
import { useT } from "../i18n";
import { useLlmAvailability } from "../llmAvailability";
import { Alert, Button } from "../ui";
import type { Sides } from "./ConceptSheet";
import { refName } from "./names";

/**
 * The form with the model's proposal in its EMPTY fields only: a field the
 * admin filled, before or while the model thought, is never overwritten. A
 * label that already names another concept (`taken`) is left empty, and the
 * qualifier comes only with the label it qualifies.
 */
export function fillEmpty(sides: Sides, proposal: ConceptFill): Sides {
  const next = { ...sides };
  for (const lang of CONCEPT_LANGS) {
    const side = { ...sides[lang] };
    const p = proposal[lang];
    if (p.label && !p.taken && side.label.trim() === "") {
      side.label = p.label.label;
      if (side.qualifier.trim() === "") side.qualifier = p.label.qualifier;
    }
    if (p.description && side.description.trim() === "") side.description = p.description;
    next[lang] = side;
  }
  return next;
}

/** Whether the proposal brings anything to the form. */
const brings = (proposal: ConceptFill) =>
  CONCEPT_LANGS.some((lang) => (proposal[lang].label && !proposal[lang].taken) || proposal[lang].description);

/**
 * "Fill with AI" on the concept sheet (ADR-081 §7, amendment of 2026-10-13):
 * sends the form as it stands — this concept's labels, qualifiers and
 * descriptions, nothing else — and puts the proposal in its empty fields.
 * Nothing is saved: the sheet's Save stays the only write. Offered only when
 * a model is configured, and only when some field is empty and some label is
 * there to start from.
 */
export function FillWithAi({ conceptId, sides, onFill }: { conceptId: string; sides: Sides; onFill: (proposal: ConceptFill) => void }) {
  const t = useT();
  const llm = useLlmAvailability();
  const fill = useMutation({
    mutationFn: async (form: ConceptFillRequest) =>
      ConceptFill.parse(await api(`/app/api/admin/concepts/${conceptId}/fill`, { method: "POST", body: JSON.stringify(form) })),
    onSuccess: onFill,
  });
  if (llm.data?.available !== true) return null;

  const form = ConceptFillRequest.safeParse(sides);
  const some = (f: (lang: ConceptLang) => boolean) => CONCEPT_LANGS.some(f);
  const fillable =
    form.success &&
    some((lang) => form.data[lang].label !== "") &&
    some((lang) => form.data[lang].label === "" || form.data[lang].description === "");
  const langName = (lang: ConceptLang) => (lang === "fr" ? t("admin.concepts.lang.fr") : t("admin.concepts.lang.en"));

  return (
    <section aria-label={t("admin.concepts.fill")} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button
          variant="secondary"
          size="sm"
          loading={fill.isPending}
          disabled={!fillable}
          onClick={() => form.success && fill.mutate(form.data)}
        >
          {fill.isPending ? null : <Sparkles />} {t("admin.concepts.fill")}
        </Button>
        <p className="min-w-0 flex-1 basis-64 text-xs text-fg-muted">{t("admin.concepts.fill.hint")}</p>
      </div>
      {fill.isError ? (
        <Alert tone="danger" title={t("admin.concepts.fill.failed")}>
          {apiErrorMessage(fill.error, t("error.llmFailed"))}
        </Alert>
      ) : null}
      {fill.data && !fill.isPending ? (
        <div className="space-y-2 text-sm">
          <p className="text-fg-muted">{t(brings(fill.data) ? "admin.concepts.fill.done" : "admin.concepts.fill.none")}</p>
          {CONCEPT_LANGS.map((lang) => {
            const p = fill.data[lang];
            if (!p.label) return null;
            const label = refName(p.label);
            if (p.taken) {
              return (
                <Alert key={lang} tone="warning" title={t("admin.concepts.fill.taken.title", { lang: langName(lang) })}>
                  {t("admin.concepts.fill.taken", { label, name: refName(p.taken) })}
                </Alert>
              );
            }
            return p.close.length > 0 ? (
              <p key={lang} className="text-fg-muted">
                {t("admin.concepts.fill.close", { label, names: p.close.map(refName).join(", ") })}
              </p>
            ) : null;
          })}
        </div>
      ) : null}
    </section>
  );
}
