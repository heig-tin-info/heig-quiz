import { useQuery } from "@tanstack/react-query";
import { Container } from "lucide-react";

import { ADMIN_WORKSPACE_IMAGES_PATH, type AdminWorkspaceImage } from "@quiz/contracts";

import { api, isNotFound } from "./api";
import { formatBytes, useI18n, useT, type Dict } from "./i18n";
import { adminWorkspaceImagesKey } from "./queryKeys";
import { Badge, Card, cx, EmptyState, QueryError, RelativeTime, SectionHeading, Skeleton, T, TableHead, type Tone } from "./ui";

/** What an image is to this instance: the default and a base are the platform's, an orphan nobody's here. */
const KIND: Record<AdminWorkspaceImage["kind"], { tone: Tone; label: keyof Dict }> = {
  default: { tone: "accent", label: "admin.images.kind.default" },
  base: { tone: "zinc", label: "admin.images.kind.base" },
  admitted: { tone: "green", label: "admin.images.kind.admitted" },
  orphan: { tone: "amber", label: "admin.images.kind.orphan" },
};

/** The last use of an image by this instance's sessions, the latest of its admissions'; null if never. */
const lastUse = (image: AdminWorkspaceImage): string | null =>
  image.admissions.reduce<string | null>((last, a) => (a.lastUsedAt && (!last || a.lastUsedAt > last) ? a.lastUsedAt : last), null);

/**
 * The engine's store of workspace images (ADR-146 §8), on the System tab:
 * a storage question, beside the disk checks, and no tab of its own on a
 * platform without the online workspace, nor with a portal that serves no
 * image (the route's 404, `images_unavailable` included: nothing drawn).
 * Read-only: each image's names, what it is to this instance, its size on
 * disk, the courses, images and projects that use it and its last use, with
 * the total. Staging and production share the store and the administrator
 * frees space by hand on the engine VM (the portal's RUNBOOK).
 */
export function WorkspaceImagesSection() {
  const t = useT();
  const { locale } = useI18n();
  // Read once per visit of the System tab, never polled.
  const images = useQuery<AdminWorkspaceImage[]>({ queryKey: adminWorkspaceImagesKey, queryFn: () => api(ADMIN_WORKSPACE_IMAGES_PATH) });
  if (isNotFound(images.error)) return null;

  const rows = images.data ?? [];
  const total = rows.reduce((sum, image) => sum + (image.diskBytes ?? 0), 0);
  return (
    <section className="space-y-3" data-testid="admin-workspace-images">
      <SectionHeading
        icon={Container}
        title={t("admin.images")}
        count={images.data ? rows.length : undefined}
        description={t("admin.images.hint")}
        actions={
          images.data && rows.length > 0 ? (
            <span className="text-[13px] tabular-nums text-fg-muted">{t("admin.images.total", { total: formatBytes(total, locale) })}</span>
          ) : null
        }
      />
      {images.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : images.isError ? (
        <QueryError title={t("admin.images.loadFailed")} query={images} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState icon={Container} title={t("admin.images.empty")} className="py-8" />
        </Card>
      ) : (
        <Card className={cx("overflow-x-auto", T.container)}>
          <table role="table" className={cx(T.table, T.stack.table)}>
            <TableHead
              columns={[
                { key: "image", label: t("admin.images.col.image"), sortable: false, stack: "main" },
                { key: "kind", label: t("admin.images.col.kind"), sortable: false, stack: "sub" },
                { key: "disk", label: t("admin.images.col.disk"), sortable: false, right: true, stack: "sub" },
                { key: "uses", label: t("admin.images.col.uses"), sortable: false, className: T.colMid },
                { key: "lastUse", label: t("admin.images.col.lastUse"), sortable: false, className: T.colHigh },
              ]}
            />
            <tbody role="rowgroup">
              {rows.map((image, i) => (
                <ImageRow key={image.id ?? `gone-${i}`} image={image} />
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </section>
  );
}

function ImageRow({ image }: { image: AdminWorkspaceImage }) {
  const t = useT();
  const { locale } = useI18n();
  const kind = KIND[image.kind];
  const [name, ...aliases] = image.names.length > 0 ? image.names : [image.admissions[0]?.reference ?? image.id ?? "—"];
  const uses = image.admissions.flatMap((a) => a.uses);
  const live = image.admissions.reduce((n, a) => n + a.liveSessions, 0);
  const used = lastUse(image);
  return (
    <tr role="row" className={cx(T.row, T.stack.row)}>
      <td role="cell" className={cx(T.td, T.stack.main, "@max-md:whitespace-normal")}>
        <span className="font-mono text-xs font-semibold [overflow-wrap:anywhere]">{name}</span>
        {aliases.map((alias) => (
          <div key={alias} className="mt-0.5 font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">
            {alias}
          </div>
        ))}
      </td>
      <td role="cell" className={cx(T.td, T.stack.sub, "whitespace-nowrap")}>
        <Badge tone={kind.tone}>{t(kind.label)}</Badge>
      </td>
      <td role="cell" className={cx(T.td, T.stack.sub, "whitespace-nowrap text-right tabular-nums")}>
        {image.diskBytes !== null ? formatBytes(image.diskBytes, locale) : "—"}
      </td>
      <td role="cell" className={cx(T.td, T.colMid, "whitespace-normal text-fg-muted")}>
        {uses.length === 0
          ? "—"
          : uses.map((use) => (
              <div key={`${use.course.id}-${use.image.id}`}>
                <span className="text-fg">{use.course.code}</span> · {use.image.name}
                {use.projects.length > 0 ? ` (${use.projects.map((p) => p.name).join(", ")})` : null}
              </div>
            ))}
      </td>
      <td role="cell" className={cx(T.td, T.colHigh, "whitespace-nowrap text-fg-muted")}>
        {used ? <RelativeTime iso={used} /> : "—"}
        {live > 0 ? <div className="text-xs">{t("admin.images.live", { n: live })}</div> : null}
      </td>
    </tr>
  );
}
