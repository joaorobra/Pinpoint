// Sync-conflict duplicate detection: cloud sync clients (Google Drive, OneDrive, …) resolve a
// write conflict by keeping both versions, renaming one to "<name> (1).md". These copies are pure
// noise for periodic notes (the app deterministically re-opens "2026-07-21.md", so edits landing in
// the "(1)" copy are effectively lost). This module finds such pairs in the tree; App.tsx owns the
// alert + resolution UI.

import type { TreeNode } from "./types";
import { periodFromPath, type Period } from "./periodic";

export type SyncConflict = {
  /** rel_path of the base file the copy shadows (e.g. "Periodic/Daily/2026-07-21.md"). */
  original: string;
  /** rel_path of the " (n)" copy (e.g. "Periodic/Daily/2026-07-21 (1).md"). */
  duplicate: string;
  /** Which periodic note the original is, or null for a regular page. */
  periodic: Period | null;
};

// "<stem> (n)" — the rename pattern sync clients use for the losing side of a conflict. Manual
// in-app duplicates use "<stem> copy" (see App.duplicateNode) so they never match here.
const COPY_RE = /^(.*\S) \((\d+)\)$/;

/**
 * Scan the vault tree for sync-conflict copies: a "<stem> (n).md" page whose "<stem>.md" sibling
 * exists in the same folder. Pages only — merging/trashing goes through the page API.
 */
export function findSyncConflicts(tree: TreeNode, periodicFolder: string): SyncConflict[] {
  const out: SyncConflict[] = [];
  const visit = (dir: TreeNode) => {
    const stems = new Map<string, string>(); // stem → rel_path, for the current folder's pages
    for (const c of dir.children) {
      if (!c.is_dir && /\.md$/i.test(c.name)) stems.set(c.name.replace(/\.md$/i, ""), c.rel_path);
    }
    for (const [stem, relPath] of stems) {
      const m = stem.match(COPY_RE);
      const original = m && stems.get(m[1]);
      if (!original) continue;
      out.push({
        original,
        duplicate: relPath,
        periodic: periodFromPath(original, periodicFolder)?.period ?? null,
      });
    }
    for (const c of dir.children) if (c.is_dir) visit(c);
  };
  visit(tree);
  return out;
}

/**
 * Merge a conflict copy's body into the original. Identical or fully-contained content collapses
 * to the superset; otherwise the copy's content is appended under a divider so nothing is lost and
 * the user can tidy up in the editor.
 */
export function mergeBodies(original: string, duplicate: string): string {
  const o = original.trim();
  const d = duplicate.trim();
  if (o === d || o.includes(d)) return original;
  if (d.includes(o)) return duplicate;
  return `${o}\n\n---\n\n${d}\n`;
}

/**
 * One aligned row of the side-by-side compare view: the original's line, the duplicate's line, and
 * whether they match. A null side means the line exists only on the other side (rendered as a gap).
 */
export type DiffRow = { left: string | null; right: string | null; same: boolean };

/**
 * Line-level LCS diff producing aligned rows for a two-pane view. Runs of removed/added lines are
 * paired index-wise so an edited line shows up as left/right neighbours rather than two gaps.
 * O(n·m) — fine for note-sized files; degenerate inputs fall back to plain index alignment.
 */
export function diffLines(a: string, b: string): DiffRow[] {
  const al = a.split("\n");
  const bl = b.split("\n");
  const n = al.length;
  const m = bl.length;
  const rows: DiffRow[] = [];
  if (n * m > 4_000_000) {
    for (let i = 0; i < Math.max(n, m); i++) {
      const left = i < n ? al[i] : null;
      const right = i < m ? bl[i] : null;
      rows.push({ left, right, same: left !== null && left === right });
    }
    return rows;
  }
  // LCS length table, flattened; dp[i][j] = LCS of al[i..] and bl[j..].
  const w = m + 1;
  const dp = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * w + j] =
        al[i] === bl[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const dels: string[] = [];
  const ins: string[] = [];
  const flush = () => {
    for (let t = 0; t < Math.max(dels.length, ins.length); t++) {
      rows.push({ left: t < dels.length ? dels[t] : null, right: t < ins.length ? ins[t] : null, same: false });
    }
    dels.length = 0;
    ins.length = 0;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (al[i] === bl[j]) {
      flush();
      rows.push({ left: al[i], right: bl[j], same: true });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      dels.push(al[i++]);
    } else {
      ins.push(bl[j++]);
    }
  }
  while (i < n) dels.push(al[i++]);
  while (j < m) ins.push(bl[j++]);
  flush();
  return rows;
}

/** Stable identity for a conflict pair, scoped to a vault (used for de-duping alerts + ignores). */
export function conflictKey(vaultId: string, c: SyncConflict): string {
  return `${vaultId}::${c.original}::${c.duplicate}`;
}

// "Keep both" resolutions are remembered across launches so the pair doesn't re-alert forever.
// App-global localStorage (like the last-open-page memory), capped so it can't grow unbounded.
const IGNORED_LS_KEY = "pinpoint.syncConflicts.ignored";

export function loadIgnoredConflicts(): Set<string> {
  try {
    const raw = localStorage.getItem(IGNORED_LS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

export function ignoreConflict(key: string): void {
  try {
    const keys = [...loadIgnoredConflicts().add(key)].slice(-200);
    localStorage.setItem(IGNORED_LS_KEY, JSON.stringify(keys));
  } catch {
    /* storage unavailable — the pair will simply re-alert next launch */
  }
}
