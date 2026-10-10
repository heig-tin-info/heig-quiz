/*
 * Controls gallery, mounted at the top of `/dev/ui`: the form controls of the
 * scale (ADR-094, issue #552) as the real components render them, each
 * specimen measured in the browser. Development only — App.tsx routes the page
 * behind `import.meta.env.DEV`, so none of this is in the production build.
 *
 * Section titles go through `t()` like the rest of the gallery; the specimen
 * captions are literal English (this page never ships).
 */
import { useState } from "react";

import type { ControlSize } from "@quiz/ui";

import { Row } from "../DevGallery";
import { useT } from "../i18n";
import { Button, Card, Field, SearchInput, Segmented, Select, Textarea, ToggleChip } from "../ui";
import { Measure } from "./Measure";

const SIZES: ControlSize[] = ["sm", "md", "lg"];
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
const noop = () => {};

function Buttons() {
  const t = useT();
  return (
    <Row title={t("dev.ui.ctlButtons")}>
      {SIZES.map((s) => (
        <Measure key={s} caption={`${s} primary`}>
          <Button size={s}>Save changes</Button>
        </Measure>
      ))}
      <Measure caption="md secondary">
        <Button variant="secondary">Cancel</Button>
      </Measure>
      <Measure caption="md disabled">
        <Button disabled>Save changes</Button>
      </Measure>
      <Measure caption="md loading">
        <Button loading>Saving</Button>
      </Measure>
    </Row>
  );
}

function Fields() {
  const t = useT();
  return (
    <Row title={t("dev.ui.ctlFields")}>
      {SIZES.map((s) => (
        <Measure key={s} caption={`Field ${s}`}>
          <Field label="Email" size={s} placeholder="first.last@heig-vd.ch" width="w-56" />
        </Measure>
      ))}
      <Measure caption="Field with unit">
        <Field label="Duration" suffix="min" defaultValue="45" className="text-right tabular-nums" width="w-32" />
      </Measure>
      <Measure caption="Field disabled">
        <Field label="Email" disabled value="locked" readOnly width="w-40" />
      </Measure>
      {SIZES.map((s) => (
        <Measure key={s} caption={`Select ${s}`}>
          <Select label="Policy" size={s} width="w-44">
            <option>Best attempt</option>
          </Select>
        </Measure>
      ))}
      {SIZES.map((s) => (
        <Measure key={s} caption={`Search ${s}`}>
          <SearchInput size={s} className="w-56" placeholder="Search" aria-label="Search" />
        </Measure>
      ))}
      <Measure caption="Textarea (soft square: it holds lines)">
        <Textarea label="Notes" className="w-72" rows={2} />
      </Measure>
    </Row>
  );
}

function SegmentedRow() {
  const t = useT();
  const [role, setRole] = useState<Role>("all");
  const [policy, setPolicy] = useState("Best attempt");
  return (
    <Row title={t("dev.ui.ctlSegmented")}>
      {SIZES.map((s) => (
        <Measure key={s} caption={s}>
          <Segmented name={`g-${s}`} label="Role" size={s} value={role} onChange={setRole} options={[...ROLES]} />
        </Measure>
      ))}
      <Measure caption="disabled">
        <Segmented name="g-dis" label="Role" disabled value={role} onChange={noop} options={[...ROLES]} />
      </Measure>
      <div className="w-72">
        <Measure caption="wrap, 6 options (the track stays a soft square)">
          <Segmented name="g-wrap" label="Policy" wrap value={policy} onChange={setPolicy} options={POLICIES} />
        </Measure>
      </div>
    </Row>
  );
}

function Chips() {
  const t = useT();
  const [on, setOn] = useState({ a: false, b: true, c: true });
  return (
    <Row title={t("dev.ui.ctlChips")}>
      {SIZES.map((s) => (
        <Measure key={s} caption={s}>
          <ToggleChip size={s} label="Open" pressed={on.b} onToggle={() => setOn({ ...on, b: !on.b })} />
        </Measure>
      ))}
      <Measure caption="off">
        <ToggleChip label="Draft" pressed={on.a} onToggle={() => setOn({ ...on, a: !on.a })} />
      </Measure>
      <Measure caption="neutral on">
        <ToggleChip label="Closed" tone="neutral" pressed={on.c} onToggle={() => setOn({ ...on, c: !on.c })} />
      </Measure>
      <Measure caption="disabled">
        <ToggleChip label="Locked" pressed={false} disabled onToggle={noop} />
      </Measure>
    </Row>
  );
}

function Compositions() {
  const t = useT();
  const [role, setRole] = useState<Role>("all");
  const [rowRole, setRowRole] = useState<Role>("teachers");
  const [chip, setChip] = useState(true);
  return (
    <Row title={t("dev.ui.ctlCompositions")}>
      <div className="grid w-full gap-4">
        <Card className="flex flex-wrap items-center gap-3">
          <SearchInput className="w-72" aria-label="Search users" placeholder="Search users" />
          <Segmented name="c-users" label="Role" value={role} onChange={setRole} options={[...ROLES]} />
        </Card>
        <Card>
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
            <Field label="Email" type="email" width="w-72" placeholder="first.last@heig-vd.ch" />
            <Button type="submit">Grant access</Button>
          </form>
        </Card>
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
      </div>
    </Row>
  );
}

export function ControlsGallery() {
  return (
    <div className="space-y-8" id="controls-gallery">
      <Buttons />
      <Fields />
      <SegmentedRow />
      <Chips />
      <Compositions />
    </div>
  );
}
