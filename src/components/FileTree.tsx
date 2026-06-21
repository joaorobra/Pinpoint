import { useState } from "react";
import type { TreeNode } from "../types";

interface Props {
  node: TreeNode;
  activePath: string | null;
  onOpen: (relPath: string) => void;
  depth?: number;
}

export default function FileTree({ node, activePath, onOpen, depth = 0 }: Props) {
  const [open, setOpen] = useState(depth < 1);

  if (!node.is_dir) {
    const label = node.name.replace(/\.md$/, "");
    return (
      <div
        className={`tree-file${activePath === node.rel_path ? " active" : ""}`}
        style={{ paddingLeft: depth * 14 + 8 }}
        onClick={() => onOpen(node.rel_path)}
        title={node.rel_path}
      >
        <span className="tree-icon">📄</span>
        {label}
      </div>
    );
  }

  return (
    <div>
      {depth > 0 && (
        <div
          className="tree-dir"
          style={{ paddingLeft: depth * 14 + 8 }}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="tree-icon">{open ? "▾" : "▸"}</span>
          <span className="tree-icon">{node.is_database ? "🗃️" : "📁"}</span>
          {node.name}
        </div>
      )}
      {open &&
        node.children.map((c) => (
          <FileTree key={c.rel_path} node={c} activePath={activePath} onOpen={onOpen} depth={depth + 1} />
        ))}
    </div>
  );
}
