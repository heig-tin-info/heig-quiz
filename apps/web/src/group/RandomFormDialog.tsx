import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { GroupRandomForm, type GroupRemainder, type GroupSetDetail } from "@quiz/contracts";

import { useT } from "../i18n";
import { useToast } from "../notify";
import { Field, FieldError, fieldErrorProps, FormDialog, Segmented } from "../ui";
import { defaultRandomSize, groupRefusalMessage, sizesSummary } from "./groupRules";

const SIZE_ID = "group-random-size";

/**
 * The random formation (ADR-070 §3): the students of the set in no group,
 * shuffled by the server and cut into new groups of the size chosen — from
 * 1 to their number — the remainder to smaller or to larger groups. The
 * dialog says what it will make before it is sent (`groupSizes` of
 * `@quiz/domain`, the very rule the server applies); groups already formed
 * are never touched, and there is no Undo: the result is a set of new
 * groups, each deleted on its own.
 */
export function RandomFormDialog({
  detail,
  form,
  onClose,
}: {
  detail: GroupSetDetail;
  /** Sends the body through the set's write queue. */
  form: (body: GroupRandomForm) => Promise<GroupSetDetail>;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const n = detail.unplaced.length;
  const maxSize = detail.set.maxSize;
  const [size, setSize] = useState(String(defaultRandomSize(n, maxSize)));
  const [remainder, setRemainder] = useState<GroupRemainder>("smaller");
  const body = GroupRandomForm.safeParse({ size: Number(size), remainder });
  const valid = body.success && body.data.size <= n;
  const sizes = valid ? sizesSummary(n, body.data.size, remainder) : [];
  const groups = sizes.reduce((sum, s) => sum + s.count, 0);

  const submit = useMutation({
    mutationFn: (b: GroupRandomForm) => form(b),
    onSuccess: () => {
      toast(t(groups === 1 ? "groups.random.formed.one" : "groups.random.formed", { n: groups }), "success");
      onClose();
    },
  });

  return (
    <FormDialog
      title={t("groups.random.title")}
      onClose={onClose}
      onSubmit={() => body.success && submit.mutate(body.data)}
      submitLabel={t("groups.random.submit")}
      submitting={submit.isPending}
      canSubmit={valid}
      error={submit.isError ? <p className="text-[13px] text-danger">{groupRefusalMessage(submit.error, t)}</p> : null}
    >
      <p className="text-sm text-fg-muted">{t(n === 1 ? "groups.random.desc.one" : "groups.random.desc", { n })}</p>
      <div className="flex flex-wrap items-end gap-4">
        <div className="flex flex-col gap-1">
          <Field
            id={SIZE_ID}
            label={t("groups.random.size")}
            type="number"
            min={1}
            max={n}
            width="w-24"
            className="text-right tabular-nums"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            {...fieldErrorProps(SIZE_ID, valid ? undefined : t("groups.refusal.sizeOutOfRange", { max: n }))}
          />
        </div>
        <Segmented
          name="remainder"
          label={t("groups.random.remainder")}
          value={remainder}
          onChange={setRemainder}
          options={[
            { value: "smaller", label: t("groups.random.smaller") },
            { value: "larger", label: t("groups.random.larger") },
          ]}
        />
      </div>
      {valid ? (
        <div className="rounded-field bg-surface-2 px-3 py-2.5 text-sm" aria-live="polite">
          <p className="font-medium">
            {sizes.map((s) => t(s.count === 1 ? "groups.random.sizes.one" : "groups.random.sizes", { n: s.count, size: s.size })).join(" · ")}
          </p>
          {maxSize !== null && sizes.some((s) => s.size > maxSize) ? (
            <p className="mt-0.5 text-[13px] text-warning">{t("groups.random.overMax", { max: maxSize })}</p>
          ) : null}
        </div>
      ) : (
        <FieldError id={SIZE_ID}>{t("groups.refusal.sizeOutOfRange", { max: n })}</FieldError>
      )}
    </FormDialog>
  );
}
