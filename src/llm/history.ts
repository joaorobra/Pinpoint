// Saved AI chats, so a conversation can be resumed later.
//
// Each conversation is one JSON file in the vault's `.pinpoint/chats/` (a dot-folder, so it never
// shows in the file tree and the file watcher — which only reacts to `.md` — ignores it). A small
// `index.json` beside them lists every chat, so the history menu doesn't have to read each file.
// Chats travel with the vault like `.pinpoint/settings.json`; Settings → AI Chat can turn saving
// off, and an anonymous chat is never written at all.

import { api } from "../api";
import type { ProviderId } from "./transport";

export const CHATS_DIR = ".pinpoint/chats";
const INDEX_PATH = `${CHATS_DIR}/index.json`;

/** One turn as stored on disk (the live `streaming` flag is never persisted). */
export interface SavedTurn {
  role: "user" | "assistant";
  text: string;
  attached?: string[];
}

export interface SavedChat {
  id: string;
  title: string;
  /** ISO timestamps. */
  created: string;
  updated: string;
  provider: ProviderId;
  /** The CLI's resume session id, so the model keeps its own context when the chat continues. */
  sessionId?: string;
  turns: SavedTurn[];
}

/** What the history menu lists. */
export type ChatSummary = Pick<SavedChat, "id" | "title" | "updated" | "provider"> & { count: number };

const chatPath = (id: string) => `${CHATS_DIR}/${id}.json`;

/** A sortable, filename-safe id: creation time plus a little randomness. */
export function newChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A chat's title: its first user message, trimmed to one short line. */
export function chatTitle(turns: SavedTurn[]): string {
  const first = turns.find((t) => t.role === "user")?.text ?? "";
  const line = first.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 57)}…` : line || "Untitled chat";
}

async function readJson<T>(relPath: string): Promise<T | null> {
  try {
    const asset = await api.readAsset(relPath);
    return JSON.parse(asset.url) as T;
  } catch {
    return null; // missing or unreadable — treated as "no such chat"
  }
}

async function writeJson(relPath: string, value: unknown): Promise<void> {
  await api.writeAsset(relPath, new TextEncoder().encode(JSON.stringify(value, null, 2)));
}

// Writes are chained so two quick saves can't interleave their read-modify-write of the index.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function readIndex(): Promise<ChatSummary[]> {
  const list = await readJson<ChatSummary[]>(INDEX_PATH);
  return Array.isArray(list) ? list : [];
}

/** Saved chats, most recently updated first. */
export async function listChats(): Promise<ChatSummary[]> {
  const list = await readIndex();
  return list.sort((a, b) => b.updated.localeCompare(a.updated));
}

export function loadChat(id: string): Promise<SavedChat | null> {
  return readJson<SavedChat>(chatPath(id));
}

/** Create or update a chat file and its index entry. Keeps the original `created` time. */
export function saveChat(chat: Omit<SavedChat, "created" | "updated" | "title">): Promise<void> {
  return serial(async () => {
    const index = await readIndex();
    const now = new Date().toISOString();
    const existing = await loadChat(chat.id);
    const turns = chat.turns.map(({ role, text, attached }) => (attached ? { role, text, attached } : { role, text }));
    const full: SavedChat = {
      ...chat,
      turns,
      title: chatTitle(turns),
      created: existing?.created ?? now,
      updated: now,
    };
    await writeJson(chatPath(chat.id), full);
    const summary: ChatSummary = {
      id: full.id,
      title: full.title,
      updated: full.updated,
      provider: full.provider,
      count: turns.length,
    };
    await writeJson(INDEX_PATH, [summary, ...index.filter((c) => c.id !== chat.id)]);
  });
}

export function deleteChat(id: string): Promise<void> {
  return serial(async () => {
    try {
      await api.deletePage(chatPath(id));
    } catch {
      /* already gone */
    }
    const index = await readIndex();
    await writeJson(INDEX_PATH, index.filter((c) => c.id !== id));
  });
}

/** Remove every saved chat (Settings → AI Chat → Delete saved chats). */
export function clearChats(): Promise<void> {
  return serial(async () => {
    try {
      await api.deletePage(CHATS_DIR);
    } catch {
      /* nothing saved yet */
    }
  });
}
