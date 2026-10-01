/**
 * Every generator's schemas go through the SDK's structured-output
 * conversion (ADR-059): a schema the conversion refuses would fail at the
 * first real call, which no fake provider sees.
 */
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { questionType, registeredServerIds } from "@quiz/registry/server";

import { generatorTypes } from "./generate.js";

describe("the generators' schemas", () => {
  for (const type of generatorTypes(registeredServerIds())) {
    it(`${type}: converts to a structured output`, () => {
      const generator = questionType(type).generator!;
      const whole = zodOutputFormat(z.object({ proposal: generator.proposalSchema as z.ZodType<unknown>, explanation: z.string() }));
      expect(JSON.stringify(whole)).toContain("explanation");
      if (generator.item) expect(() => zodOutputFormat(generator.item!.schema as z.ZodType<unknown>)).not.toThrow();
    });
  }
});
