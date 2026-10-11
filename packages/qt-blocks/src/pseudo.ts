/**
 * A program as indented text, in the canvas's own words: what the surfaces
 * show without Blockly (ADR-103 §12) and what the grading table prints in a
 * cell. Pure: no React, no Blockly.
 */
import { fmt } from "@quiz/core/client";
import type { Stmt } from "@quiz/domain/blocks";

import type { BlocksCanvasStrings } from "./strings.js";

type Words = Pick<
  BlocksCanvasStrings,
  | "forward"
  | "turn"
  | "turnLeft"
  | "turnRight"
  | "repeat"
  | "repeatUntilDock"
  | "ifSensor"
  | "else"
  | "sensorFree"
  | "sensorBlocked"
  | "whereFront"
  | "whereLeft"
  | "whereRight"
>;

const SENSOR = { free: "sensorFree", blocked: "sensorBlocked" } as const;
const WHERE = { front: "whereFront", left: "whereLeft", right: "whereRight" } as const;

/** One statement and its bodies, two spaces a level. */
function lines(program: Stmt[], c: Words, indent: string, out: string[]): string[] {
  const nested = (body: Stmt[]) => lines(body, c, `${indent}  `, out);
  for (const stmt of program) {
    switch (stmt.kind) {
      case "forward":
        out.push(indent + c.forward);
        break;
      case "turn":
        out.push(indent + fmt(c.turn, { dir: stmt.dir === "left" ? c.turnLeft : c.turnRight }));
        break;
      case "repeat":
        out.push(indent + fmt(c.repeat, { n: stmt.times }));
        nested(stmt.body);
        break;
      case "repeat_until_dock":
        out.push(indent + c.repeatUntilDock);
        nested(stmt.body);
        break;
      case "if_sensor":
        out.push(indent + fmt(c.ifSensor, { sensor: c[SENSOR[stmt.sensor]], where: c[WHERE[stmt.where]] }));
        nested(stmt.then);
        if (stmt.else.length > 0) {
          out.push(indent + c.else);
          nested(stmt.else);
        }
        break;
    }
  }
  return out;
}

/** The program, one statement a line; an empty program is an empty string. */
export function pseudoCode(program: Stmt[], words: Words): string {
  return lines(program, words, "", []).join("\n");
}
