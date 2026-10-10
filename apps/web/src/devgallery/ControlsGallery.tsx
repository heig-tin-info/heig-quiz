/*
 * Controls gallery for the go/no-go of issue #552, mounted at the top of
 * `/dev/ui`: "Today" (the real components, measured) against "Proposed"
 * (gallery-local prototypes). Development only — App.tsx routes the page
 * behind `import.meta.env.DEV`, so none of this is in the production build.
 *
 * Like the rest of the gallery, the specimen labels are literal English (this
 * page never ships); only the two section headings go through `t()`.
 */
import { useState, type ReactNode } from "react";

import { useT } from "../i18n";
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
import { PButton, PChip, PField, PSearch, PSegmented, PSelect, type Scale } from "./ProtoControls";

const SIZES: Scale[] = ["sm", "md", "lg"];
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

/* ------------------------------------------------------------------ Today */

function Today() {
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

      <Group title="Field, Select, SearchInput">
        <Measure caption="Field md">
          <Field label="Email" placeholder="first.last@heig-vd.ch" width="w-56" />
        </Measure>
        <Measure caption="Field sm">
          <Field label="Email" size="sm" placeholder="first.last@heig-vd.ch" width="w-56" />
        </Measure>
        <Measure caption="Field disabled">
          <Field label="Email" disabled value="locked" readOnly width="w-40" />
        </Measure>
        <Measure caption="Select md">
          <Select label="Policy" width="w-44">
            <option>Best attempt</option>
          </Select>
        </Measure>
        <Measure caption="Select sm">
          <Select label="Policy" size="sm" width="w-44">
            <option>Best attempt</option>
          </Select>
        </Measure>
        <Measure caption="SearchInput md">
          <SearchInput className="w-56" placeholder="Search" aria-label="Search" />
        </Measure>
      </Group>
      <Group title="Textarea (soft square, stays)">
        <Measure caption="Textarea">
          <Textarea label="Notes" className="w-72" rows={2} />
        </Measure>
      </Group>

      <Group title="Segmented">
        <Measure caption="md">
          <Segmented name="t-md" label="Role" value={role} onChange={setRole} options={[...ROLES]} />
        </Measure>
        <Measure caption="sm">
          <Segmented name="t-sm" label="Role" size="sm" value={role} onChange={setRole} options={[...ROLES]} />
        </Measure>
        <Measure caption="disabled">
          <Segmented name="t-dis" label="Role" disabled value={role} onChange={noop} options={[...ROLES]} />
        </Measure>
        <div className="w-72">
          <Measure caption="wrap, 6 options">
            <Segmented name="t-wrap" label="Policy" wrap value={policy} onChange={setPolicy} options={POLICIES} />
          </Measure>
        </div>
      </Group>

      <Group title="ToggleChip">
        <Measure caption="off">
          <ToggleChip label="Draft" pressed={chips.a} onToggle={() => setChips({ ...chips, a: !chips.a })} />
        </Measure>
        <Measure caption="on">
          <ToggleChip label="Open" pressed={chips.b} onToggle={() => setChips({ ...chips, b: !chips.b })} />
        </Measure>
        <Measure caption="neutral on">
          <ToggleChip label="Closed" tone="neutral" pressed={chips.c} onToggle={() => setChips({ ...chips, c: !chips.c })} />
        </Measure>
        <Measure caption="disabled">
          <ToggleChip label="Locked" pressed={false} disabled onToggle={noop} />
        </Measure>
      </Group>

      <Group title="Tabs (navigation — unchanged by the proposal)">
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

      <Group title="RadioRow (absorbed by the proposal)">
        <fieldset className="w-72 divide-y divide-line overflow-hidden rounded-field border border-line">
          {["a", "b", "c"].map((v) => (
            <RadioRow key={v} name="t-radio" value={v} checked={radio === v} onPick={setRadio}>
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

/* --------------------------------------------------------------- Proposed */

function Proposed() {
  const [role, setRole] = useState<Role>("all");
  const [policy, setPolicy] = useState("Best attempt");
  const [chips, setChips] = useState({ a: false, b: true });
  const noop = () => {};
  return (
    <Card className="space-y-6">
      <p className="rounded-field bg-warning-soft px-3 py-2 text-xs text-warning">
        Prototypes, local to this gallery. Nothing here is used by a real screen.
      </p>
      <Group title="Button — same scale, unchanged shape">
        {SIZES.map((s) => (
          <Measure key={s} caption={`${s} primary`}>
            <PButton size={s}>Save changes</PButton>
          </Measure>
        ))}
      </Group>

      <Group title="Field, Select, Search — one scale, all pills">
        {SIZES.map((s) => (
          <Measure key={s} caption={`Field ${s}`}>
            <div className="w-56">
              <PField size={s} placeholder="first.last@heig-vd.ch" aria-label="Email" />
            </div>
          </Measure>
        ))}
        <Measure caption="Field disabled">
          <div className="w-40">
            <PField disabled readOnly value="locked" aria-label="Locked" />
          </div>
        </Measure>
        {SIZES.map((s) => (
          <Measure key={s} caption={`Select ${s}`}>
            <PSelect size={s} aria-label="Policy">
              <option>Best attempt</option>
            </PSelect>
          </Measure>
        ))}
        {SIZES.map((s) => (
          <Measure key={s} caption={`Search ${s}`}>
            <PSearch size={s} placeholder="Search" aria-label="Search" />
          </Measure>
        ))}
      </Group>
      <Group title="Textarea (soft square, unchanged)">
        <Measure caption="Textarea">
          <Textarea label="Notes" className="w-72" rows={2} />
        </Measure>
      </Group>

      <Group title="Segmented — md by default, sliding thumb (click to see it)">
        {SIZES.map((s) => (
          <Measure key={s} caption={s}>
            <PSegmented name={`p-${s}`} label="Role" size={s} value={role} onChange={setRole} options={[...ROLES]} />
          </Measure>
        ))}
        <Measure caption="disabled">
          <PSegmented name="p-dis" label="Role" disabled value={role} onChange={noop} options={[...ROLES]} />
        </Measure>
        <div className="w-72">
          <Measure caption="wrap, 6 options (track stays a soft square)">
            <PSegmented name="p-wrap" label="Policy" wrap value={policy} onChange={setPolicy} options={POLICIES} />
          </Measure>
        </div>
      </Group>

      <Group title="Chips — same scale">
        {SIZES.map((s) => (
          <Measure key={s} caption={s}>
            <PChip size={s} pressed={chips.b} onToggle={() => setChips({ ...chips, b: !chips.b })}>
              Open
            </PChip>
          </Measure>
        ))}
        <Measure caption="off">
          <PChip pressed={chips.a} onToggle={() => setChips({ ...chips, a: !chips.a })}>
            Draft
          </PChip>
        </Measure>
        <Measure caption="disabled">
          <PChip pressed={false} disabled onToggle={noop}>
            Locked
          </PChip>
        </Measure>
      </Group>

      <p className="text-xs text-fg-muted">
        Tabs and badges are unchanged (navigation and status, not form controls). RadioRow is absorbed — not
        prototyped here.
      </p>
    </Card>
  );
}

/* ----------------------------------------------------------- Compositions */

function Compositions() {
  const [todayRole, setTodayRole] = useState<Role>("all");
  const [propRole, setPropRole] = useState<Role>("all");
  const [email, setEmail] = useState("");
  const [rowRole, setRowRole] = useState<Role>("teachers");
  const [propRowRole, setPropRowRole] = useState<Role>("teachers");
  const [chip, setChip] = useState(true);
  const [propChip, setPropChip] = useState(true);

  return (
    <div className="space-y-6">
      <section className="space-y-3" id="cmp-users">
        <h3 className="text-sm font-semibold text-fg">Admin Users toolbar — search + filter</h3>
        <div className="grid gap-4">
          <Pane title="Today" note="SearchInput md pill, Segmented sm: 34 px next to 30 px">
            <Card className="flex flex-wrap items-center gap-3">
              <SearchInput className="w-72" aria-label="Search users" placeholder="Search users" />
              <Segmented name="c-users-t" size="sm" label="Role" value={todayRole} onChange={setTodayRole} options={[...ROLES]} />
            </Card>
          </Pane>
          <Pane title="Proposed" note="Search md, Segmented md: one height, one shape">
            <Card className="flex flex-wrap items-center gap-3">
              <PSearch className="w-72" aria-label="Search users" placeholder="Search users" />
              <PSegmented name="c-users-p" label="Role" value={propRole} onChange={setPropRole} options={[...ROLES]} />
            </Card>
          </Pane>
        </div>
      </section>

      <section className="space-y-3" id="cmp-teachers">
        <h3 className="text-sm font-semibold text-fg">Admin Teachers card — field + button</h3>
        <div className="grid gap-4">
          <Pane title="Today" note="Field is a 10 px soft square, the button a pill">
            <Card>
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
                <Field label="Email" type="email" className="w-72" placeholder="first.last@heig-vd.ch" />
                <Button type="submit">Grant access</Button>
              </form>
            </Card>
          </Pane>
          <Pane title="Proposed" note="Field and button: same height, same pill">
            <Card>
              <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
                <label className="flex w-72 flex-col gap-1.5">
                  <span className="flex items-center gap-1 text-[13px] font-medium text-fg">Email</span>
                  <PField
                    type="email"
                    placeholder="first.last@heig-vd.ch"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <PButton type="submit">Grant access</PButton>
              </form>
            </Card>
          </Pane>
        </div>
      </section>

      <section className="space-y-3" id="cmp-row">
        <h3 className="text-sm font-semibold text-fg">Table row — the sm size</h3>
        <div className="grid gap-4">
          <Pane title="Today" note="Select sm is a soft square beside pills">
            <Card className="flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-24 text-[13px] text-fg">Ada Lovelace</span>
              <Select size="sm" width="w-36" aria-label="Role">
                <option>Teacher</option>
              </Select>
              <Segmented name="c-row-t" size="sm" label="Role" value={rowRole} onChange={setRowRole} options={[...ROLES]} />
              <ToggleChip label="Active" pressed={chip} onToggle={() => setChip(!chip)} />
              <Button size="sm" variant="secondary">
                Edit
              </Button>
            </Card>
          </Pane>
          <Pane title="Proposed" note="Everything 28 px, everything a pill">
            <Card className="flex flex-wrap items-center gap-3 p-3">
              <span className="min-w-24 text-[13px] text-fg">Ada Lovelace</span>
              <PSelect size="sm" className="w-36" aria-label="Role">
                <option>Teacher</option>
              </PSelect>
              <PSegmented name="c-row-p" size="sm" label="Role" value={propRowRole} onChange={setPropRowRole} options={[...ROLES]} />
              <PChip size="sm" pressed={propChip} onToggle={() => setPropChip(!propChip)}>
                Active
              </PChip>
              <PButton size="sm" variant="secondary">
                Edit
              </PButton>
            </Card>
          </Pane>
        </div>
      </section>
    </div>
  );
}

export function ControlsGallery() {
  const t = useT();
  return (
    <div className="space-y-8" id="controls-gallery">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-fg">Form controls — go / no-go (#552)</h2>
          <p className="text-sm text-fg-muted">Today against the proposal, measured in the browser. Theme toggle on the right.</p>
        </div>
        <ThemeToggle />
      </div>
      <section className="space-y-3" id="controls-today">
        <SectionHeading title={t("dev.ui.controlsToday")} />
        <Today />
      </section>
      <section className="space-y-3" id="controls-proposed">
        <SectionHeading title={t("dev.ui.controlsProposed")} />
        <Proposed />
      </section>
      <section className="space-y-3" id="controls-compositions">
        <SectionHeading title="Compositions" />
        <Compositions />
      </section>
    </div>
  );
}
