import type { ReactNode } from "react";

import { Card, SectionHeading } from "../ui";

/**
 * The head of a Results tab: its chart on the left, its four figures stacked
 * on the right — the chart is the reading, the figures its captions. Under
 * `lg` the figures go above the chart, two by two.
 */
export function Summary({
  title,
  chart,
  stats,
}: {
  title: string;
  chart: ReactNode;
  /** Four `Stat`s. */
  stats: ReactNode;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_15rem]">
      <div className="grid grid-cols-2 gap-3 lg:order-2 lg:grid-cols-1">{stats}</div>
      <Card className="flex flex-col gap-4 p-5 lg:order-1">
        <SectionHeading title={title} />
        <div className="flex flex-1 flex-col justify-end">{chart}</div>
      </Card>
    </div>
  );
}
