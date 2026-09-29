/**
 * The `codeimage` column of the grading table (ADR-040): the picture the
 * program drew, as a thumbnail drawn only once its row is near the viewport,
 * beside the program in `code`'s clamped box.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { codeimageGrading } from "./grading.js";
import { encodeImage } from "./pixels.js";
import type { CodeImageDetails } from "./schema.js";
import { codeimageServer } from "./server.js";
import { CHECKER, imageConfig } from "./test/fixtures.js";

const view = { seed: 3, itemId: "i", shuffle: false };
const config = imageConfig();
const student = codeimageServer.toStudent(config, view);
const solution = codeimageServer.toSolution(config, view);
const [column] = codeimageGrading.columns(student, solution);
const answer = { regions: ["    for (;;) putchar('#');\n"] };

const graded: CodeImageDetails = {
  runner: "ok",
  compile: { ok: true, stderr: "", ms: 10 },
  run: { exitCode: 0, timedOut: false, oom: false, truncated: false, ms: 3 },
  image: encodeImage(CHECKER, "bw"),
  matching: 12,
  pixelCount: 12,
  warnings: [],
  sourceSha256: null,
};

/** An `IntersectionObserver` the test drives: nothing is in view until `reveal()`. */
function stubObserver() {
  const callbacks: IntersectionObserverCallback[] = [];
  class Observer {
    constructor(callback: IntersectionObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal("IntersectionObserver", Observer);
  return () =>
    act(() => {
      for (const cb of callbacks) {
        cb([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    });
}

afterEach(() => vi.unstubAllGlobals());

describe("codeimage grading column", () => {
  it("is one column holding the picture and the program", () => {
    expect(column!.label).toBe("Picture · program");
    render(<>{column!.cell({ answer, details: graded })}</>);
    expect(screen.getByRole("img", { name: "The picture the program draws" })).toBeInTheDocument();
    expect(screen.getByText("for (;;) putchar('#');")).toBeInTheDocument();
  });

  it("draws the thumbnail only once its row scrolls into view", () => {
    const reveal = stubObserver();
    const { container } = render(<>{column!.cell({ answer, details: graded })}</>);
    expect(container.querySelector("[data-thumbnail]")).toHaveAttribute("data-thumbnail", "waiting");
    expect(screen.queryByRole("img")).toBeNull();
    reveal();
    expect(container.querySelector("[data-thumbnail]")).toHaveAttribute("data-thumbnail", "drawn");
    expect(screen.getByRole("img", { name: "The picture the program draws" })).toBeInTheDocument();
  });

  it("says 'runner…' in place of a picture the runner still owes", () => {
    render(<>{column!.cell({ answer, details: null })}</>);
    expect(screen.getByText("runner…")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("reads a marker the grading pass left instead of a breakdown", () => {
    const marker = { reason: "runner_unavailable" } as unknown as CodeImageDetails;
    render(<>{column!.cell({ answer, details: marker })}</>);
    expect(screen.getByText("runner…")).toBeInTheDocument();
  });

  it("shows no chip and no picture on a teacher's override", () => {
    const manual = { manual: true } as unknown as CodeImageDetails;
    render(<>{column!.cell({ answer, details: manual })}</>);
    expect(screen.queryByText(/Not run|runner…|No picture/)).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("says when a run printed no picture", () => {
    render(<>{column!.cell({ answer, details: { ...graded, image: null } })}</>);
    expect(screen.getByText("No picture")).toBeInTheDocument();
  });

  it("puts the target and the reference solution on the expected row", () => {
    render(<>{column!.expected()}</>);
    expect(screen.getByRole("img", { name: "The target picture" })).toBeInTheDocument();
    expect(screen.getByText(/secret-image-reference/).className).toContain("text-info");
  });
});
