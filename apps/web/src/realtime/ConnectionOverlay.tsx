import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { useT } from "../i18n";
import { Spinner } from "../ui/feedback";
import { useLayer } from "../ui/layers";
import { connection } from "./connection";

/** A native modal keeps every underlying surface inert, including portals. */
export function ConnectionOverlay() {
  const state = useSyncExternalStore(connection.subscribe, connection.getSnapshot);
  const previous = useRef(state);
  const dialog = useRef<HTMLDialogElement>(null);
  const qc = useQueryClient();
  const t = useT();
  const visible = state !== "connected";

  useEffect(connection.start, []);
  useLayer(dialog, () => {}, { enabled: visible, escape: false });
  useEffect(() => {
    if (visible) dialog.current?.showModal();
    else dialog.current?.close();
    if (state === "connected" && previous.current !== "connected") {
      // Reads only. Autosave owns the revision-aware replay of student answers.
      void qc.invalidateQueries();
    }
    previous.current = state;
  }, [visible, state, qc]);

  return createPortal(
    <dialog
      ref={dialog}
      aria-labelledby="connection-title"
      aria-describedby="connection-detail"
      tabIndex={-1}
      onCancel={(event) => event.preventDefault()}
      onKeyDown={(event) => event.stopPropagation()}
      className="connection-overlay outline-none m-auto w-[calc(100%-2rem)] max-w-sm rounded-sheet border border-line bg-surface p-8 text-center text-fg"
    >
      <Spinner className="pb-4" />
      <h2 id="connection-title" className="text-xl font-bold">
        {t(state === "updating" ? "connection.updating" : "connection.lost")}
      </h2>
      <p id="connection-detail" role="status" className="mt-2 text-sm text-fg-muted">
        {t(state === "updating" ? "connection.updateDetail" : "connection.retrying")}
      </p>
      <p className="mt-4 text-sm text-fg-muted">{t("connection.keepOpen")}</p>
    </dialog>,
    document.body,
  );
}
