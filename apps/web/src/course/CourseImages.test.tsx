import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CourseWorkspaceImage, CourseWorkspaceImages } from "@quiz/contracts";

import { fail, mockFetch, noContent, ok, renderWithProviders, type Reply } from "../test/render";
import { CourseImages } from "./CourseImages";
import { IMAGES_POLL_MS } from "./workspaceImages";

/*
 * The Images tab of a course (ADR-146 §4–§8): its states (loading, empty,
 * failed; the 404 of the feature off hides the tab, `CoursePage.test.tsx`), each image's admission in
 * words (the reason of a refusal, never the portal's diagnostic as prose;
 * a refused Refresh that keeps the previous version running; obsolete),
 * the list read again until no admission is in flight, the owner's Add,
 * Refresh, Rename and Remove — with the projects that refuse a removal —
 * and an assistant who reads.
 */

const COURSE = "0190d3c4-0000-7000-8000-0000000000c1";
const LIST = `/app/api/courses/${COURSE}/workspace-images`;
const at = "2026-11-20T08:00:00.000Z";
const BASE = { reference: `ghcr.io/heig-tin-info/quiz-base@sha256:${"b".repeat(64)}`, version: "1.1.0" };

const img = (over: Partial<CourseWorkspaceImage> & Pick<CourseWorkspaceImage, "id" | "name">): CourseWorkspaceImage => ({
  reference: `ghcr.io/heig-tin-info/${over.name.toLowerCase().replace(/\W+/g, "-")}:latest`,
  digestReference: `ghcr.io/heig-tin-info/x@sha256:${"a".repeat(64)}`,
  state: "ready",
  reason: null,
  detail: null,
  baseVersion: "1.1.0",
  diskBytes: 1_240_000_000,
  obsolete: false,
  projects: [],
  createdAt: at,
  updatedAt: at,
  ...over,
});
const C = img({
  id: "1a6e0000-0000-4000-8000-000000000001",
  name: "C with Baygon",
  projects: [{ id: "0190d3c4-0000-7000-8000-0000000000f1", name: "Labo 2" }],
});
const GO = img({ id: "1a6e0000-0000-4000-8000-000000000002", name: "Go 1.24", state: "checking", digestReference: null, baseVersion: null, diskBytes: null, obsolete: null });
const RUST = img({
  id: "1a6e0000-0000-4000-8000-000000000003",
  name: "Rust",
  state: "refused",
  reason: "contract_failed",
  detail: 'FAIL task.allowAutomaticTasks is "on"',
});
const PY = img({ id: "1a6e0000-0000-4000-8000-000000000004", name: "Python", baseVersion: "1.0.0", obsolete: true });

const listOf = (images: CourseWorkspaceImage[], canManage = true): CourseWorkspaceImages => ({ images, base: BASE, canManage, max: 5 });

function renderTab(list: Reply | ((call: unknown) => Reply), routes: Record<string, Reply> = {}, adding = false) {
  const onAdding = vi.fn();
  const mocked = mockFetch({ [`GET ${LIST}`]: list, ...routes });
  renderWithProviders(<CourseImages courseId={COURSE} adding={adding} onAdding={onAdding} />);
  return { ...mocked, onAdding };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the course's Images tab", () => {
  it("names each image's admission in words, the portal's diagnostic only quoted", async () => {
    renderTab(ok(listOf([C, GO, RUST, PY])));
    const rows = await screen.findAllByTestId("workspace-image");
    expect(rows).toHaveLength(4);
    const [c, go, rust, py] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
    expect(within(c).getByText("ready")).toBeInTheDocument();
    expect(within(c).getByText("Used by Labo 2")).toBeInTheDocument();
    expect(within(c).getByText("1.2 GB")).toBeInTheDocument();
    expect(within(go).getByText("checking…")).toBeInTheDocument();
    expect(within(go).getByText("No project uses it")).toBeInTheDocument();
    // A refused Refresh: the reason in our words, the previous digest still running, the detail quoted.
    expect(within(rust).getByText("refused")).toBeInTheDocument();
    expect(within(rust).getByText("A protected setting or file of quiz-base changed in the image.")).toBeInTheDocument();
    expect(within(rust).getByText("The previous version keeps running.")).toBeInTheDocument();
    expect(within(rust).getByText(RUST.detail!).tagName).toBe("CODE");
    expect(within(py).getByText("obsolete")).toBeInTheDocument();
    expect(within(py).getByText("quiz-base 1.1.0 is out. Rebuild the image, then refresh it.")).toBeInTheDocument();
  });

  it("says a first admission was refused without the previous-version line", async () => {
    renderTab(ok(listOf([img({ id: RUST.id, name: "Rust", state: "refused", reason: "not_on_base", digestReference: null, detail: null })])));
    expect(await screen.findByText("The image is not built on a released quiz-base.")).toBeInTheDocument();
    expect(screen.queryByText("The previous version keeps running.")).toBeNull();
  });

  it("gives an owner Refresh, Rename and Remove, and an in-flight image no Refresh", async () => {
    renderTab(ok(listOf([C, GO])));
    const [c, go] = (await screen.findAllByTestId("workspace-image")) as [HTMLElement, HTMLElement];
    await userEvent.click(within(c).getByRole("button", { name: "Actions" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Refresh", "Rename", "Remove"]);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(within(go).getByRole("button", { name: "Actions" }));
    expect((await screen.findAllByRole("menuitem")).map((i) => i.textContent)).toEqual(["Rename", "Remove"]);
  });

  it("gives an assistant no action, and says who manages the list", async () => {
    renderTab(ok(listOf([C], false)));
    await screen.findByText("C with Baygon");
    expect(screen.queryByRole("button", { name: "Actions" })).toBeNull();
    expect(screen.getByText("Only a teacher of the course with the online workspace adds or changes its images.")).toBeInTheDocument();
  });

  it("reads the list again while an admission is in flight, and stops once it is ready", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let reads = 0;
    renderTab(() => {
      reads += 1;
      return ok(listOf([reads < 3 ? { ...GO, state: reads === 1 ? "downloading" : "checking" } : { ...GO, state: "ready", digestReference: C.digestReference }]));
    });
    expect(await screen.findByText("downloading…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(IMAGES_POLL_MS));
    expect(await screen.findByText("checking…")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(IMAGES_POLL_MS));
    expect(await screen.findByText("ready")).toBeInTheDocument();
    const settled = reads;
    await act(() => vi.advanceTimersByTimeAsync(3 * IMAGES_POLL_MS));
    expect(reads).toBe(settled);
  });

  it("refreshes an image, the row moving to Downloading…", async () => {
    const { calls } = renderTab(ok(listOf([C])), {
      [`POST ${LIST}/${C.id}/refresh`]: ok({ ...C, state: "downloading" }),
    });
    await screen.findByText("C with Baygon");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === `${LIST}/${C.id}/refresh`)).toBe(true));
  });

  it("names the projects that still use an image it was asked to remove", async () => {
    renderTab(ok(listOf([C])), {
      [`DELETE ${LIST}/${C.id}`]: fail(409, { error: "image_in_use", message: "in use", projects: C.projects }),
    });
    await screen.findByText("C with Baygon");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove image" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Still used by Labo 2. Pick another image in those projects first.")).toBeInTheDocument();
  });

  it("removes an image no project uses, once confirmed", async () => {
    const { calls } = renderTab(ok(listOf([GO])), { [`DELETE ${LIST}/${GO.id}`]: noContent() });
    await screen.findByText("Go 1.24");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove image" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(await screen.findByText("Image removed")).toBeInTheDocument();
  });

  it("renames an image, a name already taken worded", async () => {
    const { calls } = renderTab(ok(listOf([C])), {
      [`PATCH ${LIST}/${C.id}`]: fail(409, { error: "name_taken", message: "taken" }),
    });
    await screen.findByText("C with Baygon");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename image" });
    const field = within(dialog).getByRole("textbox", { name: "Name" });
    await userEvent.clear(field);
    await userEvent.type(field, "Go 1.24");
    await userEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: "Go 1.24" }));
    expect(await screen.findByText("Another image of the course has this name.")).toBeInTheDocument();
  });

  it("adds an image by the route's own schema, a reference the portal refuses worded and its detail quoted", async () => {
    const { calls } = renderTab(ok(listOf([])), {
      [`POST ${LIST}`]: fail(422, { error: "not_public", message: "refused", detail: "401 Unauthorized" }),
    }, true);
    const dialog = await screen.findByRole("dialog", { name: "Add an image" });
    // The base teachers derive from, and the public content warning.
    expect(within(dialog).getByText("Base to build from: quiz-base 1.1.0")).toBeInTheDocument();
    expect(within(dialog).getByText("FROM ghcr.io/heig-tin-info/quiz-base:latest")).toBeInTheDocument();
    expect(within(dialog).getByText(/Anyone can download a public image/)).toBeInTheDocument();
    const submit = within(dialog).getByRole("button", { name: "Add image" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Go");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reference" }), "quay.io/x/go:1");
    // Not a ghcr.io nor a docker.io reference: refused before it leaves.
    expect(submit).toBeDisabled();
    await userEvent.clear(within(dialog).getByRole("textbox", { name: "Reference" }));
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reference" }), "ghcr.io/me/go:latest");
    await userEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "Go", reference: "ghcr.io/me/go:latest" }));
    expect(await within(dialog).findByText("The image is not public. Make its package public on the registry.")).toBeInTheDocument();
    expect(within(dialog).getByText("401 Unauthorized").tagName).toBe("CODE");
  });

  it("closes the dialog on an image added, with a toast", async () => {
    const { onAdding } = renderTab(ok(listOf([])), { [`POST ${LIST}`]: ok({ ...GO, state: "downloading" }) }, true);
    const dialog = await screen.findByRole("dialog", { name: "Add an image" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Go 1.24");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reference" }), "ghcr.io/me/go:latest");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add image" }));
    expect(await screen.findByText("Image added")).toBeInTheDocument();
    expect(onAdding).toHaveBeenCalledWith(false);
  });

  it("says what an image is for when the course has none, with the guide", async () => {
    renderTab(ok(listOf([])));
    expect(await screen.findByText("No images yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /How to build an image/ })).toHaveAttribute(
      "href",
      "https://heig-tin-info.github.io/heig-quiz/guide/workspace-images/",
    );
  });

  it("says the course is full under its cap", async () => {
    renderTab(ok({ ...listOf([C, GO, RUST, PY, img({ id: "1a6e0000-0000-4000-8000-000000000005", name: "Java" })]) }));
    expect(await screen.findByText("A course holds 5 images at most. Remove one to add another.")).toBeInTheDocument();
  });

  it("offers a retry when the list fails", async () => {
    renderTab(fail(500, { message: "boom" }));
    expect(await screen.findByText("Could not load the images")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("words a 404 not_found as an image gone, never as the registry's refusal", async () => {
    renderTab(ok(listOf([C])), { [`POST ${LIST}/${C.id}/refresh`]: fail(404, { error: "not_found", message: "Not found" }) });
    await screen.findByText("C with Baygon");
    await userEvent.click(screen.getByRole("button", { name: "Actions" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Refresh" }));
    expect(await screen.findByText("This item no longer exists or is not open to you.")).toBeInTheDocument();
    expect(screen.queryByText("The registry knows no image at this reference.")).toBeNull();
  });

  it("words too_many_images with the list's own cap", async () => {
    renderTab(ok({ ...listOf([]), max: 3 }), { [`POST ${LIST}`]: fail(409, { error: "too_many_images", message: "too many" }) }, true);
    const dialog = await screen.findByRole("dialog", { name: "Add an image" });
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Name" }), "Go");
    await userEvent.type(within(dialog).getByRole("textbox", { name: "Reference" }), "ghcr.io/me/go:latest");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add image" }));
    expect(await within(dialog).findByText("A course holds 3 images at most. Remove one to add another.")).toBeInTheDocument();
  });
});
