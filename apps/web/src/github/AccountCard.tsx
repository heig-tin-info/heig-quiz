/**
 * The user Settings' GitHub card (F-GH-05, `docs/merge/05-web.md` §5.3):
 * link the account through the App's own authorisation, or show the linked
 * login and unlink it.
 *
 * Shown only when it is relevant (`GithubAccountState.relevant`: staff of a
 * connected classroom, or a user who has or had a project), and always while
 * an account is linked, so it can be unlinked. Absent on a platform without
 * Quiz's App (the route answers 404), and while it loads: a card that
 * appears late is better than one that appears and vanishes.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { api } from "../api";
import { useConfirm } from "../confirm";
import { useT } from "../i18n";
import { useErrorToast, useToast } from "../notify";
import { meGithubKey } from "../queryKeys";
import { Button, Card, GithubIcon, isoDateParts, LinkButton, SectionHeading, SettingRow } from "../ui";
import { githubLinkHref, useGithubAccount } from "./api";

export function GithubAccountCard() {
  const t = useT();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const toastError = useErrorToast();
  const state = useGithubAccount();
  const unlink = useMutation({
    mutationFn: () => api("/app/api/me/github", { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: meGithubKey });
      toast(t("github.unlinked"), "success");
    },
    onError: toastError("github.unlinkFailed"),
  });

  const data = state.data;
  if (!data || (!data.relevant && data.account === null)) return null;
  const account = data.account;

  return (
    <section className="space-y-3">
      <SectionHeading icon={GithubIcon} title={t("github.section")} />
      <Card className="px-5">
        <SettingRow
          title={t("github.account")}
          desc={
            account
              ? t("github.accountLinked", { login: account.login, date: isoDateParts(account.linkedAt).date })
              : t("github.accountUnlinked")
          }
        >
          {account ? (
            <Button
              variant="secondary"
              loading={unlink.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: t("github.unlinkConfirm", { login: account.login }),
                    message: t("github.unlinkBody"),
                    confirmLabel: t("github.unlink"),
                    cancelLabel: t("common.cancel"),
                    danger: true,
                  })
                ) {
                  unlink.mutate();
                }
              }}
            >
              {t("github.unlink")}
            </Button>
          ) : (
            // Back to this page (F-GH-05), where the return toast is read.
            <LinkButton href={githubLinkHref(window.location.pathname)}>
              <GithubIcon /> {t("github.link")}
            </LinkButton>
          )}
        </SettingRow>
      </Card>
    </section>
  );
}
