import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { PersonPill } from "./people";
import { PersonAvatar, Tip } from ".";

describe("PersonAvatar", () => {
  it("shows the picture, and the initials once the picture fails to load", () => {
    const { container } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="https://idp.example/dead.png" />,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("alt", "");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("AL")).toBeVisible();
  });

  it("names a lone avatar and shows the full name as a Tip, never a native title", () => {
    vi.useFakeTimers();
    renderWithProviders(<PersonAvatar name={["Ada", "Lovelace"]} src={null} label="Ada Lovelace" />);
    const disc = screen.getByRole("img", { name: "Ada Lovelace" });
    expect(disc).not.toHaveAttribute("title");
    fireEvent.mouseEnter(disc.parentElement!);
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    vi.useRealTimers();
  });

  /** Loads a picture of `side` px natural size into `img`. */
  const load = (img: HTMLImageElement, side: number) => {
    Object.defineProperty(img, "naturalWidth", { value: side, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: side, configurable: true });
    fireEvent.load(img);
  };
  const hover = (el: Element) => {
    fireEvent.mouseEnter(el);
    act(() => {
      vi.advanceTimersByTime(150);
    });
  };
  /** The enlarged copy: the one decorative picture in the portalled bubble. */
  const enlarged = () => document.body.querySelector<HTMLImageElement>("[aria-hidden] img");

  it("shows a loaded picture larger on hover, with the name in the same bubble", () => {
    vi.useFakeTimers();
    const { container } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="/ada.png" label="Ada Lovelace" />,
    );
    const img = screen.getByRole("img", { name: "Ada Lovelace" }) as HTMLImageElement;
    load(img, 256);
    hover(container.firstElementChild!);
    const big = enlarged()!;
    expect(big).toHaveAttribute("alt", "");
    expect(big).toHaveAttribute("src", "/ada.png");
    expect(big.style.width).toBe("176px");
    // One bubble: the picture and the name share it.
    expect(big.closest(".tip-bubble")).toHaveTextContent("Ada Lovelace");
    expect(document.body.querySelectorAll(".tip-bubble")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("never upscales a small picture past its natural size", () => {
    vi.useFakeTimers();
    const { container } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="/ada.png" />,
    );
    load(container.querySelector("img")!, 96);
    hover(container.firstElementChild!);
    expect(enlarged()!.style.width).toBe("96px");
    vi.useRealTimers();
  });

  it("has no preview before the picture loads, nor for initials", () => {
    vi.useFakeTimers();
    const { container, unmount } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="/ada.png" />,
    );
    hover(container.firstElementChild!);
    expect(document.body.querySelector(".tip-bubble")).toBeNull();
    unmount();

    const initials = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src={null} label="Ada Lovelace" />,
    );
    hover(initials.container.firstElementChild!);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(enlarged()).toBeNull();
    vi.useRealTimers();
  });

  it("has no preview when the picture is no larger than the disc", () => {
    vi.useFakeTimers();
    const { container } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="/ada.png" className="size-24" />,
    );
    const img = container.querySelector("img")!;
    Object.defineProperty(img, "offsetWidth", { value: 96, configurable: true });
    load(img, 96);
    hover(container.firstElementChild!);
    expect(document.body.querySelector(".tip-bubble")).toBeNull();
    vi.useRealTimers();
  });

  it("puts no picture in the bubble on a touch screen", () => {
    vi.useFakeTimers();
    const coarse = vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: query === "(pointer: coarse)",
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList,
    );
    const { container } = renderWithProviders(
      <PersonAvatar name={["Ada", "Lovelace"]} src="/ada.png" label="Ada Lovelace" />,
    );
    load(container.querySelector("img")!, 256);
    hover(container.firstElementChild!);
    expect(screen.getByText("Ada Lovelace")).toBeInTheDocument();
    expect(enlarged()).toBeNull();
    coarse.mockRestore();
    vi.useRealTimers();
  });

  it("stays shut while a PersonPill's card is open", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <PersonPill
        person={{
          userId: "u1",
          givenName: "Ada",
          familyName: "Lovelace",
          email: "ada@heig-vd.ch",
          avatarUrl: "/ada.png",
        }}
      />,
    );
    const disc = screen.getByRole("button", { name: "Ada Lovelace" });
    load(disc.querySelector("img")!, 256);
    const tip = disc.firstElementChild!;
    hover(tip);
    expect(enlarged()).not.toBeNull();
    fireEvent.click(disc.querySelector("img")!);
    expect(screen.getByRole("dialog", { name: "Ada Lovelace" })).toBeInTheDocument();
    expect(document.body.querySelector(".tip-bubble")).toBeNull();
    fireEvent.mouseLeave(tip);
    hover(tip);
    expect(document.body.querySelector(".tip-bubble")).toBeNull();
    vi.useRealTimers();
  });

  it("gives the signed-in user's own disc the accent fill", () => {
    renderWithProviders(<PersonAvatar name={["Ada", "Lovelace"]} src={null} tone="accent" />);
    expect(screen.getByText("AL")).toHaveClass("bg-accent");
  });
});
