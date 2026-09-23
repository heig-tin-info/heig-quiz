import { CloudUpload, Eye, Play } from "lucide-react";
import { useEffect } from "react";

import { useT } from "../i18n";
import { useScreenCommands } from "../screenCommands";
import { useShortcuts } from "../shortcuts";
import { modKey } from "../ui";

/**
 * The question editor's four shortcuts (docs/spec/08 §8.4), in the three
 * places they live: the key handler, the sidebar strip that lists them, and
 * the command palette (§8.3). A reader loses save and publish in all three.
 *
 * `onTry` switches to the Try tab; the key flushes the draft before calling
 * it, the palette entry does not.
 */
export function useEditorShortcuts({
  readOnly,
  flush,
  onPublish,
  onPreview,
  onTry,
}: {
  readOnly: boolean;
  flush: () => void;
  onPublish: () => void;
  onPreview: () => void;
  onTry: () => void;
}) {
  const t = useT();

  // docs/spec/08 §8.4: Ctrl+S saves (the automatic save is invisible and a
  // teacher wants to be sure), Ctrl+Shift+P publishes, Ctrl+Shift+M opens the
  // student preview in a new tab, Ctrl+Enter tries the question. All four are
  // reachable with the mouse as well.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s" && !e.shiftKey) {
        e.preventDefault();
        if (!readOnly) flush();
        return;
      }
      // §8.5 "Essayer la question": the draft is saved first — the Try tab
      // runs what the SERVER holds, and trying a question without the edit
      // that prompted the try is the one thing this shortcut must not do.
      // The focus follows into the panel; a shortcut that moves the screen
      // and leaves the caret behind has moved only half the reader.
      if (key === "enter" && !e.shiftKey) {
        e.preventDefault();
        flush();
        onTry();
        return;
      }
      if (!e.shiftKey) return;
      if (key === "p") {
        e.preventDefault();
        if (!readOnly) onPublish();
      } else if (key === "m") {
        e.preventDefault();
        onPreview();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flush, onPreview, onPublish, onTry, readOnly]);

  // The same four, shown in the sidebar strip while this screen is mounted.
  // The sentence that used to spell them out under the form is gone: a hint
  // that only the editor carried is now the frame's, and it follows the page.
  useShortcuts(
    readOnly
      ? [
          { keys: `${modKey()}+Enter`, label: t("question.tab.try") },
          { keys: `${modKey()}+Shift+M`, label: t("question.preview") },
        ]
      : [
          { keys: `${modKey()}+S`, label: t("common.save") },
          { keys: `${modKey()}+Enter`, label: t("question.tab.try") },
          { keys: `${modKey()}+Shift+P`, label: t("question.publish") },
          { keys: `${modKey()}+Shift+M`, label: t("question.preview") },
        ],
  );

  // The editor's own palette entries (docs/spec/08 §8.3). They carry the
  // shortcut as a hidden keyword, so typing "ctrl+shift+p" finds the action
  // it belongs to.
  useScreenCommands([
    ...(readOnly
      ? []
      : [
          {
            id: "question:publish",
            label: t("palette.publish"),
            icon: CloudUpload,
            group: "action" as const,
            keywords: "ctrl+shift+p",
            run: onPublish,
          },
        ]),
    {
      id: "question:preview",
      label: t("palette.preview"),
      icon: Eye,
      group: "action",
      keywords: "ctrl+shift+m",
      run: onPreview,
    },
    {
      id: "question:try",
      label: t("question.tab.try"),
      icon: Play,
      group: "action",
      keywords: "ctrl+enter",
      run: onTry,
    },
  ]);
}
