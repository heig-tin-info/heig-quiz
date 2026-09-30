import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import type { QuestionDetail } from "@quiz/contracts";

import { api } from "../api";
import { useT } from "../i18n";
import { QuestionTypePicker, TypeFace } from "./QuestionTypePicker";
import { QUESTION_TYPE_IDS } from "../questionTypes";
import { Button, Field, FormError, Modal, cx } from "../ui";

type Step = "type" | "name";

/**
 * "New question" from the pool screen: a type, then an internal name,
 * created in the category the sidebar has selected (none means the pool's
 * root).
 *
 * Two steps sliding in one dialog, each with one thing to do. Choosing a
 * type IS the "next": a click (or Enter on a tile) slides to the name, whose
 * field already holds the focus, and Enter creates. "Back" slides to the
 * grid with the chosen type still marked and the name kept. The palette's
 * "New question — Code" knows the type already and opens on the name.
 */
export function NewQuestionModal({
  poolId,
  categoryId,
  initialType,
  onClose,
  onCreated,
}: {
  poolId: string;
  categoryId: string | null;
  /** The palette can ask for a type ("New question — Code"); null asks the teacher. */
  initialType: string | null;
  onClose: () => void;
  onCreated: (question: QuestionDetail) => void;
}) {
  const t = useT();
  const formId = useId();
  const [type, setType] = useState(initialType ?? "");
  const [step, setStep] = useState<Step>(initialType ? "name" : "type");
  const [name, setName] = useState("");
  const typePane = useRef<HTMLFieldSetElement>(null);
  const namePane = useRef<HTMLFormElement>(null);
  const [height, setHeight] = useState<number>();
  const create = useMutation({
    mutationFn: () =>
      api<QuestionDetail>(`/app/api/pools/${poolId}/questions`, {
        method: "POST",
        body: JSON.stringify({
          type,
          internalName: name.trim(),
          ...(categoryId ? { categoryId } : {}),
        }),
      }),
    onSuccess: onCreated,
  });

  // The viewport takes the height of the pane on screen, so the dialog grows
  // or shrinks with the slide instead of jumping at its end.
  useLayoutEffect(() => {
    const current = (step === "type" ? typePane : namePane).current;
    if (!current) return;
    const fit = () => setHeight(current.offsetHeight);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(current);
    return () => observer.disconnect();
  }, [step]);
  // The focus follows the slide: the name field, or the tile just left. This
  // runs after the dialog's own first-focus, so it wins on opening too.
  useEffect(() => {
    const target =
      step === "name"
        ? namePane.current?.querySelector("input")
        : (typePane.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ??
          typePane.current?.querySelector("button"));
    target?.focus({ preventScroll: true });
  }, [step]);

  const canSubmit = name.trim() !== "";
  return (
    <Modal
      title={t("pool.newQuestion")}
      size="lg"
      onClose={onClose}
      footer={
        step === "type" ? (
          <Button variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => setStep("type")}>
              {t("common.back")}
            </Button>
            <Button type="submit" form={formId} loading={create.isPending} disabled={!canSubmit}>
              {t("pool.newQuestionAction")}
            </Button>
          </>
        )
      }
    >
      <div
        className="-mx-5 overflow-hidden px-5 transition-[height] duration-200 ease-(--ease-out-emphasized) motion-reduce:transition-none"
        style={{ height }}
      >
        <div
          className={cx(
            "flex items-start gap-5 transition-transform duration-200 ease-(--ease-out-emphasized) motion-reduce:transition-none",
            step === "name" && "-translate-x-[calc(100%+1.25rem)]",
          )}
        >
          <fieldset ref={typePane} inert={step !== "type"} className="w-full shrink-0 pb-1">
            <legend className="mb-2 text-[13px] font-medium">{t("pool.questionType")}</legend>
            <QuestionTypePicker
              types={QUESTION_TYPE_IDS}
              value={type}
              onChange={(next) => {
                setType(next);
                setStep("name");
              }}
            />
          </fieldset>
          <form
            id={formId}
            ref={namePane}
            inert={step !== "name"}
            className="w-full shrink-0 space-y-4 pb-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit && !create.isPending) create.mutate();
            }}
          >
            <div className="flex items-center gap-3 rounded-card border border-line bg-surface-2 p-3">
              <TypeFace id={type} active />
            </div>
            <Field
              label={t("pool.questionName")}
              hint={t("pool.questionNameHint")}
              fullWidth
              placeholder={t("pool.questionNamePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <FormError error={create.error} fallback={t("pool.createFailed")} />
          </form>
        </div>
      </div>
    </Modal>
  );
}
