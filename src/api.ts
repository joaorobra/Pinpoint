import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { ParsedDoc, QueryResult, Settings, TaskRow, TreeNode } from "./types";

export async function pickVaultFolder(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "Open PINPOINT vault" });
  return typeof selected === "string" ? selected : null;
}

export const api = {
  openVault: (path: string) => invoke<TreeNode>("open_vault", { path }),
  getTree: () => invoke<TreeNode>("get_tree"),
  readPage: (relPath: string) => invoke<ParsedDoc>("read_page", { relPath }),
  writePage: (relPath: string, frontmatter: Record<string, unknown>, body: string) =>
    invoke<void>("write_page", { relPath, frontmatter, body }),
  createPage: (relPath: string, body: string) => invoke<void>("create_page", { relPath, body }),
  deletePage: (relPath: string) => invoke<void>("delete_page", { relPath }),
  reindex: () => invoke<number>("reindex"),
  runQuery: (dsl: string) => invoke<QueryResult>("run_query", { dsl }),
  listTasks: () => invoke<TaskRow[]>("list_tasks"),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (s: Settings) => invoke<void>("save_settings", { s }),
};
