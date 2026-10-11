/**
 * The block workspace of the three surfaces: Blockly when it loads, the
 * program as read-only text otherwise (ADR-103 §11, §12).
 *
 * 1. **Blockly is lazy.** `./blocklyBundle.ts` — Blockly, its generator and
 *    its messages — is reached by the dynamic `import()` below and nothing
 *    else, so it is a chunk of its own, fetched only when a `blocks` surface
 *    renders (N-PERF-05). Until it arrives, and forever if it fails to load
 *    or to mount, the program is shown as indented text with a line that
 *    says so: never an empty box, and never a student editing path.
 * 2. **The program is ours.** The workspace takes and gives back `Stmt[]`;
 *    Blockly's serialization never leaves this file's bundle (ADR-103 §5).
 */
import { Component, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { BlockKind, NodePath, Stmt } from "@quiz/domain/blocks";
import { programEquals } from "@quiz/domain/blocks";
import { caption, cx, lockedBlock } from "@quiz/ui";

import type { MountedWorkspace } from "./blocklyBundle.js";
import { pseudoCode } from "./pseudo.js";
import type { BlocksCanvasStrings } from "./strings.js";

/**
 * Whether the Blockly path is worth trying. jsdom has no layout and no SVG
 * geometry, so the component suites always render the text — which is also
 * the surface they drive.
 */
export function blocklyAvailable(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  return !navigator.userAgent.includes("jsdom");
}

/**
 * What the page says of itself on `<html>`: whether it is drawn dark
 * (`html.dark`) and its language (`lang`), followed as they change — the two
 * things the host sets there and a workspace must be rebuilt for.
 */
function usePage(): { dark: boolean; lang: string } {
  const read = () =>
    typeof document === "undefined"
      ? { dark: false, lang: "en" }
      : { dark: document.documentElement.classList.contains("dark"), lang: document.documentElement.lang || "en" };
  const [page, setPage] = useState(read);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => {
      const next = read();
      setPage((now) => (now.dark === next.dark && now.lang === next.lang ? now : next));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "lang"] });
    return () => observer.disconnect();
  }, []);
  return page;
}

export interface BlocklyHostProps {
  program: Stmt[];
  /** Absent: read-only, no palette. */
  onChange?: ((program: Stmt[]) => void) | undefined;
  toolbox: readonly BlockKind[];
  words: BlocksCanvasStrings;
  /** The accessible name of the workspace ("Starter program"). */
  label: string;
  /** Blocks, or the JavaScript they stand for (the player's `Blocks | Code`). */
  view?: "blocks" | "code";
  /** The block a run is at. */
  highlight?: NodePath | null;
  /** The workspace's height, in px. */
  height?: number;
  /** Forces the Blockly path on or off; defaults to {@link blocklyAvailable}. */
  blockly?: boolean | undefined;
}

/** The program as text: the loading state, the failed state, and every jsdom render. */
export function ProgramText({
  program,
  words,
  note,
  label,
}: {
  program: Stmt[];
  words: BlocksCanvasStrings;
  /** What is said under it: why there are no blocks. */
  note?: string | undefined;
  label: string;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1.5">
      <pre className={cx(lockedBlock, "min-h-16 whitespace-pre")} aria-label={label}>
        {program.length === 0 ? words.emptyProgram : pseudoCode(program, words)}
      </pre>
      {note === undefined ? null : <p className={caption}>{note}</p>}
    </div>
  );
}

/** A failed chunk throws while rendering; a failed mount sets the same flag. */
class BlocklyBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type CanvasProps = Omit<BlocklyHostProps, "blockly"> & { onFail: () => void };

const LazyCanvas = lazy(async () => {
  const bundle = await import("./blocklyBundle.js");
  function Canvas({ program, onChange, toolbox, words, label, view = "blocks", highlight = null, height = 360, onFail }: CanvasProps) {
    const host = useRef<HTMLDivElement>(null);
    const mounted = useRef<MountedWorkspace | null>(null);
    /** The last program this workspace gave or was given: what it holds. */
    const holds = useRef<Stmt[]>(program);
    const change = useRef(onChange);
    change.current = onChange;
    const { dark, lang } = usePage();
    const [code, setCode] = useState("");
    const readOnly = onChange === undefined;
    // A surface builds its dictionaries at every render: the workspace
    // follows what they SAY, not their identity.
    const settings = useRef({ toolbox, words });
    settings.current = { toolbox, words };
    const settingsKey = JSON.stringify(settings.current);

    useEffect(() => {
      const container = host.current;
      if (container === null) return;
      let workspace: MountedWorkspace;
      try {
        workspace = bundle.mountWorkspace({
          container,
          program: holds.current,
          ...settings.current,
          dark,
          lang,
          readOnly,
          onChange: (next) => {
            holds.current = next;
            setCode(workspace.code());
            change.current?.(next);
          },
        });
      } catch {
        onFail();
        return;
      }
      mounted.current = workspace;
      setCode(workspace.code());
      const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => workspace.resize());
      observer?.observe(container);
      return () => {
        observer?.disconnect();
        mounted.current = null;
        workspace.dispose();
      };
      // A new theme, palette, language or mode is a new workspace; the
      // program travels through `holds`.
    }, [dark, lang, settingsKey, readOnly]);

    // A program from outside (a reset, another surface) replaces the blocks;
    // the echo of the workspace's own change does not.
    useEffect(() => {
      if (mounted.current === null || programEquals(program, holds.current)) return;
      holds.current = program;
      mounted.current.load(program);
      setCode(mounted.current.code());
    }, [program]);

    useEffect(() => mounted.current?.highlight(highlight), [highlight]);
    useEffect(() => {
      if (view === "blocks") mounted.current?.resize();
    }, [view]);

    return (
      <>
        <div
          ref={host}
          role="group"
          aria-label={label}
          className={cx("overflow-hidden rounded-field border border-line-strong", view === "code" && "hidden")}
          style={{ height }}
          data-testid="blockly-host"
        />
        {view === "code" ? (
          <pre className={cx(lockedBlock, "overflow-auto whitespace-pre")} style={{ height }} aria-label={label}>
            {code.trim() === "" ? words.codeEmpty : code}
          </pre>
        ) : null}
      </>
    );
  }
  return { default: Canvas };
});

export function BlocklyHost({ blockly, ...props }: BlocklyHostProps): ReactNode {
  const [failed, setFailed] = useState(false);
  const text = (note: string) => (
    <ProgramText program={props.program} words={props.words} note={note} label={props.label} />
  );
  const fallback = text(props.words.unavailable);
  if (failed || !(blockly ?? blocklyAvailable())) return fallback;
  return (
    <BlocklyBoundary fallback={fallback}>
      <Suspense fallback={text(props.words.loading)}>
        <LazyCanvas {...props} onFail={() => setFailed(true)} />
      </Suspense>
    </BlocklyBoundary>
  );
}
