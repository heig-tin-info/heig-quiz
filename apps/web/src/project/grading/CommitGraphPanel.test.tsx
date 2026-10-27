import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import type { ProjectCommit, ProjectCommitGraph } from "@quiz/contracts";

import { makeQueryClient, mockFetch, ok, renderWithProviders } from "../../test/render";
import { CommitGraphPanel } from "./CommitGraphPanel";

/*
 * The repository's history on the grading screen (ADR-119 §8, L-06e):
 * folded, nothing is read; unfolded, the graph with its merge, each
 * declared author in their member's colour or neutral, the marks; the
 * states GitHub leaves (unavailable, empty).
 */

const PROJECT = "0190d3c4-0000-7000-8000-0000000000c1";
const REPO = "0190d3c4-0000-7000-8000-000000000001";
const URL = `GET /app/api/projects/${PROJECT}/repos/${REPO}/commits`;
const sha = (c: string) => c.repeat(40);

const commit = (c: string, parents: string[], message: string, authorName: string, member: number | null, hour: number, mark: ProjectCommit["mark"] = null): ProjectCommit => ({
  sha: sha(c),
  parents: parents.map(sha),
  message,
  authorName,
  authoredAt: new Date(Date.UTC(2026, 9, 5, hour)).toISOString(),
  member,
  receivedAt: null,
  mark,
});

const GRAPH: ProjectCommitGraph = {
  status: "ok",
  branches: [{ name: "main", head: sha("d") }],
  members: [
    { name: "Ada Lovelace", login: "ada" },
    { name: "Bob Martin", login: null },
  ],
  commits: [
    commit("d", ["m"], "Deadline", "quiz-app[bot]", null, 9, "app"),
    commit("m", ["c", "f"], "Merge branch 'parser'", "Ada Lovelace", 0, 8),
    commit("f", ["b"], "Parse quoted words\n\nThey keep their spaces.", "Bob Martin", 1, 7),
    commit("c", ["b"], "Split words", "Someone Else", null, 6),
    commit("b", ["a"], "Read a line", "Ada Lovelace", 0, 5),
    commit("a", [], "Initial commit", "HEIG-VD", null, 1, "handout"),
  ],
  truncated: true,
  stale: false,
};

function Harness() {
  const [open, setOpen] = useState(false);
  return <CommitGraphPanel projectId={PROJECT} repoId={REPO} open={open} onOpenChange={setOpen} />;
}

const renderPanel = (locale: "en" | "fr" = "en") => renderWithProviders(<Harness />, { locale, queryClient: makeQueryClient() });

describe("CommitGraphPanel", () => {
  it("reads nothing folded, then draws the merge, the declared authors in their members' colours and the marks", async () => {
    const { calls } = mockFetch({ [URL]: ok(GRAPH) });
    renderPanel();
    const toggle = screen.getByRole("button", { name: /Repository history/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(calls).toEqual([]);
    await userEvent.click(toggle);

    const rows = await screen.findAllByTestId("commit-row");
    expect(rows).toHaveLength(6);
    // Children before parents: the merge above both its parents, the root last.
    const order = rows.map((r) => r.querySelector("[title]")?.getAttribute("title"));
    expect(order.indexOf("Merge branch 'parser'")).toBeLessThan(order.indexOf("Split words"));
    expect(order.at(-1)).toBe("Initial commit");
    const merge = rows.find((r) => r.textContent?.includes("Merge branch"))!;
    expect(merge.querySelector("svg[data-merge]")).not.toBeNull();
    expect(merge.querySelectorAll("svg path").length).toBe(3); // one line in, two out (its two parents)
    expect(within(merge).getByText("merge")).toBeInTheDocument();

    // Colours: a member's slot, anyone else neutral.
    const node = (text: string) => rows.find((r) => r.textContent?.includes(text))!.querySelector("circle")!;
    expect(node("Read a line").getAttribute("fill")).toBe("var(--chart-1)");
    expect(node("Parse quoted words").getAttribute("fill")).toBe("var(--chart-2)");
    expect(node("Split words").getAttribute("fill")).toBe("var(--fg-faint)");

    const legend = screen.getByTestId("commit-legend");
    expect(legend).toHaveTextContent("Declared author");
    expect(legend).toHaveTextContent("Ada Lovelace@ada");
    expect(legend).toHaveTextContent("Others");
    expect(within(rows[0]!).getByText("app")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("main")).toBeInTheDocument();
    expect(within(rows.at(-1)!).getByText("handed out")).toBeInTheDocument();
    expect(screen.getByText(/The oldest commits are left out: 300 per branch/)).toBeInTheDocument();
  });

  it("says why there is no graph, in French too", async () => {
    mockFetch({ [URL]: ok({ status: "unavailable", reason: "github" }) });
    renderPanel("fr");
    await userEvent.click(screen.getByRole("button", { name: /Historique du dépôt/ }));
    expect(await screen.findByText("GitHub ne répond pas. Réessayez dans un instant.")).toBeInTheDocument();
  });

  it("says when the branches hold no commit", async () => {
    mockFetch({ [URL]: ok({ ...GRAPH, commits: [], truncated: false }) });
    renderPanel();
    await userEvent.click(screen.getByRole("button", { name: /Repository history/ }));
    expect(await screen.findByText("No commit on the handed-out branches.")).toBeInTheDocument();
  });
});
