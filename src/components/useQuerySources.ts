// Suggestion sources for the query builder's "Easy" mode: the real folders, tags, and field names
// in the current vault, so the user picks from menus instead of hand-typing paths and field keys.
//
// Folders come from the vault tree (getTree), tags from listTags, and fields are a curated set of
// the always-present built-ins (file.name, file.path, …) plus any frontmatter keys we can cheaply
// discover by sampling task rows. Everything is loaded once when the helper opens.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { TreeNode } from "../types";

/** A vault page, as a `[[wikilink]]` target (its leaf name) plus its full path for display. */
export interface PageRef {
  /** Wikilink target — the file's base name without extension (what goes inside `[[ ]]`). */
  name: string;
  /** Vault-relative path, shown as a subtitle to disambiguate same-named pages. */
  path: string;
}

export interface QuerySources {
  /** Vault-relative folder paths (databases included), shallowest first. */
  folders: string[];
  /** Tag names without the leading `#`. */
  tags: string[];
  /** Field names usable in WHERE / SORT / columns. */
  fields: string[];
  /** Pages in the vault, for the TASK `ref` filter (links a task to a page). */
  pages: PageRef[];
  loading: boolean;
}

// Built-in fields the engine always understands, independent of any page's frontmatter. These lead
// the field menus so the common cases (name, path, status, due) are one click away.
const BUILTIN_FIELDS = ["file.name", "file.path", "file.folder", "status", "priority", "due", "tags"];

function collectFolders(node: TreeNode, out: string[]): void {
  for (const child of node.children) {
    if (child.is_dir) {
      out.push(child.rel_path);
      collectFolders(child, out);
    }
  }
}

/** Walk the tree collecting markdown pages as wikilink-ready `{ name, path }` refs. */
function collectPages(node: TreeNode, out: PageRef[]): void {
  for (const child of node.children) {
    if (child.is_dir) {
      collectPages(child, out);
    } else if (child.ext === "" || child.ext === "md") {
      // Markdown pages have no surfaced extension; the wikilink target is the leaf name.
      const name = child.name.replace(/\.md$/i, "");
      out.push({ name, path: child.rel_path });
    }
  }
}

/** Load folders, tags, and field names for the current vault. Re-runs when `nonce` bumps. */
export function useQuerySources(nonce = 0): QuerySources {
  const [sources, setSources] = useState<QuerySources>({
    folders: [],
    tags: [],
    fields: BUILTIN_FIELDS,
    pages: [],
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [tree, tags] = await Promise.all([api.getTree(), api.listTags()]);
        if (!alive) return;
        const folders: string[] = [];
        collectFolders(tree, folders);
        folders.sort((a, b) => a.localeCompare(b));
        const pages: PageRef[] = [];
        collectPages(tree, pages);
        pages.sort((a, b) => a.name.localeCompare(b.name));
        setSources({
          folders,
          tags: tags.map((t) => t.tag.replace(/^#/, "")).sort((a, b) => a.localeCompare(b)),
          fields: BUILTIN_FIELDS,
          pages,
          loading: false,
        });
      } catch {
        if (alive) setSources((s: QuerySources) => ({ ...s, loading: false }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [nonce]);

  return sources;
}
