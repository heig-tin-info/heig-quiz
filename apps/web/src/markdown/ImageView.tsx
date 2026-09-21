import type { NodeViewProps } from "@tiptap/core";
import { NodeViewWrapper } from "@tiptap/react";
import { Check, Loader2, RotateCcw, RotateCw, Scaling, Trash2 } from "lucide-react";
import { createContext, useContext, useState } from "react";

import { useT } from "../i18n";
import { IconButton, Menu } from "../ui";
import { assetUrl, assetWidth, IMAGE_WIDTHS, withAssetWidth } from "./render";

/*
 * The image node of the rich editor, as a Tiptap NODE VIEW (React), and not as
 * a plugin decoration.
 *
 * A decoration would have had to find the picture's rectangle on every scroll,
 * every resize and every transaction, and place a floating bar over it from
 * coordinates — for a toolbar whose whole job is to sit at the top-right
 * CORNER OF THE IMAGE. A node view owns the element instead: the bar is a
 * child of the frame the picture lives in, `position: absolute` does the
 * placing, and it follows the image wherever the document puts it, for free.
 * It also gets the two things the buttons need — `updateAttributes` and
 * `deleteNode` — handed to it, instead of reconstructing a position.
 *
 * What it must not do is take the caret. Every button prevents its mousedown,
 * so pressing one formats or replaces the image while the editor keeps the
 * selection it had; a `focus()` here would have scrolled the teacher back to
 * wherever the caret was.
 */

/** What the node view needs from the field around it, which props cannot carry. */
export interface ImageTools {
  /**
   * The field's own uploader. Rotation produces a NEW asset — there is no
   * attribute for an angle, and inventing one would put something in the
   * markdown no student view could read — so a field without an uploader
   * simply does not offer the two rotate buttons.
   */
  uploadImage?: (file: File) => Promise<string>;
}

/**
 * Read by the node view, provided by `RichText`. A context and not an
 * extension option: node views render through portals INSIDE `EditorContent`
 * (@tiptap/react mounts them on `editor.contentComponent`), so the React tree
 * around the field is the React tree around the picture, `t()` included.
 */
export const ImageToolsContext = createContext<ImageTools>({});

/** The file name a rotated copy is uploaded under; the extension must match. */
function rotatedName(alt: string, type: string): string {
  const base = (alt.trim() || "image").replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40);
  return `${base}.${type === "image/jpeg" ? "jpg" : "png"}`;
}

/**
 * A quarter turn, in the browser. The asset endpoint is SAME-ORIGIN (it is
 * `/app/api/assets/<id>`, never a CDN — N-SEC-02), so the bitmap can be read
 * back into a canvas without tainting it, and nothing has to be added to the
 * API for a teacher to straighten a photo taken with a phone.
 *
 * JPEG in, JPEG out: re-encoding a photograph as PNG multiplies its weight by
 * five for a picture nobody will look at pixel by pixel. Everything else
 * leaves as PNG, which is lossless and what a screenshot or a diagram wants.
 */
async function rotateImage(url: string, alt: string, quarter: 1 | -1): Promise<File> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`asset ${response.status}`);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.height;
  canvas.height = bitmap.width;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((quarter * Math.PI) / 2);
  ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
  bitmap.close();
  const type = blob.type === "image/jpeg" ? "image/jpeg" : "image/png";
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.92));
  if (!out) throw new Error("canvas export failed");
  return new File([out], rotatedName(alt, type), { type });
}

export function ImageView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
  getPos,
}: NodeViewProps) {
  const t = useT();
  const { uploadImage } = useContext(ImageToolsContext);
  const [hover, setHover] = useState(false);
  /** Which rotation is in flight, so its own button shows the spinner. */
  const [busy, setBusy] = useState<null | "left" | "right">(null);

  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
  const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
  const url = assetUrl(src);
  const width = assetWidth(src);

  const editable = editor.isEditable;
  const open = editable && (hover || selected);

  async function rotate(quarter: 1 | -1) {
    if (!uploadImage || !url || busy) return;
    setBusy(quarter === -1 ? "left" : "right");
    try {
      const file = await rotateImage(url, alt, quarter);
      const uploaded = await uploadImage(file);
      // The width the teacher had chosen survives the rotation: it is a
      // property of the PLACE the picture sits in, not of the picture.
      updateAttributes({ src: withAssetWidth(uploaded, width) });
    } catch {
      // A failed rotation leaves the original in place, which is the only
      // sane outcome: the node still points at an asset that exists.
    } finally {
      setBusy(null);
    }
  }

  const sizeItems = IMAGE_WIDTHS.map((w) => ({
    label: t("md.image.percent", { n: w }),
    ...(w === width ? { icon: Check } : {}),
    onSelect: () => updateAttributes({ src: withAssetWidth(src, w) }),
  }));

  return (
    <NodeViewWrapper
      className="rt-image"
      // A percentage on the FRAME and not on the picture: a percentage width
      // on a shrink-to-fit box resolves against the box itself, so sizing the
      // <img> inside an inline-block would have measured it against its own
      // natural width. The frame is what the column sizes; the picture fills
      // it (`.md-body img` already caps it at 100 %).
      style={width === 100 ? undefined : { width: `${width}%` }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* `data-asset` carries the CANONICAL reference beside the resolved
          URL, exactly as the node's own `renderHTML` does: it is what the
          parser reads back, and what a test can assert the markdown on. */}
      <img
        src={url ?? src}
        alt={alt}
        data-asset={src}
        {...(title === undefined ? {} : { title })}
      />

      {open ? (
        <div
          role="toolbar"
          aria-label={t("md.image.menu")}
          className="absolute top-1.5 right-1.5 flex items-center gap-0.5 rounded-full border border-line bg-surface px-0.5 shadow-overlay"
          // The bar floats over the document; nothing in it moves the caret.
          onMouseDown={(e) => e.preventDefault()}
        >
          {uploadImage && url ? (
            <>
              <IconButton
                size="sm"
                label={t("md.image.rotateLeft")}
                disabled={busy !== null}
                onClick={() => void rotate(-1)}
              >
                {busy === "left" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              </IconButton>
              <IconButton
                size="sm"
                label={t("md.image.rotateRight")}
                disabled={busy !== null}
                onClick={() => void rotate(1)}
              >
                {busy === "right" ? <Loader2 className="animate-spin" /> : <RotateCw />}
              </IconButton>
            </>
          ) : null}

          <Menu
            label={t("md.image.size")}
            align="end"
            items={sizeItems}
            trigger={
              <IconButton
                size="sm"
                label={t("md.image.size")}
                onMouseDown={(e) => e.preventDefault()}
                // Opening the menu SELECTS the node, so the bar survives the
                // pointer leaving the picture on its way to the panel. It is
                // a selection, not a focus: nothing scrolls, nothing is typed.
                onClick={() => {
                  const pos = getPos();
                  if (typeof pos === "number") editor.commands.setNodeSelection(pos);
                }}
              >
                <Scaling />
              </IconButton>
            }
          />

          <IconButton
            size="sm"
            danger
            label={t("md.image.remove")}
            onClick={() => deleteNode()}
          >
            <Trash2 />
          </IconButton>
        </div>
      ) : null}
    </NodeViewWrapper>
  );
}
