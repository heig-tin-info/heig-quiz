/**
 * The end of an account's identity, as its person sees it (ADR-117 §5): the
 * Settings row that anonymizes the reader's own account, the notice of a
 * sign-in that made a dormant account active again, and the words of every
 * refusal (`PSEUDONYMIZE_REFUSALS`), which the administration reads too.
 * "Anonymized", never "deleted" (glossary §1.5): the results stay.
 */
import { useMutation } from "@tanstack/react-query";
import { UserX, X } from "lucide-react";
import { useState } from "react";

import { ANONYMIZED_PARAM, REACTIVATED_PARAM, SELF_PSEUDONYMIZE_PATH, type Me, type PseudonymizeRefusal } from "@quiz/contracts";

import { api, wordedRefusal } from "./api";
import { useConfirm } from "./confirm";
import { useT, type Dict } from "./i18n";
import { purgeAllNotepads } from "./notepad/store";
import { useToast } from "./notify";
import { useOneTimeParam, type Route } from "./router";
import { Alert, Button, IconButton, SettingRow } from "./ui";

/**
 * Every refusal of a pseudonymization, worded: the table is closed, a new
 * code does not compile without its words. `session_required` is the
 * guard's (`ownSessionGuard`), for a session the row should not have shown.
 */
export const PSEUDONYMIZE_REFUSAL_WORDS: Record<PseudonymizeRefusal | "session_required", keyof Dict> = {
  not_found: "error.notFound",
  already_anonymized: "account.refusal.alreadyAnonymized",
  open_attempt: "account.refusal.openAttempt",
  running_classroom: "account.refusal.runningClassroom",
  staff: "account.anonymize.staff",
  not_due: "account.refusal.notDue",
  session_required: "account.refusal.sessionRequired",
};

/**
 * The last row of "Your data", under the export: a student anonymizes their
 * own account, behind a typed confirmation (their address). A staff
 * account reads who does it instead. Only on the person's own portal
 * session, what the route admits: never an impersonation nor a confined
 * session. On success the session is gone: the page reloads on the landing
 * page, which says what happened (`ANONYMIZED_PARAM`); a toast would not
 * outlive the sign-out.
 */
export function AnonymizeAccountRow({ me }: { me: Me }) {
  const t = useT();
  const toast = useToast();
  const confirm = useConfirm();
  const anonymize = useMutation({
    mutationFn: () => api(SELF_PSEUDONYMIZE_PATH, { method: "POST" }),
    onSuccess: () => {
      // ADR-090: no notepad outlives the session on this device.
      purgeAllNotepads();
      window.location.assign(`/?${ANONYMIZED_PARAM}=1`);
    },
    onError: (error) => toast(wordedRefusal(error, PSEUDONYMIZE_REFUSAL_WORDS, t), "error"),
  });
  if (me.session?.kind !== "portal") return null;
  if (me.role !== "student") {
    return <SettingRow title={t("account.anonymize")} desc={t("account.anonymize.staff")} />;
  }
  return (
    <SettingRow title={t("account.anonymize")} desc={t("account.anonymize.desc")}>
      <Button
        variant="danger-quiet"
        loading={anonymize.isPending}
        onClick={async () => {
          const ok = await confirm({
            title: t("account.anonymize.confirmTitle"),
            message: t("account.anonymize.confirmBody"),
            typeToConfirm: me.email,
            confirmLabel: t("account.anonymize.confirm"),
            danger: true,
          });
          if (ok) anonymize.mutate();
        }}
      >
        <UserX /> {t("account.anonymize.action")}
      </Button>
    </SettingRow>
  );
}

/**
 * ADR-117 §5: a sign-in that ended a dormancy lands with
 * `REACTIVATED_PARAM` once (the OIDC callback adds it). One notice, until
 * dismissed, with the way to Settings for whoever would rather anonymize.
 */
export function ReactivatedNotice({ navigate }: { navigate: (r: Route) => void }) {
  const t = useT();
  const flagged = useOneTimeParam([REACTIVATED_PARAM]) !== null;
  const [open, setOpen] = useState(flagged);
  if (!open) return null;
  return (
    <div className="mb-6">
      <Alert
        title={t("account.reactivated.title")}
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setOpen(false);
                navigate({ view: "settings" });
              }}
            >
              {t("account.reactivated.open")}
            </Button>
            <IconButton label={t("common.close")} size="sm" onClick={() => setOpen(false)}>
              <X />
            </IconButton>
          </div>
        }
      >
        {t("account.reactivated.body")}
      </Alert>
    </div>
  );
}
