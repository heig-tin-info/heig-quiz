import type { Editor } from "@tiptap/core";
import { useCallback, useState } from "react";

import type { RichTextProps } from "@quiz/core/client";

/**
 * Uploads the pictures a teacher picked, pasted or dropped, and lays them
 * down in the editor; `uploading` counts the ones still in flight, for the
 * status in the toolbar.
 */
export function useImageUpload(
  editor: Editor | null,
  uploadImage: RichTextProps["uploadImage"],
) {
  const [uploading, setUploading] = useState(0);

  const insertImages = useCallback(
    async (files: File[], at?: number) => {
      if (!uploadImage || !editor) return;
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      setUploading((n) => n + images.length);
      try {
        // The drop position is remembered BEFORE the upload and the pictures
        // are laid down from it, in the order they were dropped.
        let pos = at;
        for (const image of images) {
          const src = await uploadImage(image);
          const alt = image.name.replace(/\.[^.]+$/, "");
          const node = { type: "image", attrs: { src, alt } };
          if (pos === undefined) editor.chain().focus().setImage({ src, alt }).run();
          else {
            const size = editor.state.doc.content.size;
            const where = Math.min(pos, size);
            editor.chain().focus().insertContentAt(where, node).run();
            pos = Math.min(editor.state.selection.to, editor.state.doc.content.size);
          }
        }
      } finally {
        setUploading((n) => Math.max(0, n - images.length));
      }
    },
    [uploadImage, editor],
  );

  return { uploading, insertImages };
}
