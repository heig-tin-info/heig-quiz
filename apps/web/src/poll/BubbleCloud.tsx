import { forceCollide, forceSimulation, forceX, forceY, type Simulation, type SimulationNodeDatum } from "d3-force";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { PollTally } from "@quiz/contracts";
import { prefersReducedMotion } from "@quiz/ui";

import { cx } from "../ui";

/**
 * The brainstorm's wall (issue #458, ADR-071): one bubble per idea, its AREA
 * proportional to the participants who proposed it, packed by a small force
 * simulation (`d3-force`: a pull to the centre, no overlap).
 *
 * The bubbles are positioned DIVs rather than SVG circles: an idea is a few
 * words that must wrap inside its circle, and HTML wraps. A bubble keeps its
 * place from one tally to the next — the simulation's nodes live in a ref,
 * keyed by idea — so a growing bubble pushes its neighbours aside instead of
 * the whole wall reshuffling. Under `prefers-reduced-motion` the simulation is
 * run to rest before anything is drawn.
 *
 * Colour is categorical by idea (`--chart-1…8`, the palette of the donut),
 * picked from the idea's key so a bubble keeps its colour; it never carries a
 * meaning on its own — the label is always inside.
 */

type Bubble = PollTally["ideas"][number];

interface Node extends SimulationNodeDatum {
  key: string;
  r: number;
}

/** Share of the wall the bubbles cover together: dense, with air around them. */
const FILL = 0.42;
const GAP = 6;
const MIN_R = 30;

/** A stable small hash: an idea keeps its colour and its entry point. */
function hashOf(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}

function bubbleColor(key: string): string {
  return `var(--chart-${(hashOf(key) % 8) + 1})`;
}

/** The radius of each bubble, so that their areas share `FILL` of the wall. */
function radiiFor(bubbles: readonly Bubble[], width: number, height: number): Map<string, number> {
  const total = bubbles.reduce((sum, b) => sum + b.count, 0);
  const out = new Map<string, number>();
  if (total === 0 || width <= 0 || height <= 0) return out;
  const maxR = Math.min(width, height) / 2.4;
  for (const b of bubbles) {
    const area = (FILL * width * height * b.count) / total;
    out.set(b.key, Math.max(MIN_R, Math.min(maxR, Math.sqrt(area / Math.PI))));
  }
  return out;
}

/**
 * The largest font that fits the label in its circle: the whole text in the
 * inscribed square, its longest word on one line, and never more than half
 * the radius (the count sits under it).
 */
function labelSize(label: string, r: number): number {
  const box = r * 1.35;
  const longest = Math.max(1, ...label.split(/\s+/).map((w) => w.length));
  const byArea = box / Math.sqrt(0.62 * Math.max(1, label.length));
  const byWord = box / (0.58 * longest);
  return Math.max(10, Math.min(r * 0.42, byArea, byWord));
}

export function BubbleCloud({ bubbles, className }: { bubbles: readonly Bubble[]; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const nodes = useRef(new Map<string, Node>());
  const sim = useRef<Simulation<Node, undefined> | null>(null);
  const [, setFrame] = useState(0);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const radii = useMemo(() => radiiFor(bubbles, size.width, size.height), [bubbles, size]);

  useEffect(() => {
    const { width, height } = size;
    if (width === 0 || height === 0) return;
    const cx0 = width / 2;
    const cy0 = height / 2;
    const live = new Map<string, Node>();
    let arrived = false;
    for (const b of bubbles) {
      const r = radii.get(b.key) ?? MIN_R;
      const known = nodes.current.get(b.key);
      if (known) {
        known.r = r;
        live.set(b.key, known);
      } else {
        // A new idea enters near the centre, at an angle of its own.
        const angle = ((hashOf(b.key) % 360) * Math.PI) / 180;
        live.set(b.key, { key: b.key, r, x: cx0 + Math.cos(angle) * r, y: cy0 + Math.sin(angle) * r });
        arrived = true;
      }
    }
    nodes.current = live;
    const list = [...live.values()];

    const clamp = () => {
      for (const n of list) {
        n.x = Math.max(n.r, Math.min(width - n.r, n.x ?? cx0));
        n.y = Math.max(n.r, Math.min(height - n.r, n.y ?? cy0));
      }
    };
    sim.current?.stop();
    const simulation = forceSimulation(list)
      // A wide wall pulls harder vertically, so the cloud spreads sideways.
      .force("x", forceX<Node>(cx0).strength(0.04))
      .force("y", forceY<Node>(cy0).strength(0.04 * Math.max(1, width / Math.max(1, height))))
      .force("collide", forceCollide<Node>((n) => n.r + GAP).strength(0.9).iterations(2))
      // A new idea shakes the wall; a count that grew only nudges it.
      .alpha(arrived ? 0.7 : 0.25)
      .alphaDecay(0.03);
    sim.current = simulation;

    if (prefersReducedMotion()) {
      simulation.stop();
      for (let i = 0; i < 300; i += 1) {
        simulation.tick();
        clamp();
      }
      setFrame((f) => f + 1);
      return;
    }
    simulation.on("tick", () => {
      clamp();
      setFrame((f) => f + 1);
    });
    return () => {
      simulation.stop();
    };
  }, [bubbles, radii, size]);

  return (
    <div ref={box} className={cx("relative w-full overflow-hidden", className)}>
      <ul className="m-0 list-none p-0">
        {bubbles.map((b) => {
          const node = nodes.current.get(b.key);
          const r = radii.get(b.key) ?? MIN_R;
          if (!node || node.x === undefined || node.y === undefined) return null;
          const font = labelSize(b.label, r);
          const color = bubbleColor(b.key);
          return (
            <li
              key={b.key}
              className="absolute top-0 left-0 flex flex-col items-center justify-center rounded-full border-2 text-center text-fg transition-[width,height] duration-500 ease-out"
              style={{
                width: r * 2,
                height: r * 2,
                transform: `translate(${node.x - r}px, ${node.y - r}px)`,
                borderColor: color,
                background: `color-mix(in srgb, ${color} 22%, transparent)`,
              }}
            >
              <span
                className="block font-semibold leading-[1.1] tracking-[-0.01em] [overflow-wrap:anywhere]"
                style={{ fontSize: font, maxWidth: r * 1.75 }}
              >
                {b.label}
              </span>
              <span
                className="mt-[0.2em] block font-mono font-semibold tabular-nums text-fg-muted"
                style={{ fontSize: Math.max(10, font * 0.62) }}
              >
                {b.count}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
