/**
 * The profile-picture editor: pick an image, frame a square of it, save a
 * 256 px JPEG; or remove the current picture. jsdom draws nothing and
 * decodes no image, so the canvas and `Image` are doubles that record what
 * the editor asks of them — which square of the source ends up on screen
 * and in the upload is the behaviour under test.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AvatarMime } from "@quiz/contracts";

import { AvatarEditor } from "./AvatarEditor";
import { fail, mockFetch, noContent, renderWithProviders } from "./test/render";

const AVATAR = "/app/api/me/avatar";

/** Every `drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)` the editor made. */
let draws: number[][];
/** The canvases whose `toBlob` was asked, with their size. */
let exported: { width: number; height: number; type: string | undefined }[];
/** Set a source picture's size before choosing the file. */
let natural = { width: 800, height: 400 };

class FakeImage {
  onload: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_url: string) {
    this.naturalWidth = natural.width;
    this.naturalHeight = natural.height;
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  draws = [];
  exported = [];
  natural = { width: 800, height: 400 };
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn(() => "blob:avatar");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () =>
      ({
        clearRect: () => {},
        drawImage: (_img: unknown, ...rest: number[]) => void draws.push(rest),
        imageSmoothingQuality: "low",
      }) as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (
    this: HTMLCanvasElement,
    callback: BlobCallback,
    type?: string,
  ) {
    exported.push({ width: this.width, height: this.height, type });
    callback(new Blob(["jpeg"], { type: type ?? "image/png" }));
  });
});

function render(hasAvatar: boolean) {
  const onClose = vi.fn();
  const result = renderWithProviders(<AvatarEditor hasAvatar={hasAvatar} onClose={onClose} />);
  return { onClose, ...result };
}

/** Chooses a file through the hidden input, and waits for the preview. */
async function choose(container: HTMLElement) {
  const input = container.ownerDocument.querySelector<HTMLInputElement>('input[type="file"]')!;
  const user = userEvent.setup();
  await user.upload(input, new File(["bytes"], "me.png", { type: "image/png" }));
  await screen.findByRole("slider", { name: /zoom/i });
  return input;
}

const lastDraw = () => draws.at(-1)!;

describe("AvatarEditor — before a picture is chosen", () => {
  it("offers to choose one, accepts the avatar types only, and cannot save yet", () => {
    mockFetch({});
    render(false);
    expect(screen.getByRole("button", { name: /choose an image/i })).toBeInTheDocument();
    expect(screen.getByText(/jpeg, png or webp/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save picture/i })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /remove picture/i })).not.toBeInTheDocument();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(input.accept.split(",").sort()).toEqual([...AvatarMime.options].sort());
    expect(input.accept).not.toContain("gif");
  });
});

describe("AvatarEditor — framing and saving", () => {
  it("shows the largest centred square of the picture, then uploads it as a 256 px JPEG", async () => {
    const { calls, fetchMock } = mockFetch({ [`PUT ${AVATAR}`]: noContent() });
    const { container, onClose } = render(false);
    await choose(container);

    // 800x400: the square is 400 wide, centred horizontally, on a 288 px preview.
    expect(lastDraw()).toEqual([200, 0, 400, 400, 0, 0, 288, 288]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:avatar");
    expect(screen.getByRole("button", { name: /choose another/i })).toBeInTheDocument();

    await userEvent.setup().click(screen.getByRole("button", { name: /save picture/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));

    expect(exported).toEqual([{ width: 256, height: 256, type: "image/jpeg" }]);
    expect(lastDraw()).toEqual([200, 0, 400, 400, 0, 0, 256, 256]);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`PUT ${AVATAR}`]);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.body).toBeInstanceOf(Blob);
    expect(new Headers(init.headers).get("content-type")).toBe("image/jpeg");
  });

  it("zooms around the centre, from the slider and the wheel, within 1x to 5x", async () => {
    mockFetch({});
    const { container } = render(false);
    await choose(container);
    const slider = screen.getByRole("slider", { name: /zoom/i });

    fireEvent.change(slider, { target: { value: "2" } });
    // A 200 px square around the centre (400, 200).
    expect(lastDraw()).toEqual([300, 100, 200, 200, 0, 0, 288, 288]);

    const canvas = container.ownerDocument.querySelector("canvas")!;
    fireEvent.wheel(canvas, { deltaY: 100 }); // out
    expect(Number((slider as HTMLInputElement).value)).toBeCloseTo(2 / 1.08, 5);
    for (let i = 0; i < 40; i++) fireEvent.wheel(canvas, { deltaY: -100 }); // far in
    expect(Number((slider as HTMLInputElement).value)).toBe(5);
    for (let i = 0; i < 40; i++) fireEvent.wheel(canvas, { deltaY: 100 }); // far out
    expect(Number((slider as HTMLInputElement).value)).toBe(1);
  });

  it("drags the square, and never past the picture's edge", async () => {
    mockFetch({});
    const { container } = render(false);
    await choose(container);
    const canvas = container.ownerDocument.querySelector("canvas")!;
    canvas.setPointerCapture = () => {};

    // One preview pixel is 400/288 source pixels; dragging right moves the square left.
    fireEvent.pointerDown(canvas, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 136, clientY: 100, pointerId: 1 });
    const [sx] = lastDraw();
    expect(sx).toBeCloseTo(200 - 36 * (400 / 288), 5);

    // Far to the right: clamped at the left edge.
    fireEvent.pointerMove(canvas, { clientX: 2_000, clientY: 2_000, pointerId: 1 });
    expect(lastDraw().slice(0, 4)).toEqual([0, 0, 400, 400]);

    // Released: moving the pointer no longer drags.
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 0, clientY: 0, pointerId: 1 });
    expect(lastDraw().slice(0, 4)).toEqual([0, 0, 400, 400]);
  });

  it("keeps the dialog open and says why when the upload fails", async () => {
    mockFetch({ [`PUT ${AVATAR}`]: fail(413, { message: "The picture is too large" }) });
    const { container, onClose } = render(false);
    await choose(container);
    await userEvent.setup().click(screen.getByRole("button", { name: /save picture/i }));
    expect(await screen.findByText("The picture is too large")).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("falls back to its own words when the server says nothing", async () => {
    mockFetch({ [`PUT ${AVATAR}`]: fail(500) });
    const { container } = render(false);
    await choose(container);
    await userEvent.setup().click(screen.getByRole("button", { name: /save picture/i }));
    expect(await screen.findByText(/could not upload the picture/i)).toBeInTheDocument();
  });
});

describe("AvatarEditor — removing the current picture", () => {
  it("deletes it and closes", async () => {
    const { calls } = mockFetch({ [`DELETE ${AVATAR}`]: noContent() });
    const { onClose } = render(true);
    await userEvent.setup().click(screen.getByRole("button", { name: /remove picture/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`DELETE ${AVATAR}`]);
  });

  it("stays open with an error when the removal fails", async () => {
    mockFetch({ [`DELETE ${AVATAR}`]: fail(500) });
    const { onClose } = render(true);
    await userEvent.setup().click(screen.getByRole("button", { name: /remove picture/i }));
    expect(await screen.findByText(/could not remove the picture/i)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
