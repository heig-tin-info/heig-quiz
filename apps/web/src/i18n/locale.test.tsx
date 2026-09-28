import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrashBoundary } from "../CrashBoundary";
import { browserLocale, I18nProvider, storedLocale, useI18n } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const prefer = (...languages: string[]) =>
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);

describe("the browser's language (#228)", () => {
  it("takes the first preferred language the app speaks", () => {
    prefer("de-CH", "fr-CH", "en");
    expect(browserLocale()).toBe("fr");
  });

  it("falls back to English", () => {
    prefer("de-CH", "it");
    expect(browserLocale()).toBe("en");
  });

  it("is the default when nothing was chosen, and an explicit choice wins", () => {
    prefer("fr-FR");
    expect(storedLocale()).toBe("fr");
    localStorage.setItem("quiz-locale", "en");
    expect(storedLocale()).toBe("en");
  });

  it("'browser' is stored as such and resolves to the browser's language", async () => {
    prefer("en-GB");
    localStorage.setItem("quiz-locale", "fr");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    let i18n!: ReturnType<typeof useI18n>;
    function Probe() {
      i18n = useI18n();
      return null;
    }
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(i18n.choice).toBe("fr");
    await act(async () => i18n.setLocale("browser", false));
    expect(i18n.choice).toBe("browser");
    expect(i18n.locale).toBe("en");
    expect(localStorage.getItem("quiz-locale")).toBe("browser");
  });
});

describe("CrashBoundary", () => {
  it("replaces a crashed render with a message and a reload button", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("insertBefore");
    }
    render(
      <CrashBoundary>
        <Boom />
      </CrashBoundary>,
    );
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
