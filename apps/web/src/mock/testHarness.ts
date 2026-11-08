/**
 * The boot both mock suites share (`contract.test.ts`, `behaviour.test.ts`):
 * the mock installed on `window.fetch` under the same scene flags, so both
 * read the same seed, and the helpers that call it. TEST-ONLY; run under
 * jsdom.
 */
import { expect } from "vitest";

/**
 * Installs the mock. Call it, and await it, before importing `./runtime` or
 * `./student`: the scene flags are read when the mock's modules load.
 */
export async function bootMock(): Promise<void> {
  // jsdom has no `fetch`; the mock wraps whatever is there and only defers to
  // it for a URL outside `/app/`, which these tests never ask for.
  if (typeof window.fetch !== "function") {
    window.fetch = (() => Promise.reject(new Error("no network in this test"))) as typeof fetch;
  }
  // `?journal=1`, as the runtime remembers it: PRG1-2026 has a journal, so its
  // pages are served and checked; every other classroom answers "no journal".
  localStorage.setItem("quiz-mock-journal", "1");
  // `?projects=1` (M3-10): PRG1-2026 has a project in each state, so the
  // classroom's list and the Activities' project rows are served and checked.
  localStorage.setItem("quiz-mock-projects", "1");
  localStorage.setItem("quiz-mock-codespace", "1");
  // `?groups=1` (M3-16a): PRG1-2026 and PRG1-2024 have group sets, and two of
  // PRG1-2026's drafts are group projects.
  localStorage.setItem("quiz-mock-groups", "1");
  await import("./index");
}

interface Issue {
  code: string;
  format?: string;
  path: PropertyKey[];
  message: string;
}
export interface Schema {
  safeParse: (v: unknown) => { success: boolean; error?: { issues: Issue[] } };
}

/** A GET through the mock, which must answer 200. */
export const get = async (path: string): Promise<unknown> => {
  const res = await fetch(path);
  expect(res.status, `GET ${path}`).toBe(200);
  return res.json() as Promise<unknown>;
};

/** A schema's issues, a hand-written `uuid` excepted (the header of `contract.test.ts` says why). */
export const issuesOf = (schema: Schema, value: unknown): string[] => {
  const parsed = schema.safeParse(value);
  if (parsed.success) return [];
  return (parsed.error?.issues ?? [])
    .filter((i) => !(i.code === "invalid_format" && i.format === "uuid"))
    .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`);
};
