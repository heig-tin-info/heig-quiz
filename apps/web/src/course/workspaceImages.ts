/**
 * A course's workspace images (ADR-146 §4–§8): the reads and writes of the
 * course's Images tab, and how a refusal of the image routes is worded.
 * Every body is a schema of `@quiz/contracts` (invariant 7); every code of
 * `WORKSPACE_IMAGE_ERRORS` has its sentence, and the portal's `detail` is
 * never shown as prose.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ADMISSION_IN_FLIGHT,
  CourseWorkspaceImageCreate,
  CourseWorkspaceImagePatch,
  courseWorkspaceImagePath,
  courseWorkspaceImagesPath,
  ImageInUse,
  ImageRefusalDetail,
  type AdmissionState,
  type CourseWorkspaceImage,
  type CourseWorkspaceImages,
  type ImageRefusal,
  type WorkspaceImageError,
} from "@quiz/contracts";

import { api, ApiError, isNotFound, refusalCodeOf, wordedRefusal } from "../api";
import type { Dict, TFunction } from "../i18n";
import { courseWorkspaceImagesKey } from "../queryKeys";

/** How often a list with an admission in flight is read again: the API follows the portal every 5 s. */
export const IMAGES_POLL_MS = 5_000;

/** Whether an admission is still running (neither ready nor refused). */
export const inFlight = (state: AdmissionState): boolean => (ADMISSION_IN_FLIGHT as readonly AdmissionState[]).includes(state);

/**
 * `GET /courses/:id/workspace-images`, every staff member's: read again
 * every few seconds while an admission is in flight, until each is ready or
 * refused. A 404 is the feature off (no online workspace, or a portal that
 * serves no image).
 */
export function useCourseWorkspaceImages(courseId: string | null | undefined) {
  return useQuery<CourseWorkspaceImages>({
    queryKey: courseWorkspaceImagesKey(courseId ?? ""),
    queryFn: () => api(courseWorkspaceImagesPath(courseId!)),
    enabled: !!courseId,
    refetchInterval: (query) => (query.state.data?.images.some((image) => inFlight(image.state)) ? IMAGES_POLL_MS : false),
  });
}

/** The tab's writes: add, rename, Refresh and remove; each settles by reading the list again. */
export function useImageWrites(courseId: string) {
  const qc = useQueryClient();
  const settle = () => qc.invalidateQueries({ queryKey: courseWorkspaceImagesKey(courseId) });
  return {
    add: useMutation({
      mutationFn: (body: CourseWorkspaceImageCreate) =>
        api<CourseWorkspaceImage>(courseWorkspaceImagesPath(courseId), {
          method: "POST",
          body: JSON.stringify(CourseWorkspaceImageCreate.parse(body)),
        }),
      onSettled: settle,
    }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        api<CourseWorkspaceImage>(courseWorkspaceImagePath(courseId, id), {
          method: "PATCH",
          body: JSON.stringify(CourseWorkspaceImagePatch.parse({ name })),
        }),
      onSettled: settle,
    }),
    refresh: useMutation({
      mutationFn: (id: string) => api<CourseWorkspaceImage>(`${courseWorkspaceImagePath(courseId, id)}/refresh`, { method: "POST" }),
      onSettled: settle,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api(courseWorkspaceImagePath(courseId, id), { method: "DELETE" }),
      onSettled: settle,
    }),
  };
}

/** Why the portal refused an image, in words (the reason, never its `detail`). */
export const reasonKey = (reason: ImageRefusal) => `courses.images.reason.${reason}` as const satisfies keyof Dict;

/**
 * Every refusal code of the image routes, worded; the three the portal
 * shares with an admission's refusal (`not_found`, `not_public`, `config`,
 * all 422) read as its reasons. `too_many_images` is worded with the list's
 * cap by {@link imageErrorText}.
 */
const ERROR_KEYS: Record<WorkspaceImageError, keyof Dict> = {
  codespace_not_granted: "courses.images.error.codespace_not_granted",
  too_many_images: "courses.images.full",
  name_taken: "courses.images.error.name_taken",
  image_in_use: "courses.images.error.image_in_use",
  image_not_ready: "courses.images.error.image_not_ready",
  not_found: reasonKey("not_found"),
  not_public: reasonKey("not_public"),
  config: reasonKey("config"),
  registry_unavailable: "courses.images.error.registry_unavailable",
  images_unavailable: "error.notFound",
  portal_unavailable: "courses.images.error.portal_unavailable",
};

/**
 * A refused write of the image routes, in the screen's words. A 404 is an
 * entity gone meanwhile (or the feature off), whatever its code: the
 * registry's `not_found` is a 422. `max` is the list's cap.
 */
export function imageErrorText(error: unknown, t: TFunction, max: number): string {
  if (isNotFound(error)) return t("error.notFound");
  return wordedRefusal(error, ERROR_KEYS, (key) => t(key, { max }));
}

/** The portal's diagnostic of a refused reference (`detail`), quoted as it is; null when there is none. */
export function refusalDetail(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const parsed = ImageRefusalDetail.safeParse(error.body);
  return parsed.success ? parsed.data.detail : null;
}

/** The projects that still pick an image, from `409 image_in_use`; null for any other error. */
export function projectsInUse(error: unknown): ImageInUse["projects"] | null {
  if (refusalCodeOf(error) !== "image_in_use" || !(error instanceof ApiError)) return null;
  const parsed = ImageInUse.safeParse(error.body);
  return parsed.success ? parsed.data.projects : null;
}
