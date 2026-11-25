/**
 * The Images tab of a course (ADR-146 §4–§8): the workspace images its
 * projects may run instead of the default, `quiz-base`. Each row names the
 * image, its reference, where its admission stands (Downloading…,
 * Checking…, Ready, Refused with the reason in words, Obsolete), its size on
 * the engine's disk and the projects that pick it. The list is read again
 * every few seconds while an admission is in flight.
 *
 * The tab's one primary action, "Add image", sits in the page header
 * (`CoursePage`) for whoever may manage the list (`canManage`: an owner of
 * the course with the workspace grant); it opens {@link AddImageDialog}.
 * The rows' Refresh, Rename and Remove are theirs too; the rest of the staff
 * reads. A refused Refresh keeps the digest in service: the row says the
 * previous version keeps running. The portal's own diagnostic (`detail`) is
 * only ever quoted, in monospace, under the reason.
 */
import { AlertTriangle, Container, ExternalLink, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  CourseWorkspaceImageCreate,
  CourseWorkspaceImagePatch,
  type CourseWorkspaceImage,
  type CourseWorkspaceImages,
} from "@quiz/contracts";

import { useConfirm } from "../confirm";
import { DOCS_URL } from "../Header";
import { formatBytes, useI18n, useT, type Dict } from "../i18n";
import { useToast } from "../notify";
import {
  Actions,
  Alert,
  Badge,
  Card,
  cx,
  EmptyState,
  Field,
  FormDialog,
  QueryError,
  RelativeTime,
  Skeleton,
  textLink,
  TextFieldDialog,
  type Tone,
} from "../ui";
import {
  imageErrorText,
  inFlight,
  projectsInUse,
  reasonKey,
  refusalDetail,
  useCourseWorkspaceImages,
  useImageWrites,
} from "./workspaceImages";

/** The guide's page on deriving an image, on the documentation site. */
export const IMAGES_GUIDE_URL = `${DOCS_URL}guide/workspace-images/`;

/** An admission's state as a badge: in flight blue, ready green, refused red. */
const STATE: Record<CourseWorkspaceImage["state"], { tone: Tone; label: keyof Dict }> = {
  downloading: { tone: "blue", label: "courses.images.state.downloading" },
  checking: { tone: "blue", label: "courses.images.state.checking" },
  ready: { tone: "green", label: "courses.images.state.ready" },
  refused: { tone: "red", label: "courses.images.state.refused" },
};

export function CourseImages({
  courseId,
  adding,
  onAdding,
}: {
  courseId: string;
  /** The Add dialog is open: the header's primary action opened it. */
  adding: boolean;
  onAdding: (open: boolean) => void;
}) {
  const t = useT();
  const list = useCourseWorkspaceImages(courseId);

  if (list.isPending) return <Skeleton className="h-40 w-full" />;
  // A 404 (the feature off) never reaches here: the page hides the tab.
  if (list.isError) return <QueryError title={t("courses.images.loadFailed")} query={list} />;
  const { images, canManage, max } = list.data;
  const guide = (
    <a href={IMAGES_GUIDE_URL} target="_blank" rel="noopener noreferrer" className={cx(textLink, "inline-flex items-center gap-1")}>
      {t("courses.images.guide")} <ExternalLink className="size-3.5" aria-hidden />
    </a>
  );

  return (
    <div className="space-y-4">
      {images.length === 0 ? (
        // Words, not a second button: "Add image" is in the header.
        <Card>
          <EmptyState icon={Container} title={t("courses.images.empty.title")}>
            <span className="block">{t("courses.images.empty.body")}</span>
            <span className="mt-2 block">{guide}</span>
          </EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-line px-4">
          {images.map((image) => (
            <ImageRow key={image.id} courseId={courseId} image={image} list={list.data} />
          ))}
        </Card>
      )}
      <p className="text-[13px] text-fg-muted">
        {!canManage
          ? t("courses.images.readOnly")
          : images.length >= max
            ? t("courses.images.full", { max })
            : null}
        {images.length > 0 ? <span className="ml-1">{guide}</span> : null}
      </p>
      {adding && canManage ? <AddImageDialog courseId={courseId} base={list.data.base} max={max} onClose={() => onAdding(false)} /> : null}
    </div>
  );
}

/** The projects of a list, by name: "Labo 2, Labo 3". */
const namesOf = (projects: readonly { name: string }[]) => projects.map((p) => p.name).join(", ");

function ImageRow({ courseId, image, list }: { courseId: string; image: CourseWorkspaceImage; list: CourseWorkspaceImages }) {
  const t = useT();
  const { locale } = useI18n();
  const confirm = useConfirm();
  const toast = useToast();
  const writes = useImageWrites(courseId);
  const [renaming, setRenaming] = useState(false);
  const state = STATE[image.state];
  const running = inFlight(image.state);
  // A refused Refresh leaves the digest in service: the image still runs.
  const kept = image.state === "refused" && image.digestReference !== null;

  const fail = (error: unknown) => toast(imageErrorText(error, t, list.max), "error");
  const confirmRemove = async () => {
    const ok = await confirm({
      title: t("courses.images.removeTitle"),
      message: t("courses.images.removeConfirm", { name: image.name }),
      confirmLabel: t("courses.images.remove"),
      danger: true,
    });
    if (!ok) return;
    writes.remove.mutate(image.id, {
      onSuccess: () => toast(t("courses.images.removed"), "success"),
      onError: (error) => {
        const projects = projectsInUse(error);
        if (projects) toast(t("courses.images.inUse", { list: namesOf(projects) }), "error");
        else fail(error);
      },
    });
  };

  return (
    <div className="flex items-start gap-3 py-3" data-testid="workspace-image">
      <Container className="mt-0.5 size-5 shrink-0 text-fg-faint" aria-hidden />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-medium">{image.name}</span>
          <Badge tone={state.tone}>{t(state.label)}</Badge>
          {image.obsolete ? (
            <Badge tone="amber" icon={AlertTriangle}>
              {t("courses.images.obsolete")}
            </Badge>
          ) : null}
        </div>
        <p className="font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">{image.reference}</p>
        <p className="text-[13px] text-fg-muted">
          {image.baseVersion ? <>{t("courses.images.base", { version: image.baseVersion })} · </> : null}
          {image.diskBytes !== null ? (
            <>
              <span className="tabular-nums">{formatBytes(image.diskBytes, locale)}</span> ·{" "}
            </>
          ) : null}
          <RelativeTime iso={image.updatedAt} />
        </p>
        <p className="text-[13px] text-fg-muted [overflow-wrap:anywhere]">
          {image.projects.length > 0 ? t("courses.images.usedBy", { list: namesOf(image.projects) }) : t("courses.images.unused")}
        </p>
        {image.state === "refused" ? (
          <div className="space-y-0.5 text-[13px]" data-testid="workspace-image-refusal">
            <p className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-danger" aria-hidden />
              <span>
                {image.reason ? t(reasonKey(image.reason)) : t("courses.images.state.refused")}
                {kept ? <span className="block text-fg-muted">{t("courses.images.kept")}</span> : null}
              </span>
            </p>
            {image.detail ? (
              // The portal's diagnostic, quoted as it is: never a sentence of ours.
              <code className="block pl-5 font-mono text-xs text-fg-faint [overflow-wrap:anywhere]">{image.detail}</code>
            ) : null}
          </div>
        ) : null}
        {image.obsolete && list.base?.version ? (
          <p className="text-[13px] text-fg-muted">{t("courses.images.obsolete.hint", { current: list.base.version })}</p>
        ) : null}
      </div>
      {list.canManage ? (
        <Actions
          label={t("common.actions")}
          size="sm"
          menu
          items={[
            ...(running
              ? []
              : [
                  {
                    label: t("courses.images.refresh"),
                    icon: RefreshCw,
                    onSelect: () => writes.refresh.mutate(image.id, { onError: fail }),
                  },
                ]),
            { label: t("courses.images.rename"), icon: Pencil, onSelect: () => setRenaming(true) },
            { label: t("courses.images.remove"), icon: Trash2, danger: true, onSelect: () => void confirmRemove() },
          ]}
        />
      ) : null}
      {renaming ? (
        <TextFieldDialog
          title={t("courses.images.renameTitle")}
          label={t("courses.images.name")}
          initial={image.name}
          submitLabel={t("courses.images.rename")}
          valid={(name) => CourseWorkspaceImagePatch.safeParse({ name }).success}
          submitting={writes.rename.isPending}
          onSubmit={(name) =>
            writes.rename.mutate({ id: image.id, name }, { onSuccess: () => setRenaming(false), onError: fail })
          }
          onClose={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * What a Containerfile derives from: the base's repository at `latest`, the
 * last release, as the guide says (a version tag may be a candidate not
 * released yet, refused `not_on_base`).
 */
export const fromLine = (base: NonNullable<CourseWorkspaceImages["base"]>): string => `${base.reference.split("@")[0]}:latest`;

/**
 * Adding an image: a name and a reference, checked by the route's own
 * schema before it leaves (invariant 7). The portal resolves the reference
 * at once: a reference it cannot read is refused here, in words, its
 * diagnostic quoted; an accepted one appears in the list, downloading.
 */
function AddImageDialog({
  courseId,
  base,
  max,
  onClose,
}: {
  courseId: string;
  base: CourseWorkspaceImages["base"];
  /** The list's cap, for the words of `too_many_images`. */
  max: number;
  onClose: () => void;
}) {
  const t = useT();
  const toast = useToast();
  const { add } = useImageWrites(courseId);
  const [name, setName] = useState("");
  const [reference, setReference] = useState("");
  const body = CourseWorkspaceImageCreate.safeParse({ name, reference: reference.trim() });
  const detail = add.error ? refusalDetail(add.error) : null;

  const submit = () => {
    if (!body.success || add.isPending) return;
    add.mutate(body.data, {
      onSuccess: () => {
        toast(t("courses.images.added"), "success");
        onClose();
      },
    });
  };

  return (
    <FormDialog
      title={t("courses.images.addTitle")}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={t("courses.images.add")}
      submitting={add.isPending}
      canSubmit={body.success}
      error={
        add.error ? (
          <Alert tone="danger" icon={AlertTriangle}>
            <span className="block">{imageErrorText(add.error, t, max)}</span>
            {detail ? <code className="mt-1 block font-mono text-xs text-fg-muted [overflow-wrap:anywhere]">{detail}</code> : null}
          </Alert>
        ) : null
      }
    >
      <Field
        label={t("courses.images.name")}
        fullWidth
        autoFocus
        placeholder={t("courses.images.name.placeholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Field
        label={t("courses.images.reference")}
        fullWidth
        spellCheck={false}
        autoCapitalize="off"
        className="font-mono"
        placeholder="ghcr.io/my-org/my-image:latest"
        value={reference}
        onChange={(e) => setReference(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
        }}
        description={t("courses.images.reference.desc")}
      />
      {base ? (
        <div className="space-y-0.5 text-[13px] text-fg-muted">
          <p>{base.version ? t("courses.images.baseNow", { version: base.version }) : t("courses.images.baseNow.unknown")}</p>
          <code className="block font-mono text-xs [overflow-wrap:anywhere]">FROM {fromLine(base)}</code>
        </div>
      ) : null}
      <p className="flex items-start gap-1.5 text-[13px] text-fg-muted">
        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
        {t("courses.images.public")}
      </p>
    </FormDialog>
  );
}
