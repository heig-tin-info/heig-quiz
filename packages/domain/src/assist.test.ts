import { describe, expect, it } from "vitest";

import {
  ASSIST_READ_LIMIT,
  ASSIST_REFUSAL,
  assistIndex,
  assistScreen,
  assistSystem,
  buildCorpus,
  firstSentence,
  parsePage,
  readGuide,
  headingSlug,
  stubAnswer,
  visiblePages,
  type AssistSource,
} from "./assist.js";

const POOLS = `# Question pools

A pool is where your questions live. It belongs to you.

## The pools page

The **Pools** page lists [every pool](pools.md) you reach. Then more.

### Favourites

A star keeps a question at hand.

## Sharing a pool

Share it with a colleague.
`;

const POOL_HELP_EN = `# The questions of a pool

## Search and filters

The search field covers the internal name.
`;

const POOL_HELP_FR = `# Les questions d'une banque

## Recherche et filtres

Le champ de recherche porte sur le nom interne.
`;

const ADMIN = `# Administration

Only the administrator.

## Teacher grants

Grant the teacher role.
`;

const SOURCES: AssistSource[] = [
  { id: "help/pool", locale: "fr", text: POOL_HELP_FR },
  { id: "guide/pools", locale: "en", text: POOLS },
  { id: "help/pool", locale: "en", text: POOL_HELP_EN },
  { id: "guide/admin", locale: "en", text: ADMIN },
  // A translation without its English file is dropped.
  { id: "help/orphan", locale: "fr", text: "# Orphelin" },
];

const corpus = buildCorpus(SOURCES);

describe("parsePage", () => {
  it("splits the title, the introduction and the ## sections, sub-headings kept in their section", () => {
    const page = parsePage(POOLS);
    expect(page.title).toBe("Question pools");
    expect(page.summary).toBe("A pool is where your questions live.");
    expect(page.sections.map((s) => s.slug)).toEqual(["the-pools-page", "sharing-a-pool"]);
    expect(page.sections[0]!.summary).toBe("The Pools page lists every pool you reach.");
    expect(page.sections[0]!.body).toContain("### Favourites");
  });

  it("ignores headings inside a code fence and CRLF line ends", () => {
    const page = parsePage("# T\r\n\r\n```md\r\n## Not a section\r\n```\r\n\r\n## Real\r\n\r\nBody.");
    expect(page.sections.map((s) => s.title)).toEqual(["Real"]);
    expect(page.intro).toContain("## Not a section");
  });

  it("reads a page without a title or an introduction", () => {
    const page = parsePage("## Only\n\nText");
    expect(page).toMatchObject({ title: "", summary: "", intro: "" });
  });
});

describe("firstSentence and headingSlug", () => {
  it("cuts a long sentence and skips a heading paragraph", () => {
    expect(firstSentence("### Sub\n\nShort one. Second.")).toBe("Short one.");
    expect(firstSentence("x".repeat(200), 10)).toBe(`${"x".repeat(9)}…`);
    expect(firstSentence("No full stop")).toBe("No full stop");
    expect(firstSentence("![img](a.png) Text with `code` and *stress*.")).toBe("Text with code and stress.");
  });

  it("makes an anchor of a heading", () => {
    expect(headingSlug("Écrire l'énoncé — vite !")).toBe("ecrire-l-enonce-vite");
  });
});

describe("buildCorpus", () => {
  it("orders the pages by id, keeps the translations and marks the admin page", () => {
    expect(corpus.pages.map((p) => p.id)).toEqual(["guide/admin", "guide/pools", "help/pool"]);
    expect(corpus.pages[0]!.audience).toBe("admin");
    expect(corpus.pages[2]!.texts.fr?.title).toBe("Les questions d'une banque");
    expect(corpus.pages[1]!.texts.fr).toBeUndefined();
  });

  it("drops a translation whose sections do not match the English ones", () => {
    const odd = buildCorpus([
      { id: "help/x", locale: "en", text: "# X\n\n## A\n\nA.\n\n## B\n\nB." },
      { id: "help/x", locale: "fr", text: "# X\n\n## A\n\nA." },
    ]);
    expect(odd.pages[0]!.texts.fr).toBeUndefined();
  });

  it("is deterministic: the same files make the same version, another file another one", () => {
    expect(buildCorpus([...SOURCES].reverse()).version).toBe(corpus.version);
    expect(buildCorpus(SOURCES.slice(1)).version).not.toBe(corpus.version);
    expect(corpus.version).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("visiblePages", () => {
  it("keeps the administrators' page from a teacher", () => {
    expect(visiblePages(corpus, "teacher").map((p) => p.id)).toEqual(["guide/pools", "help/pool"]);
    expect(visiblePages(corpus, "admin")).toHaveLength(3);
  });
});

describe("assistSystem", () => {
  it("states the scope, the refusal in both languages and the index", () => {
    const system = assistSystem(corpus, "teacher");
    expect(system).toContain(ASSIST_REFUSAL.fr);
    expect(system).toContain(ASSIST_REFUSAL.en);
    expect(system).toContain("teacher's questions");
    expect(system).toContain("- guide/pools — Question pools: A pool is where your questions live.");
    expect(system).toContain("  - guide/pools#sharing-a-pool — Sharing a pool: Share it with a colleague.");
    expect(system).not.toContain("guide/admin");
  });

  it("indexes the administrators' page for an administrator", () => {
    expect(assistSystem(corpus, "admin")).toContain("administrator's questions");
    expect(assistSystem(corpus, "admin")).toContain("guide/admin#teacher-grants");
  });

  it("depends on nothing but the corpus and the role: the cached prefix", () => {
    expect(assistSystem(corpus, "teacher")).toBe(assistSystem(buildCorpus(SOURCES), "teacher"));
  });

  it("indexes a page without a summary", () => {
    const bare = buildCorpus([{ id: "guide/x", locale: "en", text: "# X\n\n## S\n" }]);
    expect(assistIndex(bare.pages)).toBe("- guide/x — X\n  - guide/x#s — S");
  });
});

describe("assistScreen", () => {
  it("gives the route, the UI language and the screen's help in that language", () => {
    const screen = assistScreen(corpus, "teacher", { route: "/pools/:id", helpTopic: "pool", locale: "fr" });
    expect(screen).toContain("French (fr)");
    expect(screen).toContain("Route: /pools/:id");
    expect(screen).toContain("# Les questions d'une banque");
    expect(screen).toContain("## Recherche et filtres");
  });

  it("says when the screen has no topic, or one the corpus lacks", () => {
    expect(assistScreen(corpus, "teacher", { route: "/", helpTopic: null, locale: "en" })).toContain("no help topic");
    expect(assistScreen(corpus, "teacher", { route: "/", helpTopic: "nope", locale: "en" })).toContain("no help topic");
  });
});

describe("readGuide", () => {
  it("returns a page, by its id or its bare name", () => {
    const page = readGuide(corpus, "teacher", "en", { page: "guide/pools" });
    expect(page.startsWith("# Question pools\n\nA pool is")).toBe(true);
    expect(readGuide(corpus, "teacher", "en", { page: "pools.md" })).toBe(page);
    expect(readGuide(corpus, "teacher", "en", { page: "pool" })).toContain("# The questions of a pool");
  });

  it("returns one section, by its slug, its title or the index's page#section", () => {
    const section = readGuide(corpus, "teacher", "en", { page: "guide/pools", section: "sharing-a-pool" });
    expect(section).toBe("# Question pools\n\n## Sharing a pool\n\nShare it with a colleague.");
    expect(readGuide(corpus, "teacher", "en", { page: "guide/pools", section: "Sharing a pool" })).toBe(section);
    expect(readGuide(corpus, "teacher", "en", { page: "guide/pools", section: "guide/pools#sharing-a-pool" })).toBe(
      section,
    );
  });

  it("finds a translated section by the English slug of the index", () => {
    const fr = readGuide(corpus, "teacher", "fr", { page: "help/pool", section: "search-and-filters" });
    expect(fr).toContain("## Recherche et filtres");
  });

  it("names what exists for a wrong page or section, and hides the admin page from a teacher", () => {
    expect(readGuide(corpus, "teacher", "en", { page: "guide/admin" })).toBe(
      'No page "guide/admin". The pages are: guide/pools, help/pool.',
    );
    expect(readGuide(corpus, "admin", "en", { page: "guide/admin" })).toContain("# Administration");
    expect(readGuide(corpus, "teacher", "en", { page: "guide/pools", section: "nope" })).toBe(
      'No section "nope" in guide/pools. Its sections are: the-pools-page, sharing-a-pool.',
    );
  });

  it("cuts a page longer than the limit", () => {
    const long = buildCorpus([{ id: "guide/long", locale: "en", text: `# L\n\n${"word ".repeat(ASSIST_READ_LIMIT)}` }]);
    const read = readGuide(long, "teacher", "en", { page: "guide/long" });
    expect(read.length).toBeLessThan(ASSIST_READ_LIMIT + 100);
    expect(read).toContain("[The page continues");
  });
});

describe("stubAnswer", () => {
  it("says it is a stub, names the screen's help and the matching sections", () => {
    const answer = stubAnswer(corpus, "teacher", "How do I share a pool with a colleague?", {
      route: "/pools/:id",
      helpTopic: "pool",
      locale: "en",
    });
    expect(answer).toContain("Development stub, not a model");
    expect(answer).toContain("The help of this screen is **The questions of a pool**.");
    expect(answer).toContain("**Question pools › Sharing a pool** (`guide/pools#sharing-a-pool`)");
  });

  it("answers in the UI language, with the English anchors, and says when nothing matches", () => {
    const fr = stubAnswer(corpus, "teacher", "recherche du champ", { route: "/", helpTopic: null, locale: "fr" });
    expect(fr).toContain("Réponse de développement");
    expect(fr).toContain("(`help/pool#search-and-filters`)");
    const none = stubAnswer(corpus, "teacher", "zzz", { route: "/", helpTopic: null, locale: "en" });
    expect(none).toContain("No section of the documentation matches the question.");
  });

  it("never names the administrators' page to a teacher", () => {
    const answer = stubAnswer(corpus, "teacher", "teacher grants role", { route: "/", helpTopic: null, locale: "en" });
    expect(answer).not.toContain("guide/admin");
  });
});
