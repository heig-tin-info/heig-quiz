/**
 * test.sh § 12 (#1103): a program debugged by webfreak.debug reads and writes
 * the terminal the image gives it, with a breakpoint on the way.
 *
 * Runs inside the container with code-server's bundled node. It plays the
 * two parts of the editor that need no browser, with the real pieces:
 *   - the "Program" terminal: node-pty, the module code-server's pty host
 *     uses, spawns the holder command of heig.codespace-statusbar's
 *     debugIo.js, which writes its tty name;
 *   - the debug session: the real debug adapter of webfreak.debug
 *     (out/src/gdb.js) over the Debug Adapter Protocol on stdio, launched
 *     with the configuration `programTerminalConfig` makes of a plain one.
 * Then it types "7" into the terminal as a student would and prints, as JSON,
 * what the terminal showed, what reached the debug console, and the events.
 *
 *   node test-debug-io.js <statusbar extension dir> <webfreak.debug dir> <target>
 */
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const pty = require("/usr/lib/code-server/lib/vscode/node_modules/node-pty");

const [statusbarDir, debugDir, target] = process.argv.slice(2);
const { holderArgs, programTerminalConfig } = require(path.join(statusbarDir, "debugIo.js"));

const ttyFile = `/tmp/t12-tty-${process.pid}`;
const result = { tty: null, screen: "", console: "", events: [], stoppedLine: null, error: null };
const finish = (code) => {
  fs.rmSync(ttyFile, { force: true });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exit(code);
};
setTimeout(() => {
  result.error = "timeout";
  finish(1);
}, 20_000);

// --- the "Program" terminal -------------------------------------------------
let typed = false;
const term = pty.spawn("/bin/sh", holderArgs(ttyFile), { name: "xterm-256color", cols: 100, rows: 30, cwd: "/work", env: process.env });
term.onData((data) => {
  result.screen += data;
  if (!typed && result.screen.includes("enter a=")) {
    typed = true;
    term.write("7\r");
  }
});

const waitTty = () =>
  new Promise((resolve, reject) => {
    const until = Date.now() + 5000;
    const poll = () => {
      try {
        const name = fs.readFileSync(ttyFile, "utf8").trim();
        if (name) return resolve(name);
      } catch {}
      if (Date.now() > until) return reject(new Error("the holder wrote no tty name"));
      setTimeout(poll, 50);
    };
    poll();
  });

// --- the debug adapter ------------------------------------------------------
let seq = 0;
let adapter;
const send = (command, args) => {
  const body = JSON.stringify({ seq: ++seq, type: "request", command, arguments: args });
  adapter.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

let buffer = Buffer.alloc(0);
const onMessage = (msg) => {
  if (msg.type === "event") {
    result.events.push(msg.event);
    if (msg.event === "output") result.console += msg.body.output;
    if (msg.event === "initialized") {
      send("setBreakpoints", { source: { path: path.resolve("/work", target + ".c") }, breakpoints: [{ line: 7 }] });
      send("configurationDone", {});
    }
    if (msg.event === "stopped") send("stackTrace", { threadId: msg.body.threadId || 1, startFrame: 0, levels: 1 });
    if (msg.event === "terminated") {
      term.kill();
      finish(0);
    }
  } else if (msg.type === "response") {
    if (!msg.success) result.error = `${msg.command}: ${msg.message}`;
    if (msg.command === "stackTrace" && msg.success) {
      result.stoppedLine = msg.body.stackFrames[0] && msg.body.stackFrames[0].line;
      send("continue", { threadId: 1 });
    }
  }
};

waitTty()
  .then((tty) => {
    result.tty = tty;
    const config = programTerminalConfig(
      { type: "gdb", request: "launch", name: "Debug", target: "./" + target, cwd: "/work", valuesFormatting: "parseText" },
      tty,
    );
    result.autorun = config.autorun;
    adapter = spawn(process.execPath, [path.join(debugDir, "out/src/gdb.js")], { cwd: "/work" });
    adapter.stdout.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const head = buffer.indexOf("\r\n\r\n");
        if (head < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, head).toString())[1]);
        if (buffer.length < head + 4 + length) return;
        onMessage(JSON.parse(buffer.subarray(head + 4, head + 4 + length).toString()));
        buffer = buffer.subarray(head + 4 + length);
      }
    });
    send("initialize", { adapterID: "gdb", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path" });
    send("launch", config);
  })
  .catch((err) => {
    result.error = String(err);
    finish(1);
  });
