import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../test/render";
import { Switch } from ".";

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
