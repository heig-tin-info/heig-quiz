/**
 * The two bytes-in-memory formats a Runno runtime ships: gzip and tar.
 *
 * A language runtime is a `.wasm` binary plus a `.tar.gz` holding the files it
 * expects to find on disk — clang's sysroot, Python's standard library. The
 * browser already knows how to gunzip (`DecompressionStream`), so the only
 * thing missing is a tar reader, and it is forty lines. Pulling a tar package
 * into the student's bundle for that would be worse than writing it.
 *
 * `@runno/runtime` does the same job with `pako` + `tarts`; this module exists
 * so nothing from that package (CodeMirror web components, fetches to
 * runno.dev) enters the bundle — see `apps/web/src/runner/README` in
 * `index.ts`'s header and ADR-015.
 */

/** One entry of the archive: an absolute path, and the bytes. */
export type ArchiveFiles = Record<string, Uint8Array>;

const BLOCK = 512;

/** Decompresses a gzip stream. Anything that is not gzipped is returned as is. */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const ASCII = new TextDecoder("utf-8");

function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return ASCII.decode(end === -1 ? slice : slice.subarray(0, end)).trim();
}

/** tar sizes are octal, padded with spaces or NULs; an empty field is zero. */
function octal(block: Uint8Array, offset: number, length: number): number {
  const text = field(block, offset, length).replace(/[^0-7]/g, "");
  return text === "" ? 0 : parseInt(text, 8);
}

/**
 * Reads a (ustar or GNU) tar archive.
 *
 * Only regular files are kept: a WASI filesystem is a flat map of paths, so a
 * directory entry has nothing to carry. Paths are made absolute, exactly as
 * `@runno/runtime` does, because that is what the runtimes' own arguments
 * assume (`-isysroot /sys`).
 */
export function untar(bytes: Uint8Array): ArchiveFiles {
  const files: ArchiveFiles = {};
  let offset = 0;
  /** A GNU `L` entry names the FOLLOWING entry, whose own name field is short. */
  let longName: string | null = null;

  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break; // the two empty blocks that end an archive
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
    const body = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
    longName = null;

    if (type === "L") {
      longName = ASCII.decode(body).replace(/\0+$/, "");
    } else if (type === "0" || type === "\0" || type === "7") {
      const path = name.startsWith("/") ? name : `/${name}`;
      // A copy, not a view: the whole archive would stay alive behind it.
      files[path] = body.slice();
    }
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return files;
}

export async function extractTarGz(bytes: Uint8Array): Promise<ArchiveFiles> {
  return untar(await gunzip(bytes));
}
