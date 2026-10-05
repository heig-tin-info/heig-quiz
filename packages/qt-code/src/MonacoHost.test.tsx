import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { splitTemplate } from "@quiz/domain/lockedTemplate";

import { LockedEditor } from "./LockedEditor.js";
import { CodeArea, LINE_PX } from "./MonacoHost.js";

/** What the editors handed Monaco, and a stand-in that reports a content height. */
const seen = vi.hoisted(() => ({
  props: [] as Array<{ height: string; options: { scrollbar?: object } }>,
  contentPx: 0,
  resize: null as (() => void) | null,
  mount: true,
}));

vi.mock("./monacoBundle.js", () => ({ monaco: {} }));
vi.mock("@monaco-editor/react", async () => {
  const { useEffect } = await import("react");
  function Editor(props: {
    height: string;
    options: { scrollbar?: object };
    onMount?: (editor: unknown, monaco: unknown) => void;
  }) {
    seen.props.push(props);
    useEffect(() => {
      if (!seen.mount) return;
      const editor = {
        createDecorationsCollection: () => ({ set: () => {} }),
        getContentHeight: () => seen.contentPx,
        onDidContentSizeChange: (listener: () => void) => {
          seen.resize = listener;
        },
      };
      props.onMount?.(editor, { Range: class {} });
    }, []);
    return <div data-testid="monaco" style={{ height: props.height }} />;
  }
  return { Editor, loader: { config: () => {} } };
});

beforeEach(() => {
  seen.props = [];
  seen.resize = null;
  seen.mount = true;
});

const lastHeight = () => screen.getByTestId("monaco").style.height;

describe("CodeArea (Monaco path)", () => {
  it("passes the wheel to the page", async () => {
    render(<CodeArea value="x" language="c" label="Code" onChange={() => {}} monaco />);
    await screen.findByTestId("monaco");
    expect(seen.props.at(-1)!.options.scrollbar).toEqual({ alwaysConsumeMouseWheel: false });
  });

  it("grows with Monaco's content height, never under its minimum", async () => {
    seen.contentPx = 40 * LINE_PX;
    render(<CodeArea value="x" language="c" label="Code" onChange={() => {}} monaco minLines={6} />);
    await screen.findByTestId("monaco");
    expect(lastHeight()).toBe(`${40 * LINE_PX}px`);

    seen.contentPx = 2 * LINE_PX;
    act(() => seen.resize!());
    expect(lastHeight()).toBe(`${6 * LINE_PX}px`);
  });

  it("stops growing at 100 lines", async () => {
    seen.contentPx = 250 * LINE_PX;
    render(<CodeArea value="x" language="c" label="Code" onChange={() => {}} monaco />);
    await screen.findByTestId("monaco");
    expect(lastHeight()).toBe(`${100 * LINE_PX}px`);
  });
});

describe("LockedEditor (Monaco path)", () => {
  it("passes the wheel to the page", async () => {
    // The locked session needs a real editor; the options are what matters here.
    seen.mount = false;
    render(
      <LockedEditor
        segments={splitTemplate("int x;\n", "c")}
        regions={[]}
        onChange={() => {}}
        language="c"
        label="Program"
        regionLabel="Region {n}"
        lockedLabel="Locked"
        monaco
      />,
    );
    await screen.findByTestId("monaco");
    expect(seen.props.at(-1)!.options.scrollbar).toEqual({ alwaysConsumeMouseWheel: false });
  });
});
