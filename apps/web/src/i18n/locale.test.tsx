import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LOCALE_INFO, LOCALES } from "@quiz/domain";

import { CrashBoundary } from "../CrashBoundary";
import { de } from "./de";
import { browserLocale, I18nProvider, loadLocale, storedChoice, storedLocale, useI18n } from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const prefer = (...languages: string[]) =>
  vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);

describe("the browser's language (#228)", () => {
  it("takes the first preferred language the app speaks", () => {
    prefer("xx-YY", "fr-CH", "en");
    expect(browserLocale()).toBe("fr");
  });

  it("falls back to English", () => {
    prefer("xx-YY", "zz");
    expect(browserLocale()).toBe("en");
  });

  it("reads navigator.language when the list is empty", () => {
    prefer();
    vi.spyOn(navigator, "language", "get").mockReturnValue("fr-CH");
    expect(browserLocale()).toBe("fr");
  });

  it("takes a stored value it does not speak for the browser's choice", () => {
    prefer("fr-CH");
    localStorage.setItem("quiz-locale", "zz");
    expect(storedChoice()).toBe("browser");
    expect(storedLocale()).toBe("fr");
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

describe("German, a translated language (ADR-140)", () => {
  function probe() {
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
    return () => i18n;
  }

  it("is what a German-speaking browser gets, whatever its region", () => {
    prefer("de-CH", "fr-CH", "en");
    expect(browserLocale()).toBe("de");
    prefer("xx-YY", "de-DE");
    expect(storedLocale()).toBe("de");
  });

  it("paints German from the first frame once main.tsx has loaded it, never English first", async () => {
    prefer("en-GB");
    localStorage.setItem("quiz-locale", "de");
    await loadLocale(storedLocale());
    const i18n = probe();
    expect(i18n().locale).toBe("de");
    expect(i18n().t("whatsNew.title")).toBe(de["whatsNew.title"]);
    expect(document.documentElement.lang).toBe("de");
  });

  it("is picked, stored in this browser and saved to the account", async () => {
    prefer("fr-CH");
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const i18n = probe();
    await act(async () => i18n().setLocale("de"));
    await waitFor(() => expect(i18n().locale).toBe("de"));
    expect(i18n().choice).toBe("de");
    expect(localStorage.getItem("quiz-locale")).toBe("de");
    expect(storedChoice()).toBe("de");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("/app/api/me");
    expect(JSON.parse(String(init?.body))).toEqual({ locale: "de" });
  });

  it("is in the language picker and the command palette, named in itself", () => {
    expect(LOCALES).toContain("de");
    expect(LOCALE_INFO.de).toEqual({ endonym: "Deutsch", origin: "translated" });
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
