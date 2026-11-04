import { ApiError } from "./api";

/** The file name of an attachment, as the server wrote it (`attachment; filename="…"`). */
function attachmentName(disposition: string | null, fallback: string): string {
  return /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? fallback;
}

/**
 * A file the server builds on demand (an export, ADR-121), fetched rather
 * than followed as a link: a refusal (`503 pdf_busy`, `pdf_unavailable`)
 * throws an {@link ApiError} the screen words, and is never saved as the
 * file nor leaves the page. `name` is the server's own file name.
 */
export async function fetchFile(path: string): Promise<{ blob: Blob; name: string }> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return {
    blob: await res.blob(),
    name: attachmentName(res.headers.get("content-disposition"), path.split("/").pop() ?? "download"),
  };
}

/** Fetches a file ({@link fetchFile}) and hands it to the browser's downloads. */
export async function downloadFile(path: string): Promise<void> {
  const { blob, name } = await fetchFile(path);
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
