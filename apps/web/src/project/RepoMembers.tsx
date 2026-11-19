import { Activity, Mail, Users } from "lucide-react";

import type { ProjectDetail, ProjectRepoView } from "@quiz/contracts";

import { studentName } from "../group/groupRules";
import { useI18n, useT } from "../i18n";
import { Button, Card, Dash, HeatLegend, HeatTable, SectionHeading, SegmentedBar, T, TableHead, Tip, useNow, weekLabel } from "../ui";
import { AccessTag, StudentAccount } from "./parts";
import { commitWeeks, entryMembers, resendable, weekCounts, type CommitHeatRow, type RepoEntry } from "./projectPage";
import type { RepoWrites } from "./useRepoWrites";

/** A count of commits and its share of the repository's, as a thin bar on the neutral `info` ink (no verdict). */
function CommitShare({ n, total }: { n: number | null; total: number }) {
  if (n === null) return <Dash />;
  return (
    <span className="flex items-center gap-3">
      <span className="w-8 shrink-0 text-right font-semibold tabular-nums">{n}</span>
      <SegmentedBar parts={[{ tone: "info", value: n }]} total={Math.max(total, 1)} className="h-1.5 max-w-48 flex-1" />
    </span>
  );
}

/**
 * The people of a repository's page (ADR-137, F-PROJ-07, ADR-136): one
 * row per member — the student of an individual repository —, by name and
 * GitHub login; their access as a tag while they are not in (joined says
 * nothing); the commits they authored with their share of the repository's
 * count, whose denominator holds the unattributed ones, said on a last row
 * when there are any. **Resend** is the section's one action while someone
 * waits or their invitation expired: the repository's resend reaches every
 * member still out. A row not accepted yet lists its members and nothing
 * of GitHub.
 */
export function RepoMembers({ entry, can, resend }: { entry: RepoEntry; can: boolean; resend: RepoWrites["resend"] }) {
  const t = useT();
  const members = entryMembers(entry);
  const { repo } = entry;
  const unattributed = repo?.unattributed.n ?? 0;
  return (
    <section aria-labelledby="repo-members" className="space-y-3">
      <SectionHeading
        icon={Users}
        title={<span id="repo-members">{t("project.sheet.members")}</span>}
        count={members.length}
        description={t(repo ? "project.repoPage.members.desc" : "project.repoPage.members.notAccepted")}
        actions={
          repo && resendable(entry) ? (
            <Button variant="secondary" size="sm" disabled={!can} loading={resend.isPending} onClick={() => resend.mutate()}>
              <Mail /> {t("project.invitation.resend")}
            </Button>
          ) : undefined
        }
      />
      <Card className={`${T.container} overflow-x-auto`}>
        {members.length === 0 ? (
          <p className="px-4 py-3 text-sm text-fg-faint">{t("project.repo.noMember")}</p>
        ) : (
          <table className={T.table}>
            <TableHead
              columns={[
                { key: "member", label: t("project.repoPage.col.member") },
                ...(repo
                  ? [
                      { key: "access", label: t("project.repoPage.col.access"), className: T.colHigh },
                      { key: "commits", label: t("project.repoPage.commits"), className: "w-1/2" },
                    ]
                  : []),
              ]}
            />
            <tbody>
              {members.map((m) => (
                <tr key={m.enrollmentId ?? m.email} className={T.row}>
                  <td className={T.td}>
                    <span className="flex flex-col gap-0.5">
                      <span className="font-semibold">{studentName(m)}</span>
                      <StudentAccount student={m} />
                      {/* Where the Access column is dropped, the tag follows the account. */}
                      <span className="@2xl:hidden">
                        <AccessTag member={m} />
                      </span>
                    </span>
                  </td>
                  {repo ? (
                    <>
                      <td className={`${T.td} ${T.colHigh}`}>
                        <AccessTag member={m} />
                      </td>
                      <td className={T.td}>
                        <CommitShare n={m.authored?.n ?? null} total={repo.commits} />
                      </td>
                    </>
                  ) : null}
                </tr>
              ))}
              {repo && unattributed > 0 ? (
                <tr className={T.row} data-testid="repo-unattributed">
                  <td className={`${T.td} text-fg-muted`}>
                    <Tip label={t("project.repo.unattributedTip")}>
                      <span>{t("project.repoPage.unattributed")}</span>
                    </Tip>
                  </td>
                  <td className={`${T.td} ${T.colHigh}`} />
                  <td className={`${T.td} text-fg-muted`}>
                    <CommitShare n={unattributed} total={repo.commits} />
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </Card>
    </section>
  );
}

/** A week's column: about square, the label above it fitting ("Nov 16"). */
const WEEK = { rowHeader: "9rem", column: "2.5rem" };

/**
 * The repository's commits per week (ADR-137, ADR-136): one row per member
 * who authored any and one for the unattributed ones, one fixed-width
 * column per week (its Monday) from the project's start to its deadline —
 * the weeks to come empty — or to today once past it, on the heat ramp. A
 * cell names the person, the week and the count. A repository with no
 * commit says so instead.
 */
export function RepoActivity({ project, entry, repo }: { project: ProjectDetail; entry: RepoEntry; repo: ProjectRepoView }) {
  const t = useT();
  const { locale } = useI18n();
  const now = useNow();
  const rows: CommitHeatRow[] = [
    ...entryMembers(entry).flatMap((m) => (m.authored ? [{ key: m.enrollmentId ?? m.email, label: studentName(m), series: m.authored }] : [])),
    ...(repo.unattributed.n > 0 ? [{ key: "unattributed", label: t("project.repoPage.unattributed"), series: repo.unattributed }] : []),
  ];
  const weeks = commitWeeks(rows, project, now);
  const labels = weeks.map((w) => weekLabel(w, locale));
  return (
    <section aria-labelledby="repo-activity" className="space-y-3">
      <SectionHeading icon={Activity} title={<span id="repo-activity">{t("project.repoPage.activity")}</span>} description={t("project.repoPage.activity.desc")} />
      <Card className="space-y-3 p-4">
        {repo.commits === 0 || rows.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("project.repoPage.activity.none")}</p>
        ) : (
          <>
            <HeatTable
              caption={t("project.repoPage.activity.caption")}
              rowHeader={t("project.repoPage.col.member")}
              columns={weeks.map((w, i) => ({ key: w, label: labels[i]!, srLabel: labels[i]! }))}
              rows={rows.map((r) => ({ key: r.key, label: r.label, values: weekCounts(r.series, weeks) }))}
              cellTitle={(r, c, n) =>
                t(n === 1 ? "project.repoPage.activity.cell.one" : "project.repoPage.activity.cell", { who: rows[r]!.label, week: labels[c]!, n })
              }
              fixed={WEEK}
            />
            <HeatLegend offHours={false} />
          </>
        )}
      </Card>
    </section>
  );
}
