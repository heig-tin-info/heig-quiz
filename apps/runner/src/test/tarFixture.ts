/**
 * A tar writer with no rules, for the tests: it writes whatever header it is
 * asked to — a `..`, a symlink, a device, a ustar prefix, a PAX or GNU long
 * name — so the sanitizer can be shown each of them.
 */

export interface RawEntry {
  name: string;
  /** `0` by default. */
  type?: string;
  data?: string | Buffer;
  mode?: number;
  /** The ustar prefix field. */
  prefix?: string;
  linkname?: string;
  /** Written as a PAX `x` header before the entry. */
  paxPath?: string;
  /** Written as a GNU `L` header before the entry. */
  longName?: string;
  /** Spoils the checksum. */
  badChecksum?: boolean;
}

function octal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(entry: RawEntry, size: number): Buffer {
  const block = Buffer.alloc(512);
  Buffer.from(entry.name, "utf8").copy(block, 0, 0, 100);
  block.write(octal(entry.mode ?? 0o644, 8), 100, "latin1");
  block.write(octal(0, 8), 108, "latin1");
  block.write(octal(0, 8), 116, "latin1");
  block.write(octal(size, 12), 124, "latin1");
  block.write(octal(1_700_000_000, 12), 136, "latin1");
  block.write(entry.type ?? "0", 156, "latin1");
  if (entry.linkname !== undefined) block.write(entry.linkname, 157, "utf8");
  block.write("ustar\u000000", 257, "latin1");
  if (entry.prefix !== undefined) block.write(entry.prefix, 345, "utf8");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum + (entry.badChecksum ? 1 : 0), 7) + " ", 148, "latin1");
  return block;
}

function withData(entry: RawEntry): Buffer[] {
  const data = Buffer.from(entry.data ?? "");
  const pad = (512 - (data.length % 512)) % 512;
  return [header(entry, data.length), data, Buffer.alloc(pad)];
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let length = body.length + 1;
  while (Buffer.byteLength(body) + String(length).length !== length) {
    length = Buffer.byteLength(body) + String(length).length;
  }
  return `${length}${body}`;
}

export function rawTar(entries: readonly RawEntry[], { end = true } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    if (entry.paxPath !== undefined) {
      parts.push(...withData({ name: "PaxHeader", type: "x", data: paxRecord("path", entry.paxPath) }));
    }
    if (entry.longName !== undefined) {
      parts.push(...withData({ name: "././@LongLink", type: "L", data: `${entry.longName}\0` }));
    }
    parts.push(...withData(entry));
  }
  if (end) parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
