import { useState } from "react";

/** Opens a layer from a real button, so the focus has somewhere to come back to. */
export function LayerHarness({
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
