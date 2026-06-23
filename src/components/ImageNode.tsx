// Block image node for the editor.
//
// Round-trip (the locked markdown constraint): an image is stored as standard markdown
// `![alt](src)`. markdownToHtml emits `<img>`, this node parses it, and docToMarkdown
// re-serializes it back to `![alt](src)` — so it survives an external edit and renders in any
// other CommonMark viewer.
//
// The twist: a pasted image's `src` is a *vault-relative* path (e.g. `.attachments/Pasted image
// ….png`), not a URL the webview can load directly. So the node view resolves the path through
// `api.readAsset` — exactly like AssetViewer — into a data URL (native) or object URL (web), and
// renders that. Remote/inline sources (`http(s):`, `data:`, `blob:`, `file:`) are used as-is.

import { Node, mergeAttributes } from "@tiptap/core";
import { ReactNodeViewRenderer, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useEffect, useState } from "react";
import { api } from "../api";

/** A source that the webview can load directly, with no vault resolution needed. */
function isDirectUrl(src: string): boolean {
  return /^(data:|blob:|https?:|file:)/i.test(src);
}

function ImageNodeView({ node, selected }: NodeViewProps) {
  const src: string = node.attrs.src ?? "";
  const alt: string = node.attrs.alt ?? "";
  const [url, setUrl] = useState<string | null>(isDirectUrl(src) ? src : null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!src || isDirectUrl(src)) {
      setUrl(src || null);
      setError(null);
      return;
    }
    let revoked: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    api
      .readAsset(src)
      .then((a) => {
        if (cancelled) {
          // Resolved after unmount/src-change — release any object URL we created.
          if (a.url.startsWith("blob:")) URL.revokeObjectURL(a.url);
          return;
        }
        if (a.url.startsWith("blob:")) revoked = a.url;
        setUrl(a.url);
      })
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
      if (revoked) URL.revokeObjectURL(revoked);
    };
  }, [src]);

  return (
    <NodeViewWrapper className={`editor-image${selected ? " selected" : ""}`} data-drag-handle>
      {url ? (
        <img src={url} alt={alt} draggable={false} />
      ) : error ? (
        <span className="editor-image-fallback" title={error}>
          ⚠ Couldn’t load {src.split("/").pop()}
        </span>
      ) : (
        <span className="editor-image-fallback">Loading image…</span>
      )}
    </NodeViewWrapper>
  );
}

export const ImageNode = Node.create({
  name: "image",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: "" },
      title: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: "img[src]" }];
  },

  renderHTML({ HTMLAttributes }) {
    // The serializer (docToMarkdown) is what actually persists images; this HTML form is used for
    // clipboard copy and `getHTML()`, so keep the raw vault-relative `src` intact.
    return ["img", mergeAttributes(HTMLAttributes)];
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView);
  },
});
