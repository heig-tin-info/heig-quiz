/**
 * The draw rule of stored values (ADR-056 §5, ADR-147 §3), on plain
 * versions: what `completeInstances` keeps, what it draws, what drops, and
 * the two keep rules a new attempt and a paper variant pass it.
 */
import { describe, expect, it } from "vitest";

import { PARAMETERIZED, EXPLANATION, VARIABLES } from "../../test/parameterized.js";
import { completeInstances, instanceOf, replays, sameVersion, type InstanceItem, type VersionContent } from "./instance.js";

const SEED = 4242;

const version = (id: string, variables = VARIABLES, config: unknown = PARAMETERIZED.short): VersionContent => ({
  id,
  config,
  configVersion: 3,
  explanation: EXPLANATION,
  variables,
});
const item = (itemId: string, content: VersionContent, type = "short"): InstanceItem => ({
  item: { id: itemId },
  question: { type },
  version: content,
});
const STATIC = version("static", { rows: [] }, { configVersion: 3, prompt: "Name it.", kind: "text", matchers: [{ kind: "exact", value: "x" }] });

/** The same question, its height renamed: other names, so nothing replays. */
const RENAMED = {
  rows: [{ ...VARIABLES.rows[0]!, name: "height" }, VARIABLES.rows[1]!, { ...VARIABLES.rows[2]!, expr: "sqrt(2*height/g)" }],
  condition: VARIABLES.condition!,
};
const RENAMED_SHORT = { ...(PARAMETERIZED.short as object), prompt: "Dropped from [[height]] m where g = [[g]] m/s², how long?" };

const drawnFor = (entry: InstanceItem) =>
  instanceOf(entry.question.type, entry.version, { seed: SEED, itemId: entry.item.id }).stored!;

describe("completeInstances (ADR-056 §5, ADR-147 §3)", () => {
  it("draws every parameterized item from its own stream when nothing is stored, and stores nothing for a static one", () => {
    const a = item("a", version("v1"));
    const b = item("b", version("v1"));
    const { instances, drew } = completeInstances([a, b, item("s", STATIC)], { seed: SEED, instances: {} }, replays);
    expect(drew).toBe(true);
    expect(instances).toEqual({ a: drawnFor(a), b: drawnFor(b) });
    expect(instances["a"]!.values).not.toEqual(instances["b"]!.values);
  });

  it("keeps what the rule keeps, draws nothing then, and drops an item gone or made static", () => {
    const a = item("a", version("v1"));
    const kept = { versionId: "v1", values: { h: 50, g: 9.81, t: 3.19 }, fallback: "exhausted" as const };
    const stale = { versionId: "old", values: { h: 1, g: 1, t: 1 } };
    const { instances, drew } = completeInstances(
      [a, item("s", STATIC)],
      { seed: SEED, instances: { a: kept, s: stale, gone: stale } },
      sameVersion,
    );
    expect(drew).toBe(false);
    expect(instances).toEqual({ a: kept });
    expect(instances["a"]).toBe(kept);
  });

  it("draws again what the rule refuses", () => {
    const a = item("a", version("v2"));
    const old = { versionId: "v1", values: { h: 50, g: 9.81, t: 3.19 } };
    const { instances, drew } = completeInstances([a], { seed: SEED, instances: { a: old } }, sameVersion);
    expect(drew).toBe(true);
    expect(instances).toEqual({ a: drawnFor(a) });
  });
});

describe("the keep rules", () => {
  const drawn = { versionId: "v1", values: { h: 50, g: 9.81, t: 3.19 } };

  it("sameVersion keeps only an entry drawn for the item's current version", () => {
    expect(sameVersion(item("a", version("v1")), drawn, SEED)).toBe(true);
    expect(sameVersion(item("a", version("v2")), drawn, SEED)).toBe(false);
  });

  it("replays keeps an entry that replays under the same names, never one of other names", () => {
    expect(replays(item("a", version("v1")), drawn, SEED)).toBe(true);
    expect(replays(item("a", version("v2")), drawn, SEED)).toBe(true);
    expect(replays(item("a", version("v3", RENAMED, RENAMED_SHORT)), drawn, SEED)).toBe(false);
  });
});
