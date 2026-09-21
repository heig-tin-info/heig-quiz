import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { renderWithProviders } from "./test/render";
import {
  Alert,
  Button,
  Countdown,
  EmptyState,
  Field,
  Menu,
  Modal,
  pressable,
  ProgressSegments,
  PageError,
  QueryError,
  RelativeTime,
  relativeTime,
  Ring,
  Segmented,
  Select,
  Sheet,
  Switch,
  SyncBadge,
  TabPanel,
  Tabs,
  Textarea,
  Tip,
  ToggleChip,
  VerdictCell,
  Z,
  type MenuItem,
  type Segment,
  type SyncState,
  type VerdictState,
} from "./ui";

/*
 * The behaviour of the primitives, not their pixels: what a keyboard reaches,
 * what a screen reader is told, what a click ends up calling. `buttonClass`,
 * `menuPosition` and `scrollEdges` keep their pure tests in ui.test.ts.
 */

describe("Button", () => {
  it("renders its label and the variant chrome", () => {
    renderWithProviders(
      <>
        <Button>Create classroom</Button>
        <Button variant="danger">Delete</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Create classroom" })).toHaveClass("bg-accent");
    expect(screen.getByRole("button", { name: "Delete" })).toHaveClass("bg-danger");
  });

  it("loading disables the button and shows the spinner", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Button loading onClick={onClick}>
        Publish
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Publish" });
    expect(button).toBeDisabled();
    expect(button.querySelector("svg.animate-spin")).not.toBeNull();
    await userEvent.click(button).catch(() => {
      // user-event refuses to click a disabled control; that is the point.
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("defaults to type=button, so a button in a form never submits it", async () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    renderWithProviders(
      <form onSubmit={onSubmit}>
        <Button>Add</Button>
      </form>,
    );
    const button = screen.getByRole("button", { name: "Add" });
    expect(button).toHaveAttribute("type", "button");
    await userEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("lets the caller ask for a submit button", () => {
    renderWithProviders(<Button type="submit">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute("type", "submit");
  });
});

/** Opens a layer from a real button, so the focus has somewhere to come back to. */
function LayerHarness({
  render: renderLayer,
}: {
  render: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? renderLayer(() => setOpen(false)) : null}
    </>
  );
}

describe("Modal", () => {
  const openModal = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Modal
            title="Archive PRG1 2026?"
            onClose={() => {
              onClose();
              close();
            }}
            footer={
              <>
                <Button variant="ghost">Cancel</Button>
                <Button>Archive</Button>
              </>
            }
          >
            The classroom disappears until you restore it.
          </Modal>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("renders in a portal, named by its own title", async () => {
    const { dialog } = await openModal();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Archive PRG1 2026?");
    // Portal: the panel is a child of <body>, not of the render container.
    expect(dialog.closest("[data-testid='container']")).toBeNull();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("closes on Escape", async () => {
    const { onClose } = await openModal();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a backdrop click (a stray click must not discard a form)", async () => {
    const { dialog, onClose } = await openModal();
    const backdrop = dialog.parentElement!;
    await userEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("moves the focus inside on open and back to the opener on close", async () => {
    const { dialog } = await openModal();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Close" }));
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("cycles the Tab order inside the panel", async () => {
    const { dialog } = await openModal();
    const stops = [
      within(dialog).getByRole("button", { name: "Close" }),
      within(dialog).getByRole("button", { name: "Cancel" }),
      within(dialog).getByRole("button", { name: "Archive" }),
    ];
    const last = stops[2]!;
    const first = stops[0]!;
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("keeps its clicks to itself: the row that opened it never hears them", async () => {
    const onRowClick = vi.fn();
    renderWithProviders(
      // The dialog is portalled out of this div in the DOM, but it is still
      // its child in the React tree, which is what carries the bubbling.
      <div onClick={onRowClick}>
        <LayerHarness
          render={(close) => (
            <Modal title="Adjust grade" onClose={close} footer={<Button>Save</Button>}>
              <Field label="Points" defaultValue="4.5" />
            </Modal>
          )}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    onRowClick.mockClear();
    await userEvent.click(screen.getByLabelText("Points"));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

/*
 * `useLayer` gives the focus back to whatever opened the layer, one frame
 * after the close. One frame, because the palette runs a command and unmounts
 * itself in the same tick, and the command may be "open the help drawer": the
 * question "did something else take the focus?" cannot be answered at cleanup
 * time, when the focused node has just been removed and the browser has
 * already parked the focus on <body>.
 */
describe("useLayer focus restore", () => {
  /** A layer that closes itself while opening another, the palette's shape. */
  function Relay() {
    const [first, setFirst] = useState(false);
    const [second, setSecond] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setFirst(true)}>
          Open first
        </button>
        {first ? (
          <Modal title="First" onClose={() => setFirst(false)}>
            <Button
              onClick={() => {
                setSecond(true);
                setFirst(false);
              }}
            >
              Relay
            </Button>
          </Modal>
        ) : null}
        {second ? (
          <Modal title="Second" onClose={() => setSecond(false)}>
            <p>Second panel</p>
          </Modal>
        ) : null}
      </>
    );
  }

  /** Past the deferred restore, which is one `requestAnimationFrame` away. */
  const afterTheFrame = () => act(() => new Promise((r) => setTimeout(r, 60)));

  it("leaves the focus to a layer that opened in the same tick", async () => {
    renderWithProviders(<Relay />);
    const trigger = screen.getByRole("button", { name: "Open first" });
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("button", { name: "Relay" }));

    const second = screen.getByRole("dialog", { name: "Second" });
    expect(second.contains(document.activeElement)).toBe(true);
    await afterTheFrame();
    // The restore of the first layer must not pull the reader back out to a
    // trigger sitting behind the panel they are now reading.
    expect(second.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  });

  it("still restores to the opener on an ordinary close", async () => {
    renderWithProviders(<Relay />);
    const trigger = screen.getByRole("button", { name: "Open first" });
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    // The focused node was inside the panel that just went away, so at that
    // point nothing else holds the focus and the trigger gets it back.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("Sheet", () => {
  const openSheet = async (onClose = vi.fn()) => {
    renderWithProviders(
      <LayerHarness
        render={(close) => (
          <Sheet
            title="New assignment"
            subtitle="Draft — nothing is published yet"
            onClose={() => {
              onClose();
              close();
            }}
            footer={<Button>Create assignment</Button>}
          >
            <label>
              Name
              <input />
            </label>
          </Sheet>
        )}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    return { dialog: screen.getByRole("dialog"), onClose };
  };

  it("is a named modal dialog in a portal, with its footer", async () => {
    const { dialog } = await openSheet();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("New assignment");
    expect(within(dialog).getByText("Draft — nothing is published yet")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create assignment" })).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
  });

  it("closes on Escape and hands the focus back to the opener", async () => {
    const { dialog, onClose } = await openSheet();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open" })),
    );
  });

  it("closes on its X button", async () => {
    const { dialog, onClose } = await openSheet();
    await userEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab inside the panel", async () => {
    const { dialog } = await openSheet();
    const close = within(dialog).getByRole("button", { name: "Close" });
    const create = within(dialog).getByRole("button", { name: "Create assignment" });
    create.focus();
    fireEvent.keyDown(create, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("keeps its clicks to itself, like the dialog", async () => {
    const onRowClick = vi.fn();
    renderWithProviders(
      <div onClick={onRowClick}>
        <LayerHarness
          render={(close) => (
            <Sheet title="Add students" onClose={close}>
              <Textarea label="Roster CSV" defaultValue="" />
            </Sheet>
          )}
        />
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    onRowClick.mockClear();
    await userEvent.click(screen.getByLabelText("Roster CSV"));
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

describe("Menu", () => {
  const items = (onSelect: () => void): MenuItem[] => [
    { label: "Clone script", onSelect },
    { label: "Export", disabled: true },
    { label: "Documentation", href: "https://example.org/docs" },
    { label: "Delete", danger: true, separator: true, onSelect: () => {} },
  ];

  const renderMenu = (onSelect = vi.fn()) => {
    renderWithProviders(<Menu label="Assignment actions" items={items(onSelect)} />);
    return { trigger: screen.getByRole("button", { name: "Assignment actions" }), onSelect };
  };

  it("announces itself as a menu button and opens on click", async () => {
    const { trigger } = renderMenu();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = screen.getByRole("menu", { name: "Assignment actions" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(4);
  });

  it("opens on ArrowDown with the first item focused, and wraps with the arrows", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Clone script" }));
    // "Export" is disabled: the arrows step over it.
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Documentation" }),
    );
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
    await userEvent.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitem", { name: "Clone script" }),
    );
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(within(menu).getByRole("menuitem", { name: "Delete" }));
  });

  it("opens on ArrowUp with the last item focused", async () => {
    const { trigger } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(
      within(screen.getByRole("menu")).getByRole("menuitem", { name: "Delete" }),
    );
  });

  it("selects with Enter, then closes and restores the focus", async () => {
    const { trigger, onSelect } = renderMenu();
    trigger.focus();
    await userEvent.keyboard("{ArrowDown}");
    await userEvent.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Escape and restores the focus", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on an outside click", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders an href item as a link and a disabled item as disabled", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    const menu = screen.getByRole("menu");
    const link = within(menu).getByRole("menuitem", { name: "Documentation" });
    expect(link.tagName).toBe("A");
    expect(link).toHaveAttribute("href", "https://example.org/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(within(menu).getByRole("menuitem", { name: "Export" })).toBeDisabled();
  });

  it("stacks its panel above the dialog layer, not under it", async () => {
    const { trigger } = renderMenu();
    await userEvent.click(trigger);
    // The account menu opens from inside the mobile drawer, which is a z-50
    // layer: a popover below that is simply invisible.
    expect(screen.getByRole("menu")).toHaveClass(Z.popover);
    expect(Number(Z.popover.replace("z-", ""))).toBeGreaterThan(
      Number(Z.modal.replace("z-", "")),
    );
    expect(Number(Z.popover.replace("z-", ""))).toBeLessThan(
      Number(Z.overlay.replace("z-", "")),
    );
  });

  it("carries a description as a second line under the label", async () => {
    renderWithProviders(
      <Menu
        label="Assignment actions"
        items={[
          {
            label: "Clone script",
            description: "Clones every student repository into one folder",
          },
        ]}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Assignment actions" }));
    const item = within(screen.getByRole("menu")).getByRole("menuitem", {
      name: /Clone script/,
    });
    expect(
      within(item).getByText("Clones every student repository into one folder"),
    ).toBeVisible();
  });
});

type DemoTab = "assignments" | "students" | "staff";

function TabsHarness({ onChange }: { onChange: (v: DemoTab) => void }) {
  const [value, setValue] = useState<DemoTab>("assignments");
  return (
    <>
      <Tabs
        value={value}
        onChange={(v) => {
          setValue(v);
          onChange(v);
        }}
        idPrefix="classroom"
        label="Classroom sections"
        items={[
          { value: "assignments", label: "Assignments" },
          { value: "students", label: "Students", count: 24 },
          { value: "staff", label: "Staff" },
        ]}
      />
      <TabPanel idPrefix="classroom" value={value}>
        {value}
      </TabPanel>
    </>
  );
}

describe("Tabs", () => {
  it("keeps one tab in the Tab order (roving tabindex)", () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("tab", { name: /Assignments/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("selects the next tab on ArrowRight and wraps on the last one", async () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute("aria-selected", "true");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: /Students/ }));
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    fireEvent.keyDown(tablist, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("jumps to the ends with Home and End", () => {
    const onChange = vi.fn();
    renderWithProviders(<TabsHarness onChange={onChange} />);
    const tablist = screen.getByRole("tablist", { name: "Classroom sections" });
    fireEvent.keyDown(tablist, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith("staff");
    fireEvent.keyDown(tablist, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith("assignments");
  });

  it("keeps the strip reachable when the value matches no tab", () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Tabs
        value={"nonsense" as DemoTab}
        onChange={onChange}
        label="Classroom sections"
        items={[
          { value: "assignments", label: "Assignments" },
          { value: "students", label: "Students" },
        ]}
      />,
    );
    // No tab is selected, but the first one still holds the Tab order,
    // otherwise a hand-edited ?tab= takes the whole strip off the keyboard.
    expect(screen.getByRole("tab", { name: "Assignments" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "Assignments" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    fireEvent.keyDown(screen.getByRole("tablist", { name: "Classroom sections" }), {
      key: "ArrowRight",
    });
    expect(onChange).toHaveBeenLastCalledWith("students");
  });

  /*
   * W2: `aria-controls` is a promise. Only one panel is rendered at a time,
   * so only the SELECTED tab may name one; the others named ids no element
   * carried, which axe reports as an invalid attribute value and a reader
   * follows into nothing.
   */
  it("points the selected tab at a panel that exists, and the others at nothing", async () => {
    renderWithProviders(<TabsHarness onChange={vi.fn()} />);
    const selected = screen.getByRole("tab", { name: /Assignments/ });
    expect(selected).toHaveAttribute("id", "classroom-tab-assignments");
    expect(selected).toHaveAttribute("aria-controls", "classroom-panel-assignments");
    const panel = screen.getByRole("tabpanel");
    expect(panel).toHaveAttribute("id", "classroom-panel-assignments");
    expect(panel).toHaveAttribute("aria-labelledby", "classroom-tab-assignments");

    const other = screen.getByRole("tab", { name: /Students/ });
    expect(other).toHaveAttribute("id", "classroom-tab-students");
    expect(other).not.toHaveAttribute("aria-controls");

    // And the wiring follows the selection.
    await userEvent.click(other);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "classroom-panel-students");
    expect(screen.getByRole("tab", { name: /Students/ })).toHaveAttribute(
      "aria-controls",
      "classroom-panel-students",
    );
  });
});

describe("Segmented", () => {
  it("is a radiogroup of real radios and reports the change", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Segmented
        name="classrooms-view"
        value="cards"
        onChange={onChange}
        options={[
          { value: "cards", label: "Card view" },
          { value: "list", label: "List view" },
        ]}
      />,
    );
    const group = screen.getByRole("radiogroup");
    expect(within(group).getAllByRole("radio")).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Card view" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "List view" }));
    expect(onChange).toHaveBeenCalledWith("list");
  });
});

describe("ToggleChip", () => {
  it("is a pressed-or-not button, and says which it is", async () => {
    const onToggle = vi.fn();
    renderWithProviders(
      <>
        <ToggleChip label="Multiple choice" pressed={false} onToggle={onToggle} />
        <ToggleChip label="Short answer" pressed onToggle={vi.fn()} />
      </>,
    );
    const off = screen.getByRole("button", { name: "Multiple choice" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Short answer" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.click(off);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("takes a name when the visible label is a bare number", () => {
    renderWithProviders(
      <ToggleChip label={3} aria-label="Difficulty 3 of 5" pressed={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByRole("button", { name: "Difficulty 3 of 5" })).toBeInTheDocument();
  });

  it("drops aria-pressed for the one pill that is an action", () => {
    renderWithProviders(<ToggleChip label="Show all (37)" onToggle={vi.fn()} />);
    // Announcing an action as an unpressed toggle promises a state it has not.
    expect(screen.getByRole("button", { name: "Show all (37)" })).not.toHaveAttribute(
      "aria-pressed",
    );
  });
});

function SwitchHarness({ onChange }: { onChange: (v: boolean) => void }) {
  const [on, setOn] = useState(false);
  return (
    <Switch
      label="E-mail notifications"
      checked={on}
      onChange={(v) => {
        setOn(v);
        onChange(v);
      }}
    />
  );
}

describe("Switch", () => {
  it("exposes its state and toggles on click", async () => {
    const onChange = vi.fn();
    renderWithProviders(<SwitchHarness onChange={onChange} />);
    const toggle = screen.getByRole("switch", { name: "E-mail notifications" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe("Field and Select", () => {
  it("binds the label to the control and types into it", async () => {
    renderWithProviders(<Field label="Classroom name" defaultValue="" />);
    const input = screen.getByLabelText("Classroom name");
    await userEvent.type(input, "PRG1");
    expect(input).toHaveValue("PRG1");
  });

  it("puts the height on the control and the width on the wrapper", () => {
    renderWithProviders(
      <>
        <Field label="Default" />
        <Field label="Dense" size="sm" width="w-32" />
        <Field label="Stretched" fullWidth />
      </>,
    );
    // The wrapper is a plain div: a <label> around the control would swallow
    // the help button, so the label points at the control with htmlFor.
    const byLabel = (label: string) => screen.getByLabelText(label);
    expect(byLabel("Default")).toHaveClass("h-8.5");
    expect(byLabel("Default").parentElement).toHaveClass("w-52");
    expect(byLabel("Dense")).toHaveClass("h-7");
    expect(byLabel("Dense").parentElement).toHaveClass("w-32");
    expect(byLabel("Stretched").parentElement).toHaveClass("w-full");
  });

  it("labels a Select and carries its width on the control wrapper", async () => {
    const onChange = vi.fn();
    renderWithProviders(
      <Select label="GitHub organization" width="w-40" value="" onChange={onChange}>
        <option value="">Pick an organization</option>
        <option value="heig-prg1-2026">heig-prg1-2026</option>
      </Select>,
    );
    const select = screen.getByLabelText("GitHub organization");
    expect(select.parentElement).toHaveClass("w-40");
    expect(select).toHaveClass("h-8.5");
    await userEvent.selectOptions(select, "heig-prg1-2026");
    expect(onChange).toHaveBeenCalled();
  });
});

describe("Field help", () => {
  it("names the control even next to a help button, which stays its own button", async () => {
    renderWithProviders(
      <>
        <Field label="Classroom name" help="classrooms" defaultValue="" />
        <Select label="Source repository" help="assignment-source" defaultValue="">
          <option value="">Pick one</option>
          <option value="labo-02">labo-02</option>
        </Select>
        <Textarea label="Roster CSV" help="import-roster" defaultValue="" />
      </>,
    );
    // A <label> wrapping the "?" would make that button the labelled control
    // and leave the real ones nameless.
    expect(screen.getByLabelText("Classroom name").tagName).toBe("INPUT");
    expect(screen.getByLabelText("Source repository").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Roster CSV").tagName).toBe("TEXTAREA");
    expect(screen.getAllByRole("button", { name: "Help" })).toHaveLength(3);
    // Clicking the label text lands on the input, not on the help drawer.
    await userEvent.click(screen.getByText("Classroom name"));
    expect(document.activeElement).toBe(screen.getByLabelText("Classroom name"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("pressable", () => {
  it("activates on Enter and on Space, and Space does not scroll the page", () => {
    const onActivate = vi.fn();
    renderWithProviders(
      <div {...pressable(onActivate)} onClick={onActivate}>
        PRG1 2026
      </div>,
    );
    const card = screen.getByRole("button", { name: "PRG1 2026" });
    expect(card).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onActivate).toHaveBeenCalledTimes(1);
    const space = fireEvent.keyDown(card, { key: " " });
    expect(onActivate).toHaveBeenCalledTimes(2);
    // fireEvent returns false when the handler called preventDefault.
    expect(space).toBe(false);
  });

  it("leaves the role alone for a row, which must stay a row", () => {
    expect(pressable(() => {}, "row").role).toBe("row");
  });
});

describe("Alert", () => {
  it("renders its title, its body and its one action", async () => {
    const onClick = vi.fn();
    renderWithProviders(
      <Alert
        tone="warning"
        title="This organization is on the GitHub Free plan"
        action={<Button onClick={onClick}>Request the upgrade</Button>}
      >
        Private repositories get no branch protection.
      </Alert>,
    );
    const alert = screen.getByRole("status");
    expect(within(alert).getByText("This organization is on the GitHub Free plan")).toBeVisible();
    expect(within(alert).getByText(/no branch protection/)).toBeVisible();
    await userEvent.click(within(alert).getByRole("button", { name: "Request the upgrade" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe("QueryError", () => {
  it("shows the server's own message and retries on demand", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(503, { message: "GitHub is unavailable" })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText("Could not load your classrooms")).toBeVisible();
    expect(screen.getByText("GitHub is unavailable")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // W9: the default is the TRANSLATED `error.server`, not an English literal.
  it("falls back when the failure carries no message", () => {
    renderWithProviders(<QueryError title="Could not load this classroom" error={new Error("x")} />);
    expect(screen.getByText("The server did not answer. Try again in a moment.")).toBeVisible();
    // No retry handler: no Retry button either.
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("uses the caller's fallback (student surfaces pass a translated one)", () => {
    renderWithProviders(
      <QueryError
        title="Could not load your classrooms"
        error={new ApiError(500, null)}
        fallback="Le serveur n'a pas répondu."
      />,
    );
    expect(screen.getByText("Le serveur n'a pas répondu.")).toBeVisible();
  });

  it("disables Retry while the refetch is in flight", () => {
    renderWithProviders(
      <QueryError title="Could not load" error={new Error("x")} onRetry={vi.fn()} retrying />,
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeDisabled();
  });
});

/*
 * W3: a query that fails and takes the page with it still has to leave the
 * document a heading. `QueryError` returned on its own left a route whose
 * `document.querySelectorAll("h1").length` was 0 — nothing for a screen
 * reader to land on, and no way to tell which page had failed.
 */
describe("PageError", () => {
  it("keeps the page's heading above the alert", () => {
    renderWithProviders(<PageError title="Pool not found" error={new Error("x")} />);
    expect(screen.getByRole("heading", { level: 1, name: "Pool not found" })).toBeVisible();
    expect(screen.getByText("Something went wrong")).toBeVisible();
    expect(screen.getByText(/The server did not answer/)).toBeVisible();
  });

  it("offers the retry it was given", async () => {
    const onRetry = vi.fn();
    renderWithProviders(
      <PageError title="Pool not found" error={new Error("x")} onRetry={onRetry} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("EmptyState", () => {
  it("carries the one action of the surface", async () => {
    const onClick = vi.fn();
    const Icon = () => <svg aria-hidden />;
    renderWithProviders(
      <EmptyState
        icon={Icon}
        title="No classrooms"
        action={<Button onClick={onClick}>Create classroom</Button>}
      >
        Create your first classroom to distribute assignments.
      </EmptyState>,
    );
    expect(screen.getByText("No classrooms")).toBeVisible();
    // A `p` by default: an empty state inside a populated page must not
    // invent a heading level (W4).
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText(/distribute assignments/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Create classroom" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  /*
   * W4: the closed player is an empty state and nothing else. A page with no
   * heading of any level has no outline at all, so this one carries the h1.
   */
  it("becomes the page's heading when it IS the page", () => {
    const Icon = () => <svg aria-hidden />;
    renderWithProviders(<EmptyState icon={Icon} title="Time is up" titleAs="h1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Time is up" })).toBeVisible();
  });
});

describe("Tip", () => {
  it("appears after the delay on hover and leaves on Escape", () => {
    vi.useFakeTimers();
    renderWithProviders(
      <Tip label="Lock repository (block pushes)">
        <button type="button">Lock</button>
      </Tip>,
    );
    const anchor = screen.getByRole("button", { name: "Lock" }).parentElement!;
    fireEvent.mouseEnter(anchor);
    // Nothing yet: the bubble waits 120 ms, so brushing past a row is silent.
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.getByText("Lock repository (block pushes)")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Lock repository (block pushes)")).toBeNull();
  });

  it("renders the child untouched when there is no label", () => {
    renderWithProviders(
      <Tip label={null}>
        <button type="button">Lock</button>
      </Tip>,
    );
    const button = screen.getByRole("button", { name: "Lock" });
    expect(button.parentElement).not.toHaveClass("inline-flex");
  });
});

/*
 * The five live primitives (PLAN-MVP §6.4). What is asserted of each is the
 * same triple: it renders, a screen reader is told the state in words, and
 * the state variants differ by more than their tint.
 */

describe("Countdown", () => {
  const now = 1_700_000_000_000;

  it("shows the time left, tabular, and names it for a reader", () => {
    renderWithProviders(<Countdown deadlineAt={now + 872_000} now={now} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("14:32");
    expect(timer).toHaveClass("tabular-nums");
    expect(timer).toHaveAccessibleName("14:32 remaining");
  });

  it("stays neutral above the threshold and turns warning under it", () => {
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} warnUnderS={300} />,
    );
    expect(screen.getByRole("timer")).toHaveClass("text-fg");
    rerender(<Countdown deadlineAt={now + 240_000} now={now} warnUnderS={300} />);
    expect(screen.getByRole("timer")).toHaveClass("text-warning");
  });

  it("turns danger under a minute even when the threshold is lower", () => {
    renderWithProviders(<Countdown deadlineAt={now + 30_000} now={now} warnUnderS={20} />);
    expect(screen.getByRole("timer")).toHaveClass("text-danger");
  });

  it("announces the phase once when it is crossed, not every tick", async () => {
    const live = () => document.querySelector('[aria-live="polite"]')!;
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} warnUnderS={300} />,
    );
    expect(live()).toHaveTextContent("");
    rerender(<Countdown deadlineAt={now + 240_000} now={now} warnUnderS={300} />);
    await waitFor(() => expect(live()).toHaveTextContent("4:00 remaining."));
    // One more second inside the same phase must not re-announce.
    rerender(<Countdown deadlineAt={now + 239_000} now={now} warnUnderS={300} />);
    expect(live()).toHaveTextContent("4:00 remaining.");
  });

  it("says the time is up rather than counting into the negative", () => {
    renderWithProviders(<Countdown deadlineAt={now - 5_000} now={now} />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("0:00");
    expect(timer).toHaveAccessibleName("Time is up.");
  });

  it("speaks French when the locale does (N-I18N-01)", () => {
    renderWithProviders(<Countdown deadlineAt={now + 60_001} now={now} />, { locale: "fr" });
    expect(screen.getByRole("timer")).toHaveAccessibleName("il reste 1:01");
  });

  /*
   * W16: a paused evaluation is not spending its window. The digits froze at
   * the moment of the pause and say so; the server's clock keeps ticking
   * underneath, which is exactly what must not show.
   */
  it("freezes while paused and says it is paused", () => {
    const { rerender } = renderWithProviders(
      <Countdown deadlineAt={now + 600_000} now={now} paused={false} />,
    );
    expect(screen.getByRole("timer")).toHaveTextContent("10:00");

    rerender(<Countdown deadlineAt={now + 600_000} now={now} paused />);
    rerender(<Countdown deadlineAt={now + 600_000} now={now + 7_000} paused />);
    const timer = screen.getByRole("timer");
    expect(timer).toHaveTextContent("10:00");
    expect(timer).toHaveTextContent("paused");
    expect(timer).toHaveAccessibleName("10:00 remaining, paused");
    // Frozen, so it is not urgent either: no warning or danger tone.
    expect(timer).toHaveClass("text-fg-muted");

    // Resuming picks the real clock back up.
    rerender(<Countdown deadlineAt={now + 600_000} now={now + 7_000} paused={false} />);
    expect(screen.getByRole("timer")).toHaveTextContent("9:53");
  });
});

describe("Ring", () => {
  it("is a named figure whose middle is hidden from the reader", () => {
    renderWithProviders(
      <Ring value={18} max={24} label="18 of 24 students present">
        <span>75%</span>
      </Ring>,
    );
    const ring = screen.getByRole("img", { name: "18 of 24 students present" });
    expect(ring.querySelector("svg")).toHaveAttribute("aria-hidden");
    expect(screen.getByText("75%").closest("[aria-hidden]")).not.toBeNull();
  });

  it("draws the arc in proportion, and the whole circle when full", () => {
    const dash = (value: number, max: number) => {
      const { container, unmount } = renderWithProviders(
        <Ring value={value} max={max} size={100} thickness={10} label="ring" />,
      );
      const arc = container.querySelectorAll("circle")[1]!;
      const [drawn, total] = arc.getAttribute("stroke-dasharray")!.split(" ").map(Number);
      unmount();
      return (drawn! / total!).toFixed(3);
    };
    expect(dash(0, 24)).toBe("0.000");
    expect(dash(12, 24)).toBe("0.500");
    expect(dash(24, 24)).toBe("1.000");
  });

  it("survives a zero and an out-of-range value rather than drawing NaN", () => {
    const { container } = renderWithProviders(<Ring value={5} max={0} size={100} label="ring" />);
    const arc = container.querySelectorAll("circle")[1]!;
    expect(arc.getAttribute("stroke-dasharray")).not.toContain("NaN");
  });

  it("takes the accent-free stroke of DESIGN.md, not a red one", () => {
    const { container } = renderWithProviders(<Ring value={1} max={2} label="ring" />);
    expect(container.querySelectorAll("circle")[1]).toHaveClass("stroke-fg");
  });
});

describe("ProgressSegments", () => {
  const segments: Segment[] = [
    { id: "q1", state: "done" },
    { id: "q2", state: "answered" },
    { id: "q3", state: "current" },
    { id: "q4", state: "empty" },
  ];

  it("names every segment with its number and its state in words", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    expect(screen.getByRole("navigation", { name: "Progress" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question 1, done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question 2, opened, not marked done" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Question 4, not opened" })).toBeInTheDocument();
  });

  it("marks the current one and gives it the only tab stop", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    const current = screen.getByRole("button", { name: "Question 3, current" });
    expect(current).toHaveAttribute("aria-current", "true");
    const stops = screen.getAllByRole("button").filter((b) => b.tabIndex === 0);
    expect(stops).toEqual([current]);
  });

  it("gives each state its own bar, not just its own tint", () => {
    const { container } = renderWithProviders(
      <ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const bars = Array.from(container.querySelectorAll("button > span:first-child"));
    expect(bars[0]).toHaveClass("bg-fg");
    expect(bars[1]).toHaveClass("bg-line-strong");
    expect(bars[2]).toHaveClass("bg-accent", "h-2");
    expect(bars[3]).toHaveClass("bg-surface-3");
  });

  it("moves with the arrows, wraps, and jumps with Home and End", async () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />);
    const at = (n: number) => screen.getByRole("button", { name: new RegExp(`^Question ${n},`) });
    at(3).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(at(1)).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(at(4)).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(at(1)).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(at(4)).toHaveFocus();
  });

  it("hands the caller the id and the index it clicked", async () => {
    const onSelect = vi.fn();
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" onSelect={onSelect} />);
    await userEvent.click(screen.getByRole("button", { name: "Question 2, opened, not marked done" }));
    expect(onSelect).toHaveBeenCalledWith("q2", 1);
  });

  it("is a read-only indicator when navigation is locked", () => {
    renderWithProviders(<ProgressSegments segments={segments} label="Progress" />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
  });

  it("prints every number while the bars have the room for one", () => {
    const { container } = renderWithProviders(
      <ProgressSegments segments={segments} label="Progress" onSelect={() => {}} />,
    );
    const numbers = Array.from(container.querySelectorAll("button > span:last-child")).map(
      (s) => s.textContent,
    );
    expect(numbers).toEqual(["1", "2", "3", "4"]);
  });

  it("thins the numbers down to anchors when the segments get too narrow", () => {
    // jsdom runs no layout, so the strip is asked for its width directly.
    // 800 px over 40 segments is ~16 px each: numbers every fifth.
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    try {
      const many: Segment[] = Array.from({ length: 40 }, (_, i) => ({
        id: `q${i + 1}`,
        state: i === 6 ? "current" : i < 6 ? "done" : "empty",
      }));
      const { container } = renderWithProviders(
        <ProgressSegments segments={many} label="Progress" onSelect={() => {}} />,
      );
      const numbers = Array.from(container.querySelectorAll("button > span:last-child"))
        .map((s) => s.textContent)
        .filter(Boolean);
      // First, last, the current one, and every fifth in between.
      expect(numbers).toEqual(["1", "5", "7", "10", "15", "20", "25", "30", "35", "40"]);
      // The strip still names all forty of them for a screen reader.
      expect(screen.getAllByRole("button")).toHaveLength(40);
      expect(screen.getByRole("button", { name: "Question 23, not opened" })).toBeInTheDocument();
    } finally {
      width.mockRestore();
    }
  });
});

describe("VerdictCell", () => {
  const states: VerdictState[] = [
    "blank",
    "inProgress",
    "answered",
    "done",
    "correct",
    "partial",
    "wrong",
    "pending",
  ];

  it("carries an icon and a word in every one of its states", () => {
    for (const state of states) {
      const { container, unmount } = renderWithProviders(<VerdictCell state={state} />);
      expect(container.querySelector("svg")).not.toBeNull();
      expect(container.textContent?.trim()).not.toBe("");
      unmount();
    }
  });

  it("names the state for a reader and shows the answer for everyone else", () => {
    renderWithProviders(<VerdictCell state="correct" value="NULL" />);
    expect(screen.getByText("Correct")).toHaveClass("sr-only");
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("separates correct, partial and wrong by icon, not only by tint", () => {
    const paths = (state: VerdictState) => {
      const { container, unmount } = renderWithProviders(<VerdictCell state={state} />);
      const d = container.querySelector("svg")!.innerHTML;
      unmount();
      return d;
    };
    const [ok, partial, bad] = [paths("correct"), paths("partial"), paths("wrong")];
    expect(new Set([ok, partial, bad]).size).toBe(3);
  });

  it("becomes a real button when the dashboard can inspect it", async () => {
    const onClick = vi.fn();
    renderWithProviders(<VerdictCell state="partial" value="2/3" onClick={onClick} label="Nadia, question 5: partly correct" />);
    const cell = screen.getByRole("button", { name: "Nadia, question 5: partly correct" });
    await userEvent.click(cell);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("speaks French when the locale does", () => {
    renderWithProviders(<VerdictCell state="wrong" />, { locale: "fr" });
    expect(screen.getByText("Faux")).toBeInTheDocument();
  });
});

describe("SyncBadge", () => {
  const states: SyncState[] = ["saved", "saving", "offline", "closed"];

  it("is a polite status with an icon and a word in every state", () => {
    for (const state of states) {
      const { container, unmount } = renderWithProviders(<SyncBadge state={state} />);
      const badge = screen.getByRole("status");
      expect(badge).toHaveAttribute("aria-live", "polite");
      expect(container.querySelector("svg")).not.toBeNull();
      expect(badge.textContent?.trim()).not.toBe("");
      unmount();
    }
  });

  it("reads the four states out", () => {
    renderWithProviders(
      <>
        <SyncBadge state="saved" />
        <SyncBadge state="saving" />
        <SyncBadge state="offline" />
        <SyncBadge state="closed" />
      </>,
    );
    for (const word of ["Saved", "Saving…", "Offline", "Closed"]) {
      expect(screen.getAllByText(word).length).toBeGreaterThan(0);
    }
  });

  it("spins only while it is saving", () => {
    const { container, rerender } = renderWithProviders(<SyncBadge state="saving" />);
    expect(container.querySelector("svg")).toHaveClass("animate-spin");
    rerender(<SyncBadge state="saved" />);
    expect(container.querySelector("svg")).not.toHaveClass("animate-spin");
  });

  it("warns without shouting when the connection went away", () => {
    renderWithProviders(<SyncBadge state="offline" />);
    expect(screen.getByRole("status")).toHaveClass("text-warning");
  });

  it("speaks French when the locale does", () => {
    renderWithProviders(<SyncBadge state="offline" />, { locale: "fr" });
    expect(screen.getAllByText("Hors ligne").length).toBeGreaterThan(0);
  });
});

/*
 * A date written as a distance. The helper is pure and takes its clock, its
 * locale and the one word `Intl` has no format for, so both languages and
 * both directions are one call each.
 */
describe("relativeTime", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");
  const at = (offsetMs: number) => new Date(now + offsetMs).toISOString();
  const t = ((key: string) => (key === "time.now" ? "just now" : key)) as (
    key: "time.now",
  ) => string;
  const tf = ((key: string) => (key === "time.now" ? "à l'instant" : key)) as (
    key: "time.now",
  ) => string;

  it("says the word Intl has none for, in either language", () => {
    expect(relativeTime(at(0), now, "en", t)).toBe("just now");
    expect(relativeTime(at(-20_000), now, "en", t)).toBe("just now");
    expect(relativeTime(at(30_000), now, "fr", tf)).toBe("à l'instant");
  });

  it("looks backwards with the largest unit that is not zero", () => {
    expect(relativeTime(at(-5 * 60_000), now, "en", t)).toBe("5 minutes ago");
    expect(relativeTime(at(-3 * 3_600_000), now, "en", t)).toBe("3 hours ago");
    expect(relativeTime(at(-2 * 86_400_000), now, "en", t)).toBe("2 days ago");
    expect(relativeTime(at(-400 * 86_400_000), now, "en", t)).toBe("last year");
  });

  it("looks forwards too", () => {
    expect(relativeTime(at(10 * 60_000), now, "en", t)).toBe("in 10 minutes");
    expect(relativeTime(at(3 * 86_400_000), now, "en", t)).toBe("in 3 days");
  });

  it("speaks French when the locale does", () => {
    expect(relativeTime(at(-5 * 60_000), now, "fr", tf)).toBe("il y a 5 minutes");
    expect(relativeTime(at(2 * 3_600_000), now, "fr", tf)).toBe("dans 2 heures");
  });
});

describe("RelativeTime", () => {
  it("writes the distance, keeps the stamp machine-readable, and is reachable", () => {
    const iso = new Date(Date.now() - 2 * 3_600_000).toISOString();
    renderWithProviders(<RelativeTime iso={iso} />);
    const time = screen.getByText("2 hours ago");
    expect(time).toHaveAttribute("datetime", iso);
    // Focusable, because the exact stamp lives in a Tip and a tooltip nobody
    // can reach is a tooltip that is not there.
    expect(time).toHaveAttribute("tabindex", "0");
  });
});
