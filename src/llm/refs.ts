// `[[ref]]` resolution for the LLM composer.
//
// Users type `[[Page]]` or `[[Folder/]]` in the chat box — the same wiki-link grammar the editor
// uses — to attach context. On send we parse those refs, read each referenced page's markdown, and
// assemble a context-prefixed prompt. Folders are passed to the CLI as `--add-dir` (so the model
// can read what it needs) AND listed inline, rather than concatenating every file (token blowup).
//
// Kept transport-agnostic and side-effect-free apart from the injected `readPage`/`resolveDir`
// callbacks, so it's unit-testable and reusable by both the Tauri and (future) WS hosts.

import type { PageRef } from "../components/Editor";

/** A `[[…]]` token found in the prompt, with its inner target. */
export interface ParsedRef {
  /** Raw inner text, e.g. "Notes/Idea" or "Projects/". */
  target: string;
  /** True when the target ends in "/" — treat as a folder. */
  isFolder: boolean;
}

/** Extract every `[[ref]]` from `text`, in order, de-duplicated by target. */
export function parseRefs(text: string): ParsedRef[] {
  const out: ParsedRef[] = [];
  const seen = new Set<string>();
  // Match [[ ... ]] with no nested brackets, like the editor's wikilink grammar.
  const re = /\[\[([^\[\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const target = m[1].trim();
    if (!target || seen.has(target)) continue;
    seen.add(target);
    out.push({ target, isFolder: target.endsWith("/") });
  }
  return out;
}

/** Resolve a page ref's display target to an actual page `rel_path` (`.md`), or null if unmatched. */
export function resolvePageRef(pages: PageRef[], target: string): string | null {
  const want = target.replace(/\.md$/i, "").toLowerCase();
  // Exact path match first (e.g. "Notes/Idea"), then bare-name match (e.g. "Idea").
  const byPath = pages.find(
    (p) => p.rel_path.replace(/\.md$/i, "").toLowerCase() === want
  );
  if (byPath) return byPath.rel_path;
  const byName = pages.find((p) => p.name.toLowerCase() === want);
  return byName ? byName.rel_path : null;
}

/** Pages directly or recursively under a folder prefix (target ends in "/"). */
export function pagesInFolder(pages: PageRef[], folderTarget: string): PageRef[] {
  const dir = folderTarget.replace(/\/+$/, "").toLowerCase() + "/";
  return pages.filter((p) => p.rel_path.toLowerCase().startsWith(dir));
}

export interface ResolvedContext {
  /** The prompt with a context preamble prepended (referenced page bodies + folder listings). */
  prompt: string;
  /** Vault-relative dirs to grant via `--add-dir` (referenced folders + the vault root in agent mode). */
  addDirs: string[];
  /** Human-readable summary of what got attached, for a UI chip row. */
  attached: string[];
}

/**
 * Build the context-injected prompt from a raw composer prompt.
 *
 * - Page refs → read the `.md` and inline it under a labelled fence.
 * - Folder refs → inline a file listing and add the folder to `addDirs`.
 * - `vaultRelToAbs` maps a vault-relative path to the absolute path the CLI's `--add-dir` needs.
 *
 * `readPage(relPath)` returns the page body (markdown). Missing/locked pages are skipped with a note
 * rather than failing the whole send.
 */
export async function buildContext(
  rawPrompt: string,
  pages: PageRef[],
  readPage: (relPath: string) => Promise<string>,
  vaultRelToAbs: (rel: string) => string
): Promise<ResolvedContext> {
  const refs = parseRefs(rawPrompt);
  const blocks: string[] = [];
  const addDirs: string[] = [];
  const attached: string[] = [];

  for (const ref of refs) {
    if (ref.isFolder) {
      const inFolder = pagesInFolder(pages, ref.target);
      const listing = inFolder.map((p) => `  - ${p.rel_path}`).join("\n");
      blocks.push(
        `Folder \`${ref.target}\` contains ${inFolder.length} page(s):\n${listing || "  (empty)"}`
      );
      addDirs.push(vaultRelToAbs(ref.target.replace(/\/+$/, "")));
      attached.push(`📁 ${ref.target} (${inFolder.length})`);
    } else {
      const rel = resolvePageRef(pages, ref.target);
      if (!rel) {
        blocks.push(`(Referenced page \`${ref.target}\` was not found.)`);
        attached.push(`⚠ ${ref.target}`);
        continue;
      }
      try {
        const body = await readPage(rel);
        blocks.push(`Page \`${rel}\`:\n\n${body}`);
        attached.push(`📄 ${ref.target}`);
      } catch {
        blocks.push(`(Referenced page \`${rel}\` could not be read — it may be locked.)`);
        attached.push(`🔒 ${ref.target}`);
      }
    }
  }

  if (blocks.length === 0) {
    return { prompt: rawPrompt, addDirs, attached };
  }

  const preamble =
    "The user attached the following vault context. Use it to answer.\n\n" +
    blocks.map((b) => `---\n${b}`).join("\n\n") +
    "\n---\n\n";
  return { prompt: preamble + rawPrompt, addDirs, attached };
}
