import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  resetShortcuts,
  shortcutCaps,
  useActiveShortcuts,
  useGlobalShortcuts,
  useShortcuts,
  type Shortcut,
} from "./shortcuts";

/*
 * The registry behind the sidebar strip. What matters is that the union
 * follows the page: a shortcut leaves with the screen that answers to it, a
 * disabled registration is not there at all, and the frame's own Ctrl+K
 * leads whatever order the effects ran in — a child's effect fires before
 * its parent's, so insertion order alone would put a page above the frame.
 */

function Screen({ list, enabled }: { list: Shortcut[]; enabled?: boolean }) {
  useShortcuts(list, enabled);
  return null;
}

/** The strip's reader: one line per live shortcut, in order. */
function Strip() {
  const shortcuts = useActiveShortcuts();
  return (
    <ul>
      {shortcuts.map((s, i) => (
        <li key={i}>{`${s.keys} ${s.label}`}</li>
      ))}
    </ul>
  );
}

const lines = () => screen.queryAllByRole("listitem").map((el) => el.textContent);

afterEach(() => resetShortcuts());

describe("useShortcuts", () => {
  it("registers while mounted and takes its shortcuts away on unmount", () => {
    const { unmount } = render(
      <>
        <Strip />
        <Screen list={[{ keys: "Ctrl+S", label: "Save" }]} />
      </>,
    );
    expect(lines()).toEqual(["Ctrl+S Save"]);
    unmount();
    render(<Strip />);
    expect(lines()).toEqual([]);
  });

  it("keeps the registrations in mount order", () => {
    render(
      <>
        <Strip />
        <Screen list={[{ keys: "V", label: "Validate" }]} />
        <Screen list={[{ keys: "Ctrl+B", label: "Bold" }]} />
      </>,
    );
    expect(lines()).toEqual(["V Validate", "Ctrl+B Bold"]);
  });

  it("replaces a registration when the screen changes its list", () => {
    const { rerender } = render(
      <>
        <Strip />
        <Screen list={[{ keys: "V", label: "Validate" }]} />
      </>,
    );
    rerender(
      <>
        <Strip />
        <Screen list={[{ keys: "O", label: "Adjust" }]} />
      </>,
    );
    expect(lines()).toEqual(["O Adjust"]);
  });

  it("registers nothing while disabled, and everything once enabled", () => {
    const list = [{ keys: "Esc", label: "Close the panel" }];
    const { rerender } = render(
      <>
        <Strip />
        <Screen list={list} enabled={false} />
      </>,
    );
    expect(lines()).toEqual([]);
    rerender(
      <>
        <Strip />
        <Screen list={list} enabled />
      </>,
    );
    expect(lines()).toEqual(["Esc Close the panel"]);
  });
});

describe("useGlobalShortcuts", () => {
  it("leads the union even though the page registered first", () => {
    function Frame({ children }: { children: React.ReactNode }) {
      useGlobalShortcuts([{ keys: "Ctrl+K", label: "Command palette" }]);
      return (
        <>
          <Strip />
          {children}
        </>
      );
    }
    render(
      <Frame>
        <Screen list={[{ keys: "Ctrl+S", label: "Save" }]} />
      </Frame>,
    );
    expect(lines()).toEqual(["Ctrl+K Command palette", "Ctrl+S Save"]);
  });
});

describe("shortcutCaps", () => {
  it("gives one cap per key", () => {
    expect(shortcutCaps("Ctrl+Shift+P")).toEqual(["Ctrl", "Shift", "P"]);
    expect(shortcutCaps("Alt+←")).toEqual(["Alt", "←"]);
    expect(shortcutCaps("Space")).toEqual(["Space"]);
  });
});
