export interface TreeNode {
  name: string;
  rel_path: string;
  is_dir: boolean;
  is_database: boolean;
  children: TreeNode[];
}

export interface ParsedDoc {
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface QueryResult {
  kind: "table" | "list" | "task";
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface TaskRow {
  rel_path: string;
  line: number;
  text: string;
  done: boolean;
  due: string | null;
  rrule: string | null;
  tags: string | null;
}

export interface Settings {
  theme: "light" | "dark" | "system";
  font_family: string;
  editor_font_family: string;
  font_size: number;
  accent_color: string;
  background_color: string;
  text_color: string;
  line_height: number;
  periodic_folder: string;
  show_line_numbers: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  font_family: "Inter, system-ui, sans-serif",
  editor_font_family: "Inter, system-ui, sans-serif",
  font_size: 16,
  accent_color: "#7c5cff",
  background_color: "",
  text_color: "",
  line_height: 1.6,
  periodic_folder: "Periodic",
  show_line_numbers: false,
};
