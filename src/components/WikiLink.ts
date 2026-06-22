// A custom inline TipTap node for `[[wikilinks]]`.
//
// In the editor a wikilink renders as a single styled atom (a `.page-link` span) instead of the
// raw `[[Name]]` text, so linked pages read as references rather than markup. It round-trips
// losslessly: markdownToHtml emits `<span data-page-link="Name">`, this node parses it, and
// docToMarkdown re-serializes it back to `[[Name]]`.

import { Node, mergeAttributes } from "@tiptap/core";

export interface WikiLinkOptions {
  /** Called when a wikilink is clicked, with the referenced page name. */
  onOpen?: (name: string) => void;
}

export const WikiLink = Node.create<WikiLinkOptions>({
  name: "wikiLink",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { onOpen: undefined };
  },

  addAttributes() {
    return {
      name: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-page-link") ?? el.textContent ?? "",
        renderHTML: (attrs) => ({ "data-page-link": attrs.name }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-page-link]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { class: "page-link" }),
      node.attrs.name,
    ];
  },

  renderText({ node }) {
    return `[[${node.attrs.name}]]`;
  },

  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const dom = document.createElement("span");
      dom.className = "page-link";
      dom.setAttribute("data-page-link", node.attrs.name);
      dom.textContent = node.attrs.name;
      dom.addEventListener("mousedown", (e) => {
        // Open on click without moving the caret into the atom.
        e.preventDefault();
        this.options.onOpen?.(node.attrs.name);
      });
      return { dom };
    };
  },
});
