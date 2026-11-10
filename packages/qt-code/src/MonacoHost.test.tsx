import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { splitTemplate } from "@quiz/domain/lockedTemplate";

import { LockedEditor } from "./LockedEditor.js";
import { CodeArea, LINE_PX } from "./MonacoHost.js";

/** What the editors handed Monaco, and a stand-in that reports a content height. */
const seen = vi.hoisted(() => ({
  props: [] as Array<{ height: string; options: { scrollbar?: object; editContext?: boolean } }>,
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

  // Safe Exam Browser's private clipboard writes a paste into a textarea
  // only; EditContext would lose it (#1079).
  it("uses the textarea input, not EditContext", async () => {
    render(<CodeArea value="x" language="c" label="Code" onChange={() => {}} monaco />);
    await screen.findByTestId("monaco");
    expect(seen.props.at(-1)!.options.editContext).toBe(false);
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
  async function renderLocked() {
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
    return seen.props.at(-1)!.options;
  }

  it("passes the wheel to the page", async () => {
    expect((await renderLocked()).scrollbar).toEqual({ alwaysConsumeMouseWheel: false });
  });

  it("uses the textarea input, not EditContext", async () => {
    expect((await renderLocked()).editContext).toBe(false);
  });
});

describe("a paste Safe Exam Browser already handled (#1079)", () => {
  /** SEB's `Clipboard.js`: cancels every paste on the document, in the capture phase. */
  const sebCancels = (e: Event) => e.preventDefault();
  const underSeb = () => {
    (globalThis as { SafeExamBrowser?: unknown }).SafeExamBrowser = { clipboard: {} };
    document.addEventListener("paste", sebCancels, true);
  };

  afterEach(() => {
    document.removeEventListener("paste", sebCancels, true);
    delete (globalThis as { SafeExamBrowser?: unknown }).SafeExamBrowser;
  });

  /** Whether a paste on Monaco's node reaches a listener there. */
  async function reachesMonaco(): Promise<boolean> {
    const monaco = await screen.findByTestId("monaco");
    let reached = false;
    // Monaco's paste controller listens in the capture phase on its own node.
    monaco.addEventListener("paste", () => (reached = true), true);
    monaco.dispatchEvent(new Event("paste", { bubbles: true, cancelable: true }));
    return reached;
  }
  const renderArea = () =>
    render(<CodeArea value="x" language="c" label="Code" onChange={() => {}} monaco />);

  it("never reaches Monaco under SEB's private clipboard", async () => {
    underSeb();
    renderArea();
    expect(await reachesMonaco()).toBe(false);
  });

  it("still reaches Monaco outside SEB, cancelled or not", async () => {
    renderArea();
    expect(await reachesMonaco()).toBe(true);
    cleanup();
    document.addEventListener("paste", sebCancels, true);
    renderArea();
    expect(await reachesMonaco()).toBe(true);
  });

  it("guards the locked editor too", async () => {
    seen.mount = false;
    underSeb();
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
    expect(await reachesMonaco()).toBe(false);
  });
});
