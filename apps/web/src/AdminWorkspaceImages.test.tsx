import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AdminWorkspaceImage } from "@quiz/contracts";

import { WorkspaceImagesSection } from "./AdminWorkspaceImages";
import { fail, mockFetch, ok, renderWithProviders } from "./test/render";

/*
 * The administrator's view of the engine's store of workspace images
 * (ADR-146 §8), on the System tab: read-only, the disk each image takes and
 * in total, what it is to this instance, who uses it and when it last ran;
 * nothing on a platform without the online workspace, its portal serving no
 * image included (the 404 of `images_unavailable`).
 */
const ROUTE = "GET /app/api/admin/workspace-images";
const BASE = `ghcr.io/heig-tin-info/quiz-base@sha256:${"b".repeat(64)}`;
const C = `ghcr.io/heig-tin-info/c@sha256:${"a".repeat(64)}`;

const store: AdminWorkspaceImage[] = [
  {
    id: "4b1e0c2a9f31",
    names: ["ghcr.io/heig-tin-info/quiz-base:1.1.0", BASE],
    diskBytes: 1_000_000_000,
    kind: "default",
    admissions: [
      { reference: BASE, digest: `sha256:${"b".repeat(64)}`, source: "default", state: "ready", lastUsedAt: "2026-11-25T08:00:00.000Z", liveSessions: 12, uses: [] },
    ],
  },
  {
    id: "c0ffee0a1b2",
    names: [C],
    diskBytes: 1_500_000_000,
    kind: "admitted",
    admissions: [
      {
        reference: C,
        digest: `sha256:${"a".repeat(64)}`,
        source: "course",
        state: "ready",
        lastUsedAt: null,
        liveSessions: 0,
        uses: [
          {
            course: { id: "0190d3c4-0000-7000-8000-0000000000c1", name: "Programmation C", code: "PRG1" },
            image: { id: "1a6e0000-0000-4000-8000-000000000001", name: "C with Baygon" },
            projects: [{ id: "0190d3c4-0000-7000-8000-0000000000f1", name: "Labo 2" }],
          },
        ],
      },
    ],
  },
  { id: "0bad0f00d123", names: [], diskBytes: 2_000_000_000, kind: "orphan", admissions: [] },
];

describe("the administrator's workspace images", () => {
  it("lists the store with each image's kind, size and uses, and the total", async () => {
    mockFetch({ [ROUTE]: ok(store) });
    renderWithProviders(<WorkspaceImagesSection />);
    expect(await screen.findByText("Workspace images")).toBeInTheDocument();
    expect(await screen.findByText("4.5 GB on disk")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const [base, c, orphan] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(base).getByText("default")).toBeInTheDocument();
    expect(within(base).getByText("Open now: 12")).toBeInTheDocument();
    expect(within(c).getByText("admitted")).toBeInTheDocument();
    expect(within(c).getByText("1.5 GB")).toBeInTheDocument();
    expect(within(c).getByText("PRG1")).toBeInTheDocument();
    expect(within(c).getByText(/C with Baygon \(Labo 2\)/)).toBeInTheDocument();
    // An image with no name in the store is named by its identifier.
    expect(within(orphan).getByText("orphan")).toBeInTheDocument();
    expect(within(orphan).getByText("0bad0f00d123")).toBeInTheDocument();
    // Read-only: no action anywhere.
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
  });

  it.each([
    ["without the online workspace", { error: "not_found" }],
    ["whose portal serves no image (images_unavailable)", { error: "images_unavailable", message: "not yet" }],
  ])("is not there on a platform %s: the 404", async (_, body) => {
    const { calls } = mockFetch({ [ROUTE]: fail(404, body) });
    const { container } = renderWithProviders(<WorkspaceImagesSection />);
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    await waitFor(() => expect(container.querySelector("[data-testid=admin-workspace-images]")).toBeNull());
  });
});
