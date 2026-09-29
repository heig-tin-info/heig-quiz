import { describe, expect, it } from "vitest";

import { NOT_ZOD_ISSUE } from "@quiz/contracts";

import { en } from "../i18n/en";
import type { TFunction } from "../i18n";
import { issueMessage } from "./issues";

/** The English dictionary with `{n}` filled, which is all `issueMessage` asks of `t`. */
const t: TFunction = (key, vars) =>
  en[key].replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? `{${k}}`));

describe("issueMessage", () => {
  it("says a key the schema raised in the app's words", () => {
    expect(issueMessage(t, { code: "custom", message: "categorize.no_target" })).toBe(
      en["issue.categorize.no_target"],
    );
  });

  it("says a generic zod issue from its code, never with zod's sentence", () => {
    const raw = "Too small: expected string to have >=1 characters";
    expect(issueMessage(t, { code: "too_small", message: raw, origin: "string", limit: 1 })).toBe(
      "This field is empty.",
    );
    expect(issueMessage(t, { code: "too_big", message: raw, origin: "array", limit: 6 })).toBe("At most 6 items.");
    expect(issueMessage(t, { code: "invalid_type", message: raw })).toBe(en["issue.zod.invalid"]);
  });

  it("keeps the words of a refinement it does not know, and of an error that was not zod's", () => {
    expect(issueMessage(t, { code: "custom", message: "Something new." })).toBe("Something new.");
    expect(issueMessage(t, { code: NOT_ZOD_ISSUE, message: "No migration from v3." })).toBe("No migration from v3.");
  });
});
