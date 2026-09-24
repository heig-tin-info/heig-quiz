/**
 * The compiler's complaints, read back as positions in the student's file.
 *
 * The runner hands the player a compile `stderr` as one blob of text. The
 * locked editor (`./LockedEditor.tsx`) shows the program with its REAL source
 * line numbers — the ones of the file the server rebuilds from the template
 * (invariant 14) — so a `main.c:12:5: error:` line can be drawn as a squiggle
 * on line 12 of what the student sees. This file is the pure reading of that
 * blob; nothing here decides whether the program compiled.
 *
 * Three shapes are recognised, which cover the MVP languages:
 *   - gcc / clang / node: `file:line:col: error|warning|fatal error: message`
 *     (node prints `file:line` without a column on its first line; that line
 *     alone carries no message, so it is not read);
 *   - rustc: `error[E0425]: message` then ` --> file:line:col`;
 *   - a Python traceback: the LAST `File "file", line N` of the main file,
 *     with the traceback's last line (`SyntaxError: …`) as the message.
 *
 * Only lines about the main file are kept: a note inside `<stdio.h>` has no
 * line in the student's editor to land on. The file is matched by its base
 * name, since the runners disagree about the directory (`main.c`,
 * `/work/main.c`, `./main.c`).
 */

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  /** 1-based line in the assembled source. */
  line: number;
  /** 1-based column, when the compiler gave one. */
  column: number | null;
  severity: DiagnosticSeverity;
  message: string;
}

const baseName = (path: string): string => path.replace(/^.*[\\/]/, "");

/** `main.c:12:5: error: expected ';'` — gcc, clang, and anything that copies them. */
const GCC_LINE = /^(.+?):(\d+):(?:(\d+):)?\s*(fatal error|error|warning):\s*(.*)$/;

/** rustc's header line, whose position follows on a ` --> ` line. */
const RUST_HEAD = /^(error|warning)(?:\[[A-Z]\d+\])?:\s*(.*)$/;
const RUST_ARROW = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;

/** One frame of a Python traceback. */
const PY_FRAME = /^\s*File "(.+?)", line (\d+)/;

/**
 * The diagnostics of `stderr` that point into `file` (a base name such as
 * `main.c`), in the order the compiler printed them.
 */
export function parseDiagnostics(stderr: string, file: string): Diagnostic[] {
  const lines = stderr.split(/\r?\n/);
  const found: Diagnostic[] = [];

  let rustHead: { severity: DiagnosticSeverity; message: string } | null = null;
  for (const text of lines) {
    const gcc = GCC_LINE.exec(text);
    if (gcc !== null) {
      rustHead = null;
      if (baseName(gcc[1]!) !== file) continue;
      found.push({
        line: Number(gcc[2]),
        column: gcc[3] === undefined ? null : Number(gcc[3]),
        severity: gcc[4] === "warning" ? "warning" : "error",
        message: gcc[5]!.trim(),
      });
      continue;
    }
    const head = RUST_HEAD.exec(text);
    if (head !== null) {
      rustHead = { severity: head[1] === "warning" ? "warning" : "error", message: head[2]!.trim() };
      continue;
    }
    const arrow = RUST_ARROW.exec(text);
    if (arrow !== null && rustHead !== null) {
      if (baseName(arrow[1]!) === file) {
        found.push({
          line: Number(arrow[2]),
          column: Number(arrow[3]),
          severity: rustHead.severity,
          message: rustHead.message,
        });
      }
      rustHead = null;
    }
  }
  if (found.length > 0) return found;

  // A Python traceback: the innermost frame in the main file is where the
  // student's code went wrong; the last line says what went wrong.
  let pyLine: number | null = null;
  for (const text of lines) {
    const frame = PY_FRAME.exec(text);
    if (frame !== null && baseName(frame[1]!) === file) pyLine = Number(frame[2]);
  }
  if (pyLine === null) return [];
  const message = [...lines].reverse().find((text) => text.trim() !== "")?.trim() ?? "";
  return [{ line: pyLine, column: null, severity: "error", message }];
}
