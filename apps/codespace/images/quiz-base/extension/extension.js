/**
 * heig.codespace-statusbar — status bar of the heig-codespace portal.
 *
 * Three items at the right of the status bar:
 *   1. the time left until the assignment deadline, refreshed every 30 s;
 *   2. a « Fermer » button that opens the return URL (classroom or portal),
 *      or, in a Safe Exam Browser session (since 0.4.0), the hint
 *      « Quitter : Ctrl+Q » in its place: SEB's own quit, since the button's
 *      new tab has no platform session inside SEB and quits nothing;
 *   3. a warning when GitHub refused the student's last push (ADR-078 §6):
 *      the relay never forces, so a push behind a commit of the platform's
 *      App is not relayed until the student pulls.
 *
 * Items 1 and 2 come from the container environment, set by the portal's
 * `podman run` (`src/engine/index.ts`):
 *   CODESPACE_DEADLINE         ISO 8601 deadline  (optional: without it, no countdown)
 *   CODESPACE_RETURN_URL       return URL         (optional: without it, no button)
 *   CODESPACE_ASSIGNMENT_NAME  assignment title   (optional, shown in the tooltip)
 *   CODESPACE_SEB              "1" in a SEB session (then no return URL: the quit hint)
 *
 * The code-server extension host inherits the server's environment:
 * `ExtensionHostConnection#buildUserEnvironment` builds `{...process.env, ...}`
 * (checked in the bundled package, see ../README.md).
 *
 * Beside the status bar, every gdb launch gets the debugged program's own
 * terminal (#1103, ./debugIo.js): webfreak.debug otherwise leaves the
 * program's stdin and stdout on gdb's pipes, where the student can neither
 * see what it prints nor type what it reads.
 *
 * Item 3 reads `GET <origin>/push-status` on the portal's git channel, the
 * `origin` remote the portal wrote in the workspace
 * (`http://portal.internal:9418/git/<session>`): the one surface the
 * container already reaches, authenticated by its address. No other
 * network access, no telemetry, no dependency, no credential (invariants 1
 * and 2).
 *
 * Since 0.3.0, a fourth item, "Update from your teacher" (ADR-132 §11): the same
 * answer names the commit a teacher's sync handed out for the session's
 * branch, with the teacher's message; while that commit is not in the
 * student's history, the item offers to merge it, locally and as the
 * student (./update.js holds every decision; this file only shows them).
 */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");
const { holderArgs, programTerminalConfig, sharedPending, TTY_RE, wantsProgramTerminal } = require("./debugIo");
const { applyUpdate, gitRunner, isTaken, parseUpdate, plainText } = require("./update");

/** Refresh period of the countdown. */
const TICK_MS = 30_000;
/** Below this remaining time, the item switches to the warning colour. */
const WARN_MS = 10 * 60 * 1000;
/**
 * Witness file written at activation. It only serves to check, from the host,
 * that the extension host really received the container environment
 * (images/quiz-base/test.sh, and a manual check after the editor is opened). It
 * contains no secret: only the four variables.
 */
const WITNESS = path.join(os.tmpdir(), "codespace-statusbar.json");
/** How long the program's terminal may take to report its tty name. */
const TTY_WAIT_MS = 5_000;

const STRINGS = {
  fr: {
    // The `Intl` tag of dates.
    tag: "fr-CH",
    overdue: "Échéance dépassée",
    lessThanAMinute: "moins d'une minute restante",
    close: "Fermer",
    closeTooltip: "Quitter l'éditeur et revenir au portail",
    deadlineLine: (date) => `Échéance : ${date}`,
    assignmentLine: (name) => `Devoir : ${name}`,
    noReturnUrl: "Aucune URL de retour n'a été transmise à cette session.",
    // The wording of Quiz's own hint (apps/web, `seb.quit` and `seb.quit.keys`).
    sebQuit: "Quitter : Ctrl+Q",
    sebQuitTooltip:
      "Quitter Safe Exam Browser. Raccourci : Ctrl+Q (Windows) ou ⌘Q (Mac), qui peut demander un mot de passe. " +
      "Vos fichiers sont enregistrés automatiquement.",
    pushRejected: "Push refusé par GitHub",
    pushRejectedTooltip: (branch, reason) =>
      `Votre dernier push sur ${branch} n'a pas été transmis à GitHub (${reason}). ` +
      "Votre commit est toujours dans votre espace : faites un pull, corrigez si nécessaire, puis poussez à nouveau.",
    programTerminal: "Programme",
    programTerminalFailed:
      "Le terminal du programme n'a pas démarré : ce que le programme affiche et lit passe par la console de débogage.",
    update: "Mise à jour de l'équipe enseignante",
    updateTooltip: (at) => `L'équipe enseignante a mis à jour le projet${at ? `, ${at}` : ""}. Cliquez pour appliquer la mise à jour.`,
    updateMessage: "Message de l'équipe enseignante :",
    updateConfirm:
      "Appliquer la mise à jour de l'équipe enseignante ? Elle est fusionnée dans votre branche par un commit de fusion ; poussez ensuite comme d'habitude.",
    apply: "Appliquer",
    updateApplied: "Mise à jour appliquée. Poussez pour l'envoyer avec votre travail.",
    updateUnavailable: "La mise à jour n'a pas pu être récupérée. Réessayez dans un moment.",
    updateOtherBranch: (branch) => `Passez sur la branche ${branch} pour appliquer la mise à jour.`,
    updateBusy: "Une fusion, un rebase ou un cherry-pick est en cours : terminez-le ou annulez-le, puis réessayez.",
    updateDirty: (files) =>
      `Rien n'a été modifié : vos changements non commités dans ${files} seraient écrasés. Commitez votre travail, puis réessayez.`,
    updateConflict: (files) =>
      `Rien n'a été modifié : la mise à jour entre en conflit avec votre travail dans ${files}. Demandez à l'équipe enseignante, ou fusionnez à la main avec git.`,
    updateFailed: (detail) => `Rien n'a été modifié : git a refusé la fusion (${detail}).`,
    remaining: (h, m) =>
      h > 0
        ? `${h} h ${m} min restantes`
        : m > 1
          ? `${m} min restantes`
          : `${m} min restante`,
  },
  en: {
    tag: "en-GB",
    overdue: "Deadline passed",
    lessThanAMinute: "less than a minute left",
    close: "Close",
    closeTooltip: "Leave the editor and go back to the portal",
    deadlineLine: (date) => `Deadline : ${date}`,
    assignmentLine: (name) => `Assignment : ${name}`,
    noReturnUrl: "No return URL was given to this session.",
    sebQuit: "Quit: Ctrl+Q",
    sebQuitTooltip:
      "Quit Safe Exam Browser. Shortcut: Ctrl+Q (Windows) or ⌘Q (Mac), which may ask for a password. " +
      "Your files are saved automatically.",
    pushRejected: "Push refused by GitHub",
    pushRejectedTooltip: (branch, reason) =>
      `Your last push of ${branch} was not relayed to GitHub (${reason}). ` +
      "Your commit is still in your workspace: pull, fix if needed, then push again.",
    programTerminal: "Program",
    programTerminalFailed:
      "The program's terminal did not start: what the program prints and reads goes through the debug console.",
    update: "Update from your teacher",
    updateTooltip: (at) => `Your teacher updated the project${at ? `, ${at}` : ""}. Click to apply it.`,
    updateMessage: "Your teacher's message:",
    updateConfirm:
      "Apply your teacher's update? It is merged into your branch with a merge commit; then push as usual.",
    apply: "Apply",
    updateApplied: "Update applied. Push to send it with your work.",
    updateUnavailable: "The update could not be fetched. Try again in a moment.",
    updateOtherBranch: (branch) => `Switch to the ${branch} branch to apply the update.`,
    updateBusy: "A merge, rebase or cherry-pick is in progress: finish or abort it, then try again.",
    updateDirty: (files) =>
      `Nothing was changed: your uncommitted changes to ${files} would be overwritten. Commit your work, then try again.`,
    updateConflict: (files) =>
      `Nothing was changed: the update conflicts with your work in ${files}. Ask your teacher, or merge it by hand with git.`,
    updateFailed: (detail) => `Nothing was changed: git refused the merge (${detail}).`,
    remaining: (h, m) => (h > 0 ? `${h} h ${m} min left` : `${m} min left`),
  },
  de: {
    tag: "de-CH",
    overdue: "Frist abgelaufen",
    lessThanAMinute: "weniger als eine Minute übrig",
    close: "Schliessen",
    closeTooltip: "Editor verlassen und zum Portal zurückkehren",
    deadlineLine: (date) => `Frist: ${date}`,
    assignmentLine: (name) => `Aktivität: ${name}`,
    noReturnUrl: "Dieser Sitzung wurde keine Rückkehr-URL übergeben.",
    sebQuit: "Beenden: Ctrl+Q",
    sebQuitTooltip:
      "Safe Exam Browser beenden. Tastenkürzel: Ctrl+Q (Windows) oder ⌘Q (Mac), eventuell mit Passwortabfrage. " +
      "Ihre Dateien werden automatisch gespeichert.",
    pushRejected: "Push von GitHub abgelehnt",
    pushRejectedTooltip: (branch, reason) =>
      `Ihr letzter Push von ${branch} wurde nicht an GitHub weitergeleitet (${reason}). ` +
      "Ihr Commit ist weiterhin in Ihrem Arbeitsbereich: Machen Sie einen Pull, korrigieren Sie bei Bedarf und pushen Sie erneut.",
    programTerminal: "Programm",
    programTerminalFailed:
      "Das Terminal des Programms ist nicht gestartet: Was das Programm ausgibt und einliest, läuft über die Debug-Konsole.",
    update: "Aktualisierung des Lehrteams",
    updateTooltip: (at) => `Das Lehrteam hat das Projekt aktualisiert${at ? `, ${at}` : ""}. Klicken Sie, um die Aktualisierung anzuwenden.`,
    updateMessage: "Nachricht des Lehrteams:",
    updateConfirm:
      "Die Aktualisierung des Lehrteams anwenden? Sie wird mit einem Merge-Commit in Ihren Branch übernommen. Pushen Sie danach wie gewohnt.",
    apply: "Anwenden",
    updateApplied: "Aktualisierung angewendet. Pushen Sie, um sie mit Ihrer Arbeit zu senden.",
    updateUnavailable: "Die Aktualisierung konnte nicht abgerufen werden. Versuchen Sie es gleich noch einmal.",
    updateOtherBranch: (branch) => `Wechseln Sie auf den Branch ${branch}, um die Aktualisierung anzuwenden.`,
    updateBusy:
      "Ein Merge, Rebase oder Cherry-Pick läuft: Schliessen Sie ihn ab oder brechen Sie ihn ab. Versuchen Sie es dann erneut.",
    updateDirty: (files) =>
      `Nichts wurde geändert: Ihre nicht committeten Änderungen an ${files} würden überschrieben. Committen Sie Ihre Arbeit und versuchen Sie es dann erneut.`,
    updateConflict: (files) =>
      `Nichts wurde geändert: Die Aktualisierung steht in Konflikt mit Ihrer Arbeit in ${files}. Wenden Sie sich an das Lehrteam oder führen Sie den Merge von Hand mit git durch.`,
    updateFailed: (detail) => `Nichts wurde geändert: git hat den Merge abgelehnt (${detail}).`,
    remaining: (h, m) => (h > 0 ? `noch ${h} h ${m} min` : `noch ${m} min`),
  },
  it: {
    tag: "it-CH",
    overdue: "Scadenza superata",
    lessThanAMinute: "meno di un minuto rimanente",
    close: "Chiudi",
    closeTooltip: "Lasciare l'editor e tornare al portale",
    deadlineLine: (date) => `Scadenza: ${date}`,
    assignmentLine: (name) => `Attività: ${name}`,
    noReturnUrl: "A questa sessione non è stato passato alcun URL di ritorno.",
    sebQuit: "Chiudi: Ctrl+Q",
    sebQuitTooltip:
      "Uscire da Safe Exam Browser. Scorciatoia: Ctrl+Q (Windows) o ⌘Q (Mac), che può chiedere una password. " +
      "I suoi file vengono salvati automaticamente.",
    pushRejected: "Push rifiutato da GitHub",
    pushRejectedTooltip: (branch, reason) =>
      `Il suo ultimo push sul branch ${branch} non è stato inoltrato a GitHub (${reason}). ` +
      "Il suo commit è ancora nel suo spazio di lavoro: fare pull, sistemare se necessario, poi fare di nuovo push.",
    programTerminal: "Programma",
    programTerminalFailed:
      "Il terminale del programma non si è avviato: ciò che il programma stampa e legge passa dalla console di debug.",
    update: "Aggiornamento del team docente",
    updateTooltip: (at) => `Il team docente ha aggiornato il progetto${at ? `, ${at}` : ""}. Fare clic per applicare l'aggiornamento.`,
    updateMessage: "Messaggio del team docente:",
    updateConfirm:
      "Applicare l'aggiornamento del team docente? Viene integrato nel suo branch con un merge commit. Poi fare push come al solito.",
    apply: "Applica",
    updateApplied: "Aggiornamento applicato. Fare push per inviarlo con il suo lavoro.",
    updateUnavailable: "Non è stato possibile recuperare l'aggiornamento. Riprovare tra un momento.",
    updateOtherBranch: (branch) => `Passare al branch ${branch} per applicare l'aggiornamento.`,
    updateBusy: "Un merge, un rebase o un cherry-pick è in corso: completarlo o annullarlo, poi riprovare.",
    updateDirty: (files) =>
      `Non è stato modificato nulla: le sue modifiche non committate in ${files} verrebbero sovrascritte. Fare commit del proprio lavoro, poi riprovare.`,
    updateConflict: (files) =>
      `Non è stato modificato nulla: l'aggiornamento è in conflitto con il suo lavoro in ${files}. Rivolgersi al team docente, o fare il merge a mano con git.`,
    updateFailed: (detail) => `Non è stato modificato nulla: git ha rifiutato il merge (${detail}).`,
    remaining: (h, m) =>
      h > 0
        ? `${h} h ${m} min rimanenti`
        : m > 1
          ? `${m} min rimanenti`
          : `${m} min rimanente`,
  },
};

/**
 * The strings of the interface language's base ("fr", "de", "it"), English
 * for any other, and English for a key a language's table lacks (ADR-140
 * §4, §5). French, German and Italian are not reached today: the image
 * ships no language pack, so `vscode.env.language` is "en" whatever the
 * browser's language. Kept because a pack could be added without touching
 * this extension: install Open VSX's `MS-CEINTL.vscode-language-pack-fr`
 * (or `-de`, `-it`) beside the other extensions and start code-server with
 * `--locale fr` (entrypoint.sh) — not tried.
 */
function pickStrings(language) {
  const base = String(language || "en").toLowerCase().split("-")[0];
  return { ...STRINGS.en, ...(Object.hasOwn(STRINGS, base) ? STRINGS[base] : {}) };
}

/** Countdown text for a remaining time in milliseconds. */
function formatRemaining(remainingMs, t) {
  if (remainingMs <= 0) return t.overdue;
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return t.lessThanAMinute;
  return t.remaining(Math.floor(totalMinutes / 60), totalMinutes % 60);
}

/** Local date and time of the container (TZ=Europe/Zurich in the image). */
function formatDeadline(deadline, t) {
  try {
    return deadline.toLocaleString(t.tag, {
      dateStyle: "full",
      timeStyle: "short",
    });
  } catch {
    return deadline.toISOString();
  }
}

/** `undefined` rather than an empty string: an empty variable means absent. */
function readEnv(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The portal's git channel of this session, from the workspace's `origin` remote; undefined without one. */
function portalRemote() {
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (!folder) return undefined;
  try {
    const config = fs.readFileSync(path.join(folder.uri.fsPath, ".git", "config"), "utf8");
    const m = /^\s*url\s*=\s*(http:\/\/portal\.internal:\d+\/git\/[A-Za-z0-9._-]+)\/?\s*$/m.exec(config);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/** `GET <remote>/push-status`: `{ rejected: { ref, at, reason } | null }`, or null when it cannot be read. */
function readPushStatus(remote) {
  return new Promise((resolve) => {
    const req = http.get(`${remote}/push-status`, { timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        if (body.length < 16_384) body += chunk;
      });
      res.on("end", () => {
        try {
          resolve(res.statusCode === 200 ? JSON.parse(body) : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

function writeWitness(payload) {
  try {
    fs.writeFileSync(WITNESS, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  } catch {
    // The witness is a testing convenience, never a condition of operation.
  }
}

/** The tty name the terminal's process wrote to `file`, or undefined after `timeoutMs`. */
async function waitForTty(file, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const name = fs.readFileSync(file, "utf8").trim();
      if (TTY_RE.test(name)) return name;
    } catch {
      // Not written yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return undefined;
}

/**
 * One "Program" terminal per window, reused by every gdb launch while it
 * lives, created again once the student closes it (#1103, ./debugIo.js).
 */
function registerProgramTerminal(context, t) {
  const ttyFile = path.join(os.tmpdir(), `codespace-program-tty-${process.pid}`);
  let terminal;
  let tty;

  // One at a time: concurrent launches share the terminal being opened.
  const ensure = sharedPending(async () => {
    if (terminal && terminal.exitStatus === undefined && tty) return tty;
    if (terminal) terminal.dispose();
    fs.rmSync(ttyFile, { force: true });
    terminal = vscode.window.createTerminal({
      name: t.programTerminal,
      shellPath: "/bin/sh",
      shellArgs: holderArgs(ttyFile),
      iconPath: new vscode.ThemeIcon("debug-console"),
      isTransient: true,
    });
    tty = await waitForTty(ttyFile, TTY_WAIT_MS);
    return tty;
  });

  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        terminal = undefined;
        tty = undefined;
      }
    }),
    vscode.debug.registerDebugConfigurationProvider("gdb", {
      async resolveDebugConfiguration(_folder, config) {
        if (!wantsProgramTerminal(config)) return config;
        const name = await ensure();
        if (!name) {
          void vscode.window.showWarningMessage(t.programTerminalFailed);
          return config;
        }
        return programTerminalConfig(config, name);
      },
    }),
    // Shown, and focused for typing, once the session has started: the debug
    // console opens at session start and would cover it.
    vscode.debug.onDidStartDebugSession((session) => {
      if (terminal && tty && session.configuration.autorun?.[0] === `set inferior-tty ${tty}`) terminal.show(false);
    }),
    { dispose: () => terminal && terminal.dispose() },
  );
}

function activate(context) {
  const t = pickStrings(vscode.env.language);

  const rawDeadline = readEnv("CODESPACE_DEADLINE");
  const returnUrl = readEnv("CODESPACE_RETURN_URL");
  const assignmentName = readEnv("CODESPACE_ASSIGNMENT_NAME");
  const seb = readEnv("CODESPACE_SEB") === "1";

  const parsed = rawDeadline ? new Date(rawDeadline) : null;
  const deadline = parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;

  writeWitness({
    activatedAt: new Date().toISOString(),
    language: vscode.env.language,
    deadline: rawDeadline ?? null,
    deadlineParsed: deadline ? deadline.toISOString() : null,
    returnUrl: returnUrl ?? null,
    assignmentName: assignmentName ?? null,
    seb,
  });

  // --- 1. countdown --------------------------------------------------------
  if (deadline) {
    const countdown = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    const tooltipLines = [t.deadlineLine(formatDeadline(deadline, t))];
    if (assignmentName) tooltipLines.push(t.assignmentLine(assignmentName));
    countdown.tooltip = tooltipLines.join("\n");

    const render = () => {
      const remaining = deadline.getTime() - Date.now();
      countdown.text = `$(clock) ${formatRemaining(remaining, t)}`;
      countdown.backgroundColor =
        remaining <= WARN_MS
          ? new vscode.ThemeColor("statusBarItem.warningBackground")
          : undefined;
    };

    render();
    countdown.show();
    const timer = setInterval(render, TICK_MS);
    context.subscriptions.push(countdown, { dispose: () => clearInterval(timer) });
  }

  // --- 2. « Fermer » button, or SEB's quit hint ----------------------------
  // The command is always registered (it is declared by the manifest, so it is
  // visible in the palette); the status bar item, though, only exists if the
  // portal passed a return URL. In a SEB session the portal passes none, and
  // the item is a hint with no command: SEB quits on its own shortcut (it
  // asks to confirm), and `files.autoSave` has already saved the files.
  context.subscriptions.push(
    vscode.commands.registerCommand("codespace.close", async () => {
      if (seb) {
        await vscode.window.showInformationMessage(t.sebQuitTooltip);
        return;
      }
      if (!returnUrl) {
        await vscode.window.showInformationMessage(t.noReturnUrl);
        return;
      }
      // `openExternal` opens a new browser tab (see README).
      await vscode.env.openExternal(vscode.Uri.parse(returnUrl));
    }),
  );

  if (seb) {
    const hint = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    hint.text = `$(sign-out) ${t.sebQuit}`;
    hint.tooltip = t.sebQuitTooltip;
    hint.show();
    context.subscriptions.push(hint);
  } else if (returnUrl) {
    const close = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    close.text = `$(sign-out) ${t.close}`;
    close.tooltip = `${t.closeTooltip} (${returnUrl})`;
    close.command = "codespace.close";
    close.show();
    context.subscriptions.push(close);
  }

  // --- the debugged program's terminal (#1103) ------------------------------
  registerProgramTerminal(context, t);

  // --- 3. a push GitHub refused (ADR-078 §6), 4. the teacher's update (ADR-132 §11)
  const remote = portalRemote();
  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  if (remote && folder) {
    const refused = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    refused.text = `$(warning) ${t.pushRejected}`;
    refused.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    const offered = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
    offered.text = `$(cloud-download) ${t.update}`;
    offered.command = "codespace.applyUpdate";
    const run = gitRunner(folder.uri.fsPath);
    /** The update shown, while it is not in the student's history. */
    let pending = null;
    let applying = false;

    /** The teacher's message and its date, as plain text only (never a MarkdownString). */
    const describe = (update) => {
      const date = update.message ? new Date(update.message.at) : null;
      const at = date && !Number.isNaN(date.getTime()) ? formatDeadline(date, t) : "";
      const lines = [t.updateTooltip(at)];
      if (update.message) lines.push("", t.updateMessage, plainText(update.message.text));
      return lines.join("\n");
    };

    const poll = async () => {
      const status = await readPushStatus(remote);
      const rejected = status && status.rejected;
      if (rejected && typeof rejected.ref === "string") {
        const branch = rejected.ref.replace(/^refs\/heads\//, "");
        refused.tooltip = t.pushRejectedTooltip(branch, String(rejected.reason || "?"));
        refused.show();
      } else {
        refused.hide();
      }
      if (!applying) {
        const update = parseUpdate(status);
        pending = update && !(await isTaken(run, update.sha)) ? update : null;
      }
      if (pending) {
        offered.tooltip = describe(pending);
        offered.show();
      } else {
        offered.hide();
      }
    };

    context.subscriptions.push(
      vscode.commands.registerCommand("codespace.applyUpdate", async () => {
        const update = pending;
        if (!update || applying) return;
        const choice = await vscode.window.showInformationMessage(
          t.updateConfirm,
          { modal: true, detail: describe(update) },
          t.apply,
        );
        if (choice !== t.apply) return;
        applying = true;
        let result;
        try {
          result = await applyUpdate(run, update);
        } finally {
          applying = false;
        }
        const names = result.files || [];
        const files = plainText(names.slice(0, 10).join(", ") + (names.length > 10 ? ", …" : ""));
        // `current` (already in the work) says nothing: the re-poll hides the item.
        const said = {
          applied: ["showInformationMessage", t.updateApplied],
          unavailable: ["showWarningMessage", t.updateUnavailable],
          otherBranch: ["showWarningMessage", t.updateOtherBranch(update.branch)],
          busy: ["showWarningMessage", t.updateBusy],
          dirty: ["showWarningMessage", t.updateDirty(files)],
          conflict: ["showWarningMessage", t.updateConflict(files)],
          failed: ["showErrorMessage", t.updateFailed(plainText(result.detail || "?"))],
        }[result.outcome];
        if (said) void vscode.window[said[0]](said[1]);
        await poll();
      }),
    );

    void poll();
    const timer = setInterval(() => void poll(), TICK_MS);
    context.subscriptions.push(refused, offered, { dispose: () => clearInterval(timer) });
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
