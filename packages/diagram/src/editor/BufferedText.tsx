/**
 * A textarea that keeps what is typed while it has the focus: the value it
 * writes back is normalised (blank lines dropped), and re-reading it at once
 * would eat the new line an Enter just made.
 */
import { useState, type JSX, type RefObject } from "react";

export function BufferedText({
  value,
  onValue,
  onFocus,
  textRef,
  tabIndents = false,
  ...rest
}: {
  value: string;
  onValue: (text: string) => void;
  onFocus?: () => void;
  textRef?: RefObject<HTMLTextAreaElement | null>;
  /** Tab indents by two spaces instead of leaving the field: the text pane. */
  tabIndents?: boolean;
  className?: string;
  rows?: number;
  maxLength?: number;
  "aria-label"?: string;
  "aria-invalid"?: boolean;
}): JSX.Element {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <textarea
      ref={textRef}
      spellCheck={false}
      {...rest}
      value={local ?? value}
      onFocus={() => {
        setLocal(value);
        onFocus?.();
      }}
      onBlur={() => setLocal(null)}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
        if (tabIndents && e.key === "Tab" && !e.shiftKey) {
          e.preventDefault();
          const el = e.currentTarget;
          el.setRangeText("  ", el.selectionStart, el.selectionEnd, "end");
          setLocal(el.value);
          onValue(el.value);
        }
      }}
      onChange={(e) => {
        setLocal(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}
