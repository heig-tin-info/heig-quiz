/**
 * The debugged program's own terminal (#1103), the part that needs no `vscode`.
 *
 * webfreak.debug 0.27.0 starts gdb with its stdin and stdout on pipes
 * (`out/src/backend/mi2/mi2.js`, `load`), and the program gdb runs inherits
 * them: its output is block-buffered by the C library and lands in gdb's MI
 * stream, its stdin IS gdb's command stream (a `scanf("%d")` reads the token
 * of the next MI command). The extension's own way out, `terminal`, spawns an
 * `x-terminal-emulator` (`out/src/backend/linux/console.js`), which does not
 * exist in a browser.
 *
 * So the image gives every gdb launch an integrated terminal of its own and
 * prepends `set inferior-tty <that terminal>` to the configuration's
 * `autorun`, which the extension sends before the program starts: the program
 * reads and writes a real terminal the student sees and types into.
 *
 * Required by `extension.js` and by `images/c-dev/test.sh` § 11, which drives
 * the real debug adapter with what `programTerminalConfig` returns.
 */
"use strict";

/** The only shape a tty name may have before it reaches a gdb command. */
const TTY_RE = /^\/dev\/pts\/[0-9]{1,6}$/;

/** A configuration that already chooses the program's terminal itself. */
const CHOOSES_TTY_RE = /^\s*(set\s+inferior-tty|tty)\b/;

/**
 * Whether a resolved debug configuration starts a local program under
 * webfreak.debug's gdb, and leaves its terminal to us.
 */
function wantsProgramTerminal(config) {
  if (!config || config.type !== "gdb" || config.request !== "launch") return false;
  if (config.ssh) return false;
  const autorun = Array.isArray(config.autorun) ? config.autorun : [];
  return !autorun.some((command) => typeof command === "string" && CHOOSES_TTY_RE.test(command));
}

/**
 * The configuration to launch: the same one, with `set inferior-tty <tty>`
 * first in `autorun` and no `terminal` (an external terminal emulator cannot
 * exist in a browser; the extension would wait five seconds for it and fail).
 * Unchanged when it is not ours to change or the tty name is not a pts.
 */
function programTerminalConfig(config, tty) {
  if (!wantsProgramTerminal(config) || !TTY_RE.test(String(tty))) return config;
  const { terminal: _external, ...rest } = config;
  const autorun = Array.isArray(config.autorun) ? config.autorun : [];
  return { ...rest, autorun: [`set inferior-tty ${tty}`, ...autorun] };
}

/**
 * What the terminal's process runs, as the session leader the pty host makes
 * it: give the tty up as its controlling terminal (TIOCNOTTY, SIGHUP
 * ignored), so that gdb can make it the debugged program's own (TIOCSCTTY;
 * otherwise "warning: GDB: Failed to set controlling terminal" on every run,
 * and Ctrl+C would kill this process instead of interrupting the program);
 * write the tty name to the file given; then wait, never reading, so the
 * debugged program alone reads what the student types. `-I`: no module is
 * ever looked up in the student's directory.
 */
const HOLDER_PY = [
  "import fcntl, os, signal, sys, termios",
  "signal.signal(signal.SIGHUP, signal.SIG_IGN)",
  "fcntl.ioctl(0, termios.TIOCNOTTY)",
  "part = sys.argv[1] + '.part'",
  "with open(part, 'w') as f: f.write(os.ttyname(0) + '\\n')",
  "os.rename(part, sys.argv[1])",
  "while True: signal.pause()",
].join("\n");

/**
 * The terminal's command line (`/bin/sh` and these arguments). `stty sane`
 * first undoes what a previous program may have left in raw mode.
 */
function holderArgs(ttyFile) {
  return ["-c", 'stty sane 2>/dev/null; exec python3 -I -c "$2" "$1"', "sh", ttyFile, HOLDER_PY];
}

/**
 * `create` behind a gate: callers that arrive while it runs share its pending
 * promise instead of starting another. Two launches at once (a compound
 * configuration) would otherwise each open a terminal, the second disposing
 * the first's while its program is about to run on it.
 */
function sharedPending(create) {
  let pending;
  return () => {
    pending ??= Promise.resolve()
      .then(create)
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

module.exports = { TTY_RE, wantsProgramTerminal, programTerminalConfig, holderArgs, sharedPending };
