import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import { useEffect, useRef } from "react";
import { docToMarkdown, markdownToHtml } from "../markdown";

interface Props {
  /** Markdown body to edit. */
  value: string;
  /** Called (debounced) with the serialized markdown when the user edits. */
  onChange: (markdown: string) => void;
  /** Bumping this forces the editor to reload external content (e.g. switched files). */
  reloadKey: string;
}

export default function Editor({ value, onChange, reloadKey }: Props) {
  const lastEmitted = useRef<string>(value);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] } }),
        Link.configure({ openOnClick: false, autolink: true }),
        TaskList,
        TaskItem.configure({ nested: true }),
      ],
      content: markdownToHtml(value),
      onUpdate: ({ editor }) => {
        const md = docToMarkdown(editor.getJSON() as any);
        lastEmitted.current = md;
        onChange(md);
      },
    },
    [reloadKey]
  );

  // When the file changes externally (reloadKey), reset content.
  useEffect(() => {
    if (editor && value !== lastEmitted.current) {
      editor.commands.setContent(markdownToHtml(value), false);
      lastEmitted.current = value;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (!editor) return null;

  return (
    <div className="editor-wrap">
      <Toolbar editor={editor} />
      <EditorContent editor={editor} className="editor-content" />
    </div>
  );
}

function Toolbar({ editor }: { editor: any }) {
  const btn = (label: string, action: () => void, active?: boolean, title?: string) => (
    <button
      className={`tb-btn${active ? " active" : ""}`}
      onMouseDown={(e) => {
        e.preventDefault();
        action();
      }}
      title={title || label}
    >
      {label}
    </button>
  );
  return (
    <div className="toolbar">
      {btn("H1", () => editor.chain().focus().toggleHeading({ level: 1 }).run(), editor.isActive("heading", { level: 1 }))}
      {btn("H2", () => editor.chain().focus().toggleHeading({ level: 2 }).run(), editor.isActive("heading", { level: 2 }))}
      {btn("H3", () => editor.chain().focus().toggleHeading({ level: 3 }).run(), editor.isActive("heading", { level: 3 }))}
      <span className="tb-sep" />
      {btn("B", () => editor.chain().focus().toggleBold().run(), editor.isActive("bold"), "Bold")}
      {btn("i", () => editor.chain().focus().toggleItalic().run(), editor.isActive("italic"), "Italic")}
      {btn("S", () => editor.chain().focus().toggleStrike().run(), editor.isActive("strike"), "Strikethrough")}
      {btn("</>", () => editor.chain().focus().toggleCode().run(), editor.isActive("code"), "Inline code")}
      <span className="tb-sep" />
      {btn("•", () => editor.chain().focus().toggleBulletList().run(), editor.isActive("bulletList"), "Bullet list")}
      {btn("1.", () => editor.chain().focus().toggleOrderedList().run(), editor.isActive("orderedList"), "Numbered list")}
      {btn("☑", () => editor.chain().focus().toggleTaskList().run(), editor.isActive("taskList"), "Task list")}
      {btn("❝", () => editor.chain().focus().toggleBlockquote().run(), editor.isActive("blockquote"), "Quote")}
      {btn("{}", () => editor.chain().focus().toggleCodeBlock().run(), editor.isActive("codeBlock"), "Code block")}
      {btn("―", () => editor.chain().focus().setHorizontalRule().run(), false, "Divider")}
    </div>
  );
}
