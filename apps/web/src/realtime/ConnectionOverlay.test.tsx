import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEffect, useState } from "react";
import { renderWithProviders } from "../test/render";
import { connection } from "./connection";
import { ConnectionOverlay } from "./ConnectionOverlay";

afterEach(() => { vi.useRealTimers(); });

it("keeps the editor mounted and announces recovery without reloading", async () => {
  vi.useFakeTimers();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const mounted = vi.fn();
  function Editor() {
    const [value, setValue] = useState("Unsaved answer");
    useEffect(mounted, []);
    return <input aria-label="Answer" value={value} onChange={(e) => setValue(e.target.value)} />;
  }
  const { queryClient } = renderWithProviders(<><Editor /><ConnectionOverlay /></>, { locale: "fr" });
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const input = screen.getByRole("textbox");
  await act(async () => connection.updating());
  const dialog = screen.getByRole("dialog", { name: "Mise à jour en cours" });
  expect(input).toHaveValue("Unsaved answer");
  const cancel = new Event("cancel", { cancelable: true });
  dialog.dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  expect(dialog).toHaveAttribute("open");
  const shortcut = vi.fn();
  window.addEventListener("keydown", shortcut);
  fireEvent.keyDown(dialog, { key: "ArrowRight" });
  window.removeEventListener("keydown", shortcut);
  expect(shortcut).not.toHaveBeenCalled();
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
    status: "ok", attention: false, uptimeSeconds: 1,
    checks: { database: "up", jobs: "up", runner: "disabled", ticker: "up", disk: "ok", backup: "unknown" },
  })));
  await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toBe(input);
  expect(mounted).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledOnce();
});
