/*
 * Controls gallery, mounted at the top of `/dev/ui`: every form control of the
 * scale (ADR-094, issue #552) as the real components render it, each
 * specimen measured in the browser. Development only — App.tsx routes the page
 * behind `import.meta.env.DEV`, so none of this is in the production build.
 *
 * Like the rest of the gallery, the specimen labels are literal English (this
 * page never ships).
 */
import { useState, type ReactNode } from "react";

import type { ControlSize } from "@quiz/ui";

import { setThemeChoice, useResolvedTheme } from "../theme";
import {
  Badge,
  Button,
  Card,
  Field,
  RadioRow,
  SearchInput,
  SectionHeading,
  Segmented,
  Select,
  Tabs,
  Textarea,
  ToggleChip,
} from "../ui";
import { Measure } from "./Measure";

const SIZES: ControlSize[] = ["sm", "md", "lg"];
const VARIANTS = ["primary", "secondary", "subtle", "ghost", "ink", "danger", "danger-quiet"] as const;
const ROLES = [
  { value: "all", label: "All" },
  { value: "teachers", label: "Teachers" },
  { value: "students", label: "Students" },
] as const;
type Role = (typeof ROLES)[number]["value"];
const POLICIES = ["Best attempt", "Last attempt", "Average", "First attempt", "Weighted", "Manual"].map((l) => ({
  value: l,
  label: l,
}));

/** A labelled group of specimens inside a section. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</h4>
      <div className="flex flex-wrap items-end gap-x-6 gap-y-4">{children}</div>
    </div>
  );
}

function Pane({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-fg">{title}</h4>
        {note ? <p className="text-xs text-fg-muted">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}

function ThemeToggle() {
  const theme = useResolvedTheme();
  return (
    <Button size="sm" variant="secondary" onClick={() => setThemeChoice(theme === "dark" ? "light" : "dark")}>
      {theme === "dark" ? "Switch to light" : "Switch to dark"}
    </Button>
  );
}

/* ---------------------------------------------------------------- Controls */

function Controls() {
  const [role, setRole] = useState<Role>("all");
  const [policy, setPolicy] = useState("Best attempt");
  const [chips, setChips] = useState({ a: false, b: true, c: true });
  const [tab, setTab] = useState("one");
  const [radio, setRadio] = useState("b");
  const noop = () => {};
  return (
    <Card className="space-y-6">
      <Group title="Button — variants × sizes">
        {SIZES.map((s) => (
          <Measure key={s} caption={`${s} primary`}>
            <Button size={s}>Save changes</Button>
          </Measure>
        ))}
        <Measure caption="md disabled">
          <Button disabled>Save changes</Button>
        </Measure>
        <Measure caption="md loading">
          <Button loading>Saving</Button>
        </Measure>
      </Group>
      {SIZES.map((s) => (
        <div key={s} className="flex flex-wrap items-center gap-2">
          <span className="w-8 font-mono text-[11px] text-fg-faint">{s}</span>
          {VARIANTS.map((v) => (
            <Button key={v} size={s} variant={v}>
              {v}
            </Button>
          ))}
        </div>
      ))}

      <Group title="Field — one scale, a pill">
        {SIZES.map((s) => (
          <Measure key={s} caption={`Field ${s}`}>
            <Field label="Email" size={s} placeholder="first.last@heig-vd.ch" width="w-56" />
          </Measure>
        ))}
        <Measure caption="Field disabled">
          <Field label="Email" disabled value="locked" readOnly width="w-40" />
        </Measure>
        <Measure caption="Field with unit">
          <Field label="Duration" suffix="min" defaultValue="45" className="text-right tabular-nums" width="w-32" />
        </Measure>
      </Group>
      <Group title="Select">
        {SIZES.map((s) => (
          <Measure key={s} caption={`Select ${s}`}>
            <Select label="Policy" size={s} width="w-44">
              <option>Best attempt</option>
            </Select>
          </Measure>
        ))}
        <Measure caption="Select disabled">
          <Select label="Policy" disabled width="w-44">
            <option>Best attempt</option>
          </Select>
        </Measure>
      </Group>
      <Group title="SearchInput — a Field with a leading icon">
        {SIZES.map((s) => (
          <Measure key={s} caption={`Search ${s}`}>
            <SearchInput size={s} className="w-56" placeholder="Search" aria-label="Search" />
          </Measure>
        ))}
      </Group>
      <Group title="Textarea (soft square: it holds lines)">
        <Measure caption="Textarea">
          <Textarea label="Notes" className="w-72" rows={2} />
        </Measure>
      </Group>

      <Group title="Segmented — md by default, sliding thumb (click to see it)">
        {SIZES.map((s) => (
          <Measure key={s} caption={s}>
            <Segmented name={`g-${s}`} label="Role" size={s} value={role} onChange={setRole} options={[...ROLES]} />
          </Measure>
        ))}
        <Measure caption="disabled">
          <Segmented name="g-dis" label="Role" disabled value={role} onChange={noop} options={[...ROLES]} />
        </Measure>
        <div className="w-72">
          <Measure caption="wrap, 6 options (track stays a soft square)">
            <Segmented name="g-wrap" label="Policy" wrap value={policy} onChange={setPolicy} options={POLICIES} />
          </Measure>
        </div>
      </Group>

      <Group title="ToggleChip — same scale">
        {SIZES.map((s) => (
          <Measure key={s} caption={s}>
            <ToggleChip size={s} label="Open" pressed={chips.b} onToggle={() => setChips({ ...chips, b: !chips.b })} />
          </Measure>
        ))}
        <Measure caption="off">
          <ToggleChip label="Draft" pressed={chips.a} onToggle={() => setChips({ ...chips, a: !chips.a })} />
        </Measure>
        <Measure caption="neutral on">
          <ToggleChip label="Closed" tone="neutral" pressed={chips.c} onToggle={() => setChips({ ...chips, c: !chips.c })} />
        </Measure>
        <Measure caption="disabled">
          <ToggleChip label="Locked" pressed={false} disabled onToggle={noop} />
        </Measure>
      </Group>

      <Group title="Tabs (navigation — not a form control)">
        <div className="w-80">
          <Measure caption="tab">
            <Tabs
              value={tab}
              onChange={setTab}
              items={[
                { value: "one", label: "Overview" },
                { value: "two", label: "Students", count: 24 },
                { value: "three", label: "Settings" },
              ]}
            />
          </Measure>
        </div>
      </Group>

      <Group title="RadioRow (a list of described choices)">
        <fieldset className="w-72 divide-y divide-line overflow-hidden rounded-field border border-line">
          {["a", "b", "c"].map((v) => (
            <RadioRow key={v} name="g-radio" value={v} checked={radio === v} onPick={setRadio}>
              Option {v.toUpperCase()}
            </RadioRow>
          ))}
        </fieldset>
      </Group>

      <Group title="Badges (status, not controls)">
        {(["green", "amber", "red", "zinc", "accent"] as const).map((tone) => (
          <Measure key={tone} caption={tone}>
            <Badge tone={tone}>{tone}</Badge>
          </Measure>
        ))}
      </Group>
    </Card>
  );
}

/* ----------------------------------------------------------- Compositions */

function Compositions() {
  const [role, setRole] = useState<Role>("all");
  const [rowRole, setRowRole] = useState<Role>("teachers");
  const [chip, setChip] = useState(true);

  return (
    <div className="grid gap-6">
      <Pane title="Admin Users toolbar — search + filter" note="Search md, Segmented md: one height, one shape">
        <Card className="flex flex-wrap items-center gap-3">
          <SearchInput className="w-72" aria-label="Search users" placeholder="Search users" />
          <Segmented name="c-users" label="Role" value={role} onChange={setRole} options={[...ROLES]} />
        </Card>
      </Pane>
      <Pane title="Admin Teachers card — field + button" note="Field and button: same height, same pill">
        <Card>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
            <Field label="Email" type="email" width="w-72" placeholder="first.last@heig-vd.ch" />
            <Button type="submit">Grant access</Button>
          </form>
        </Card>
      </Pane>
      <Pane title="Table row — the sm size" note="Everything 28 px, everything a pill">
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <span className="min-w-24 text-[13px] text-fg">Ada Lovelace</span>
          <Select size="sm" width="w-36" aria-label="Role">
            <option>Teacher</option>
          </Select>
          <Segmented name="c-row" size="sm" label="Role" value={rowRole} onChange={setRowRole} options={[...ROLES]} />
          <ToggleChip label="Active" pressed={chip} onToggle={() => setChip(!chip)} />
          <Button size="sm" variant="secondary">
            Edit
          </Button>
        </Card>
      </Pane>
    </div>
  );
}

export function ControlsGallery() {
  return (
    <div className="space-y-8" id="controls-gallery">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-fg">Form controls (ADR-094, #552)</h2>
          <p className="text-sm text-fg-muted">
            One scale (28 / 34 / 40 px), every single-line control a pill, measured in the browser. Theme toggle on the
            right.
          </p>
        </div>
        <ThemeToggle />
      </div>
      <section className="space-y-3" id="controls-scale">
        <SectionHeading title="Controls" />
        <Controls />
      </section>
      <section className="space-y-3" id="controls-compositions">
        <SectionHeading title="Compositions" />
        <Compositions />
      </section>
    </div>
  );
}
