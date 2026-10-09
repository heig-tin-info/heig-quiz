import { useQuery } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";

import type { ChangelogEntry, ChangelogKind, ChangelogList } from "@quiz/contracts";

import { api } from "../api";
import { useI18n, type Dict } from "../i18n";
import { MarkdownView } from "../markdown/MarkdownView";
import { changelogKey } from "../queryKeys";
import { Badge, Button, Card, EmptyState, isoDateParts, Modal, PageHeader, QueryError, Skeleton, type Tone } from "../ui";

/**
 * What's new on the platform (ADR-087): the dialog after an update and the
 * history page, one list drawn by both — entries grouped by release (the
 * first boot that served them), newest first, each with its kind. The text
 * is the entry's own bilingual content, in the reader's language.
 */

const KIND: Record<ChangelogKind, { label: keyof Dict; tone: Tone }> = {
  new: { label: "whatsNew.kind.new", tone: "green" },
  changed: { label: "whatsNew.kind.changed", tone: "zinc" },
  moved: { label: "whatsNew.kind.moved", tone: "zinc" },
  deprecated: { label: "whatsNew.kind.deprecated", tone: "amber" },
  removed: { label: "whatsNew.kind.removed", tone: "amber" },
};

/** Consecutive entries of one release; the server sends them newest first. */
function releases(entries: ChangelogList): ChangelogEntry[][] {
  const out: ChangelogEntry[][] = [];
  for (const entry of entries) {
    const last = out.at(-1)?.[0];
    if (last && last.liveAt === entry.liveAt && last.commitSha === entry.commitSha) out.at(-1)!.push(entry);
    else out.push([entry]);
  }
  return out;
}

/** `Heading`: `h3` under the dialog's title, `h2` under the page's. */
function ReleaseList({ entries, Heading }: { entries: ChangelogList; Heading: "h2" | "h3" }) {
  const { t, locale } = useI18n();
  return (
    <div className="divide-y divide-line">
      {releases(entries).map((release) => {
        const { liveAt, commitSha } = release[0]!;
        return (
          <section key={`${liveAt}-${commitSha}`} className="space-y-3 py-5 first:pt-0 last:pb-0">
            <Heading className="text-[13px] font-semibold text-fg-muted">
              {isoDateParts(liveAt).date}
              {commitSha ? (
                <>
                  {" · "}
                  <span className="font-mono font-normal">{commitSha.slice(0, 7)}</span>
                </>
              ) : null}
            </Heading>
            <ul className="space-y-2.5">
              {release.map((entry) => (
                <li key={entry.id} className="flex flex-col items-start gap-1 text-sm sm:flex-row sm:gap-3">
                  <Badge tone={KIND[entry.kind].tone} className="justify-center sm:mt-px sm:w-24">
                    {t(KIND[entry.kind].label)}
                  </Badge>
                  <MarkdownView inline source={entry.text[locale] || entry.text.en} className="min-w-0 flex-1" />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** After an update: the unseen entries, once. Closing it by any means is reading it. */
export function WhatsNewModal({ entries, onClose }: { entries: ChangelogList; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal
      title={t("whatsNew.title")}
      subtitle={t("whatsNew.since")}
      size="lg"
      scroll
      onClose={onClose}
      footer={
        // The one action holds the focus, not the close button (ADR-087).
        <Button autoFocus onClick={onClose}>
          {t("whatsNew.gotIt")}
        </Button>
      }
    >
      <ReleaseList entries={entries} Heading="h3" />
    </Modal>
  );
}

/** The history: every entry the reader may see (the account menu's What's new). */
export function WhatsNewPage() {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: changelogKey,
    queryFn: () => api<ChangelogList>("/app/api/changelog"),
  });
  return (
    <div className="space-y-6">
      <PageHeader title={t("whatsNew.title")} description={t("whatsNew.description")} />
      {list.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : list.isError ? (
        <QueryError
          title={t("whatsNew.title")}
          error={list.error}
          onRetry={() => void list.refetch()}
          retrying={list.isFetching}
        />
      ) : list.data.length === 0 ? (
        <Card className="px-6 py-4">
          <EmptyState icon={Sparkles} title={t("whatsNew.empty")}>
            {t("whatsNew.emptyBody")}
          </EmptyState>
        </Card>
      ) : (
        <Card className="p-5">
          <ReleaseList entries={list.data} Heading="h2" />
        </Card>
      )}
    </div>
  );
}
