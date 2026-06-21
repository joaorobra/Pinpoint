import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, pickVaultFolder } from "./api";
import type { Settings, TreeNode } from "./types";
import { DEFAULT_SETTINGS } from "./types";
import Editor from "./components/Editor";
import FileTree from "./components/FileTree";
import TasksView from "./components/TasksView";
import QueryView from "./components/QueryView";
import SettingsPanel from "./components/SettingsPanel";
import PeriodicBar from "./components/PeriodicBar";

type RightTab = "editor" | "tasks" | "query";

export default function App() {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [vaultName, setVaultName] = useState<string>("");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [frontmatter, setFrontmatter] = useState<Record<string, unknown>>({});
  const [reloadKey, setReloadKey] = useState<string>("");
  const [tab, setTab] = useState<RightTab>("editor");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [taskRefresh, setTaskRefresh] = useState(0);
  const saveTimer = useRef<number | null>(null);

  // ---- Theming: apply settings to CSS variables ----
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.style.setProperty("--font-ui", settings.font_family);
    root.style.setProperty("--font-editor", settings.editor_font_family);
    root.style.setProperty("--font-size", `${settings.font_size}px`);
    root.style.setProperty("--line-height", String(settings.line_height));
    root.style.setProperty("--accent", settings.accent_color);
    if (settings.background_color) root.style.setProperty("--bg-override", settings.background_color);
    else root.style.removeProperty("--bg-override");
    if (settings.text_color) root.style.setProperty("--text-override", settings.text_color);
    else root.style.removeProperty("--text-override");
  }, [settings]);

  const refreshTree = useCallback(async () => {
    try {
      setTree(await api.getTree());
    } catch (e) {
      console.error(e);
    }
  }, []);

  // ---- File watcher: backend emits "vault-changed" ----
  useEffect(() => {
    const un = listen("vault-changed", () => {
      refreshTree();
      setTaskRefresh((k) => k + 1);
    });
    return () => {
      un.then((f) => f());
    };
  }, [refreshTree]);

  const openVault = async () => {
    const path = await pickVaultFolder();
    if (!path) return;
    const t = await api.openVault(path);
    setTree(t);
    setVaultName(t.name);
    setSettings(await api.getSettings());
  };

  const openPage = useCallback(async (relPath: string) => {
    const doc = await api.readPage(relPath);
    setActivePath(relPath);
    setBody(doc.body);
    setFrontmatter(doc.frontmatter as Record<string, unknown>);
    setReloadKey(relPath + ":" + Date.now());
    setTab("editor");
    setDirty(false);
  }, []);

  // Open or create a periodic note.
  const openPeriodic = useCallback(
    async (relPath: string, fallbackBody: string) => {
      try {
        await api.readPage(relPath);
      } catch {
        await api.createPage(relPath, fallbackBody);
        await refreshTree();
      }
      await openPage(relPath);
    },
    [openPage, refreshTree]
  );

  const onEditorChange = useCallback(
    (md: string) => {
      setBody(md);
      setDirty(true);
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(async () => {
        if (!activePath) return;
        await api.writePage(activePath, frontmatter, md);
        setDirty(false);
        setTaskRefresh((k) => k + 1);
      }, 600);
    },
    [activePath, frontmatter]
  );

  const newPage = async () => {
    const name = prompt("New page name (e.g. Notes/Idea):");
    if (!name) return;
    const rel = name.endsWith(".md") ? name : `${name}.md`;
    await api.createPage(rel, `# ${name.split("/").pop()}\n\n`);
    await refreshTree();
    await openPage(rel);
  };

  const saveSettings = async (s: Settings) => {
    setSettings(s);
    await api.saveSettings(s);
  };

  const headerStatus = useMemo(() => {
    if (!activePath) return "";
    return dirty ? "● unsaved" : "✓ saved";
  }, [activePath, dirty]);

  if (!tree) {
    return (
      <div className="welcome">
        <div className="welcome-card">
          <div className="logo">📌 PINPOINT</div>
          <p>A free, local-first Notion / Obsidian alternative. Your notes are plain markdown files.</p>
          <button className="primary big" onClick={openVault}>
            Open a vault folder
          </button>
          <p className="muted small">
            Point it at any folder — including one synced by Google Drive, OneDrive, or Dropbox.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="vault-name" title={vaultName}>📂 {vaultName}</span>
          <div className="sidebar-actions">
            <button onClick={newPage} title="New page">＋</button>
            <button onClick={() => api.reindex().then(() => setTaskRefresh((k) => k + 1))} title="Re-index">⟳</button>
            <button onClick={() => setShowSettings(true)} title="Settings">⚙</button>
          </div>
        </div>
        <PeriodicBar periodicFolder={settings.periodic_folder} onOpenPeriodic={openPeriodic} />
        <div className="tree">
          <FileTree node={tree} activePath={activePath} onOpen={openPage} />
        </div>
      </aside>

      <main className="main">
        <div className="tabs">
          <button className={tab === "editor" ? "active" : ""} onClick={() => setTab("editor")}>
            {activePath ? activePath.split("/").pop() : "Editor"}
          </button>
          <button className={tab === "tasks" ? "active" : ""} onClick={() => setTab("tasks")}>
            Tasks
          </button>
          <button className={tab === "query" ? "active" : ""} onClick={() => setTab("query")}>
            Query
          </button>
          <span className="status">{headerStatus}</span>
        </div>

        <div className="content">
          {tab === "editor" &&
            (activePath ? (
              <Editor value={body} onChange={onEditorChange} reloadKey={reloadKey} />
            ) : (
              <div className="empty">Select a page from the sidebar, or create one with ＋.</div>
            ))}
          {tab === "tasks" && <TasksView onOpen={openPage} refreshKey={taskRefresh} />}
          {tab === "query" && <QueryView />}
        </div>
      </main>

      {showSettings && (
        <SettingsPanel settings={settings} onChange={saveSettings} onClose={() => setShowSettings(false)} />
      )}
    </div>
  );
}
