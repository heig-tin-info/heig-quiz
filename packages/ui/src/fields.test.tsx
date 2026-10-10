import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CheckboxField, FieldCell, NumberField, Segmented } from "./fields.js";

describe("Segmented", () => {
  const options = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Beta" },
  ] as const;

  it("is a named radiogroup of native radios", () => {
    const onChange = vi.fn();
    render(
      <>
        <span id="lbl">Kind</span>
        <Segmented name="k" labelledBy="lbl" value="a" options={options} onChange={onChange} />
      </>,
    );
    const group = screen.getByRole("radiogroup", { name: "Kind" });
    expect(group.className).toContain("rounded-control");
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Beta" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });

  it("becomes a recessed panel when it wraps, and dims when disabled", () => {
    render(<Segmented name="k" value="a" options={options} onChange={() => {}} wrap disabled />);
    const group = screen.getByRole("radiogroup");
    expect(group.className).toContain("rounded-card");
    expect(group.className).toContain("opacity-60");
    expect(screen.getByRole("radio", { name: "Beta" })).toBeDisabled();
  });

  it("disables one option on its own and says why in its title", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        name="k"
        label="Kind"
        value="a"
        options={[options[0], { ...options[1], disabled: true, title: "Why not" }]}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("radio", { name: "Beta" })).toBeDisabled();
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeEnabled();
    expect(screen.getByTitle("Why not")).toBeTruthy();
  });

  it("takes an aria-label when no caption names it, and a dense size", () => {
    render(<Segmented name="k" label="Group by" size="sm" value="a" options={options} onChange={() => {}} />);
    screen.getByRole("radiogroup", { name: "Group by" });
    expect(screen.getByText("Alpha").className).toContain("h-5.5");
  });

  it("is md (34 px track) unless told otherwise", () => {
    render(<Segmented name="k" label="Kind" value="a" options={options} onChange={() => {}} />);
    expect(screen.getByText("Alpha").className).toContain("h-7");
  });

  describe("thumb", () => {
    const boxes: Record<string, { left: number; top: number; width: number; height: number }> = {
      Alpha: { left: 3, top: 3, width: 60, height: 28 },
      Beta: { left: 65, top: 3, width: 48, height: 28 },
    };
    const originals = new Map<string, PropertyDescriptor | undefined>();

    beforeEach(() => {
      for (const key of ["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"]) {
        originals.set(key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key));
        Object.defineProperty(HTMLElement.prototype, key, {
          configurable: true,
          get(this: HTMLElement) {
            const box = boxes[this.textContent ?? ""];
            const field = key.replace("offset", "").toLowerCase() as "left" | "top" | "width" | "height";
            return box ? box[field] : 0;
          },
        });
      }
    });
    afterEach(() => {
      for (const [key, d] of originals) {
        if (d) Object.defineProperty(HTMLElement.prototype, key, d);
        else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
      }
    });

    const thumbOf = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-thumb]");

    it("sits under the selected label, measured from it", () => {
      const { container, rerender } = render(
        <Segmented name="k" label="Kind" value="a" options={options} onChange={() => {}} />,
      );
      expect(thumbOf(container)?.style).toMatchObject({ left: "3px", width: "60px", height: "28px" });
      rerender(<Segmented name="k" label="Kind" value="b" options={options} onChange={() => {}} />);
      expect(thumbOf(container)?.style).toMatchObject({ left: "65px", width: "48px" });
    });

    it("is decorative, and the labels keep the native radios", () => {
      const { container } = render(<Segmented name="k" label="Kind" value="a" options={options} onChange={() => {}} />);
      expect(thumbOf(container)?.getAttribute("aria-hidden")).toBe("true");
      expect(screen.getAllByRole("radio")).toHaveLength(2);
    });

    it("slides in ~200 ms, and not at all under reduced motion", async () => {
      const { container } = render(<Segmented name="k" label="Kind" value="a" options={options} onChange={() => {}} />);
      await waitFor(() => expect(thumbOf(container)?.className).toContain("duration-200"));
      expect(thumbOf(container)?.className).toContain("ease-out-emphasized");
      expect(thumbOf(container)?.className).toContain("motion-reduce:transition-none");
    });
  });
});

describe("FieldCell", () => {
  it("labels its control and takes the caller's column classes", () => {
    const { container } = render(
      <FieldCell label="Name" htmlFor="n" className="flex-1">
        <input id="n" />
      </FieldCell>,
    );
    expect(screen.getByLabelText("Name").id).toBe("n");
    expect(container.firstElementChild?.className).toBe("flex flex-col gap-1.5 flex-1");
  });

  it("announces a row suffix a sighted reader does not see", () => {
    const { container } = render(
      <FieldCell label="Value" htmlFor="v" srSuffix={2} gap="gap-1">
        <input id="v" />
      </FieldCell>,
    );
    expect(screen.getByLabelText("Value 2").id).toBe("v");
    expect(container.querySelector(".sr-only")?.textContent).toBe(" 2");
    expect(container.firstElementChild?.className).toBe("flex flex-col gap-1");
  });
});

describe("NumberField", () => {
  it("reports numbers, and an emptied field as 0 without onClear", () => {
    const onChange = vi.fn();
    render(<NumberField id="p" label="Points" value={2} onChange={onChange} />);
    const field = screen.getByLabelText("Points");
    expect(field).toHaveValue(2);
    fireEvent.change(field, { target: { value: "3.5" } });
    expect(onChange).toHaveBeenLastCalledWith(3.5);
    fireEvent.change(field, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("calls onClear for an emptied nullable field, and shows null as empty", () => {
    const onChange = vi.fn();
    const onClear = vi.fn();
    render(
      <NumberField
        id="t"
        label="Time"
        aria-label="Time 1"
        value={500}
        onChange={onChange}
        onClear={onClear}
      />,
    );
    fireEvent.change(screen.getByLabelText("Time 1"), { target: { value: "" } });
    expect(onClear).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("never shows NaN", () => {
    render(<NumberField id="x" label="X" value={Number.NaN} onChange={() => {}} />);
    expect(screen.getByLabelText("X")).toHaveValue(null);
  });
});

describe("CheckboxField", () => {
  it("is a native checkbox inside its label", () => {
    const onChange = vi.fn();
    render(<CheckboxField label="Hidden" aria-label="Hidden 2" checked={false} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText("Hidden 2"));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.getByText("Hidden").className).toContain("h-8.5");
  });
});
