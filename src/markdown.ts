// Markdown <-> HTML bridge for the TipTap WYSIWYG editor.
//
// Constraint (locked decision): the editor only produces blocks that round-trip losslessly to
// CommonMark + GFM — headings, bold/italic/strike/code, links, lists, task-list items, blockquotes,
// fenced code, horizontal rules, images, and GFM tables. No HTML/custom block serialization.
//
// We keep this dependency-light: a focused serializer (TipTap JSON -> markdown) and a small
// parser (markdown -> TipTap-compatible HTML) so we don't pull a heavy MD lib into the bundle.

type Node = {
  type?: string;
  attrs?: Record<string, any>;
  content?: Node[];
  marks?: { type: string; attrs?: Record<string, any> }[];
  text?: string;
};

// ---------- TipTap JSON -> Markdown ----------

function applyMarks(text: string, marks?: Node["marks"]): string {
  if (!marks) return text;
  let out = text;
  for (const m of marks) {
    switch (m.type) {
      case "bold":
        out = `**${out}**`;
        break;
      case "italic":
        out = `*${out}*`;
        break;
      case "strike":
        out = `~~${out}~~`;
        break;
      case "code":
        out = `\`${out}\``;
        break;
      case "link":
        out = `[${out}](${m.attrs?.href ?? ""})`;
        break;
    }
  }
  return out;
}

function inline(nodes?: Node[]): string {
  if (!nodes) return "";
  return nodes
    .map((n) => {
      if (n.type === "text") return applyMarks(n.text ?? "", n.marks);
      if (n.type === "hardBreak") return "\n";
      if (n.type === "image") return `![${n.attrs?.alt ?? ""}](${n.attrs?.src ?? ""})`;
      return inline(n.content);
    })
    .join("");
}

function listToMd(node: Node, ordered: boolean, depth: number): string {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  (node.content ?? []).forEach((item, i) => {
    const checked = item.attrs?.checked;
    const marker = ordered ? `${i + 1}.` : "-";
    const box = item.type === "taskItem" ? (checked ? "[x] " : "[ ] ") : "";
    const para = item.content?.[0];
    const firstLine = inline(para?.content);
    lines.push(`${indent}${marker} ${box}${firstLine}`);
    // nested lists
    (item.content ?? []).slice(1).forEach((child) => {
      if (child.type === "bulletList") lines.push(listToMd(child, false, depth + 1));
      else if (child.type === "orderedList") lines.push(listToMd(child, true, depth + 1));
      else if (child.type === "paragraph") lines.push(`${indent}  ${inline(child.content)}`);
    });
  });
  return lines.join("\n");
}

function tableToMd(node: Node): string {
  const rows = node.content ?? [];
  const lines: string[] = [];
  rows.forEach((row, ri) => {
    const cells = (row.content ?? []).map((c) => inline(c.content?.[0]?.content).trim());
    lines.push(`| ${cells.join(" | ")} |`);
    if (ri === 0) lines.push(`| ${cells.map(() => "---").join(" | ")} |`);
  });
  return lines.join("\n");
}

export function docToMarkdown(doc: Node): string {
  const blocks: string[] = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "heading":
        blocks.push(`${"#".repeat(node.attrs?.level ?? 1)} ${inline(node.content)}`);
        break;
      case "paragraph":
        blocks.push(inline(node.content));
        break;
      case "bulletList":
        blocks.push(listToMd(node, false, 0));
        break;
      case "orderedList":
        blocks.push(listToMd(node, true, 0));
        break;
      case "taskList":
        blocks.push(listToMd(node, false, 0));
        break;
      case "blockquote":
        blocks.push(
          (node.content ?? [])
            .map((c) => `> ${inline(c.content)}`)
            .join("\n")
        );
        break;
      case "codeBlock":
        blocks.push("```" + (node.attrs?.language ?? "") + "\n" + (node.content?.[0]?.text ?? "") + "\n```");
        break;
      case "horizontalRule":
        blocks.push("---");
        break;
      case "table":
        blocks.push(tableToMd(node));
        break;
      default:
        blocks.push(inline(node.content));
    }
  }
  return blocks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// ---------- Markdown -> HTML (for TipTap initial content) ----------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMd(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s;
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  const flushList = (items: string[], ordered: boolean, task: boolean) => {
    if (!items.length) return;
    if (task) {
      html.push(`<ul data-type="taskList">`);
      for (const it of items) {
        const checked = /^\[x\]/i.test(it);
        const text = it.replace(/^\[[ xX]\]\s*/, "");
        html.push(
          `<li data-type="taskItem" data-checked="${checked}"><label><input type="checkbox"${
            checked ? " checked" : ""
          }><span></span></label><div><p>${inlineMd(text)}</p></div></li>`
        );
      }
      html.push("</ul>");
    } else {
      html.push(ordered ? "<ol>" : "<ul>");
      for (const it of items) html.push(`<li><p>${inlineMd(it)}</p></li>`);
      html.push(ordered ? "</ol>" : "</ul>");
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)![0].length;
      html.push(`<h${level}>${inlineMd(line.replace(/^#+\s/, ""))}</h${level}>`);
      i++;
      continue;
    }
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      html.push("<hr>");
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      html.push(
        `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`
      );
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) quote.push(lines[i++].replace(/^>\s?/, ""));
      html.push(`<blockquote><p>${inlineMd(quote.join(" "))}</p></blockquote>`);
      continue;
    }
    // GFM table
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
      const parseRow = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = parseRow(line);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && /^\|/.test(lines[i])) bodyRows.push(parseRow(lines[i++]));
      html.push("<table><tbody>");
      html.push("<tr>" + header.map((h) => `<th><p>${inlineMd(h)}</p></th>`).join("") + "</tr>");
      for (const r of bodyRows)
        html.push("<tr>" + r.map((c) => `<td><p>${inlineMd(c)}</p></td>`).join("") + "</tr>");
      html.push("</tbody></table>");
      continue;
    }
    // task / bullet / ordered lists
    if (/^\s*[-*]\s\[[ xX]\]/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s\[[ xX]\]/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s/, ""));
      flushList(items, false, true);
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i]) && !/^\s*[-*]\s\[[ xX]\]/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*[-*]\s/, ""));
      flushList(items, false, false);
      continue;
    }
    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s/, ""));
      flushList(items, true, false);
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    // paragraph (gather consecutive non-blank, non-special lines)
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>|```|\s*[-*]\s|\s*\d+\.\s|\|)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    html.push(`<p>${inlineMd(para.join(" "))}</p>`);
  }

  return html.join("\n");
}
