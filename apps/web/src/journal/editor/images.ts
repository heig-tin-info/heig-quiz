/*
 * The journal's pictures (F-JRN-11, D25 condition 3): a picture dropped,
 * pasted or picked into a page is written into the REPOSITORY, beside the
 * page, and inserted with a RELATIVE path — never as a platform asset
 * (`asset:<id>`) — so that the page renders the same on GitHub.
 *
 * Where: an `images/` folder next to the page (`semaine-01/index.md` puts
 * its pictures in `semaine-01/images/`). One folder per page's folder, not
 * per page: two pages of a week share their figures, and the folder name is
 * what a teacher already writes by hand in a repository.
 *
 * Its name: the file's own, reduced to `[a-z0-9-]`, with six random hex
 * characters before the extension. The suffix is what lets two teachers
 * drop two `capture.png` without one overwriting the other: the write route
 * refuses a path GitHub has and the copy does not (a conflict, never an
 * overwrite), and a name nobody chose twice never meets that refusal.
 *
 * Its extension comes from the file's TYPE, not its name: the route checks
 * that the declared content type is the extension's (`assetContentType`),
 * and a `photo.JPG` of type `image/jpeg` goes in as `.jpg`.
 */
import { encodeJournalPath, JOURNAL_ASSETS_PATH, safeJournalPath } from "@quiz/contracts";
import { resolveRelative } from "@quiz/docrender/journalTree";

/** The picture types the journal serves, and the extension each is written with. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** The folder a page's pictures go into, relative to the page. */
export const IMAGES_FOLDER = "images";

/** Six random hex characters. */
export function randomSuffix(): string {
  const bytes = new Uint8Array(3);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A file name reduced to what every file system and every URL take as is. */
function slug(name: string): string {
  const base = name
    .replace(/\.[^.]*$/, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return base || "image";
}

/**
 * Where a picture dropped into the page at `pagePath` is written: `path`,
 * the journal path the upload goes to, and `href`, the relative path the
 * page refers to it by. Null for a type the journal does not serve.
 */
export function imagePlacement(
  pagePath: string,
  file: { name: string; type: string },
  suffix: string,
): { path: string; href: string } | null {
  const extension = EXTENSIONS[file.type];
  if (!extension) return null;
  const href = `${IMAGES_FOLDER}/${slug(file.name)}-${suffix}.${extension}`;
  const folder = pagePath.includes("/") ? pagePath.slice(0, pagePath.lastIndexOf("/") + 1) : "";
  const path = `${folder}${href}`;
  return safeJournalPath(path) === null ? null : { path, href };
}

/**
 * Where the editor draws a picture of the page at `pagePath` from: one
 * uploaded in this session from the browser's own copy (`local`, by the
 * `src` written into the page: the journal's copy serves only what a saved
 * page references), any other relative path from the journal's asset route,
 * and anything else (an external URL) left to the editor's own rule.
 */
export function journalImageUrl(
  classroomId: string,
  pagePath: string,
  local: ReadonlyMap<string, string>,
): (src: string) => string | null {
  return (src) => {
    const uploaded = local.get(src);
    if (uploaded !== undefined) return uploaded;
    let decoded = src;
    try {
      decoded = decodeURI(src);
    } catch {
      // A malformed escape is a name like any other.
    }
    const path = resolveRelative(pagePath, decoded.replace(/[?#].*$/, ""));
    return path === null ? null : `${JOURNAL_ASSETS_PATH(classroomId)}/${encodeJournalPath(path)}`;
  };
}
