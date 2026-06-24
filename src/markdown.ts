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
      if (n.type === "wikiLink") return `[[${n.attrs?.name ?? ""}]]`;
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
    // nested lists (a taskItem can nest a taskList; bullet/ordered items nest their own kind)
    (item.content ?? []).slice(1).forEach((child) => {
      if (child.type === "bulletList") lines.push(listToMd(child, false, depth + 1));
      else if (child.type === "orderedList") lines.push(listToMd(child, true, depth + 1));
      else if (child.type === "taskList") lines.push(listToMd(child, false, depth + 1));
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
      case "queryBlock":
        // Inline query → a fenced `query` block, so it round-trips as plain markdown.
        blocks.push("```query\n" + (node.attrs?.dsl ?? "") + "\n```");
        break;
      case "image":
        // Block image (pasted/dropped) → standard markdown. `src` is the raw vault-relative path.
        blocks.push(`![${node.attrs?.alt ?? ""}](${node.attrs?.src ?? ""})`);
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

/**
 * Render inline markdown (links, wikilinks, images, code, bold/italic/strike) to HTML. Exported so
 * non-editor surfaces (e.g. the Tasks list) display the same formatting instead of leaking raw
 * `**`, `[[ ]]`, `[ ]( )` markup. Wikilinks become `[data-page-link]` spans; the caller can delegate
 * clicks on those to open the page.
 */
export function inlineMd(text: string): string {
  let s = escapeHtml(text);
  // Wikilinks `[[Name]]` -> styled page-link atom. Must run before the `[text](url)` rule so the
  // double brackets aren't consumed as a regular markdown link.
  s = s.replace(/\[\[([^\]]+)\]\]/g, (_m, name) => {
    const n = String(name).trim();
    return `<span data-page-link="${n.replace(/"/g, "&quot;")}">${n}</span>`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  return s;
}

/**
 * Strip task metadata from a raw task line to a clean display label: date/recurrence/done emoji
 * markers (📅 🔁 ✅ ⏳), a `priority:: …` field, and `#tags`.
 *
 * Tags sometimes appear wrapped as a markdown link — e.g. `[#tattoo-off](#tattoo-off)` — when the
 * editor auto-links a `#tag`. A naive `#[\w/-]+` strip would gut the `#` out of both the `[...]`
 * label and the `(...)` href and leave behind empty `[]()` markup (which then renders literally).
 * So we first remove any whole markdown link whose label is a bare tag, *then* strip plain tags.
 */
export function stripTaskMeta(text: string): string {
  return text
    // `done:: 2026-06-23 14:30` — completion timestamp field; value runs to the next field marker.
    .replace(/\bdone::\s*[^📅🔁⏳✅]*/gi, "")
    // `priority:: high` — the dataview-style field (value is a single word).
    .replace(/\bpriority::\s*\S+/gi, "")
    // 📅/🔁/✅ marker + its trailing value (date, rrule, …), up to the next marker.
    .replace(/[📅🔁✅⏳]\s*[^📅🔁⏳✅]*/g, "")
    // A markdown link that's really just a tag: `[#tag](anything)` → gone (drop the empty shell too).
    .replace(/\[#[\w/.!?-]+\]\([^)]*\)/g, "")
    // Remaining bare `#tags`. Allow inner `.`/`!`/`?` (e.g. `#people.John`) but stop before trailing
    // sentence punctuation so it survives, matching the indexer's tag rule. Two forms: a multi-char
    // run that can't end on `.!?`, or a single trailing char.
    .replace(/#(?:[\w/.!?-]*[\w/-]|[\w/-])/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let i = 0;

  // A single parsed list item: its indentation (leading spaces), kind, checked state (task items),
  // text, and the raw lines of any deeper-indented children (parsed recursively into nested lists).
  type ListLine = {
    indent: number;
    ordered: boolean;
    task: boolean;
    checked: boolean;
    text: string;
  };

  // Match any list line, capturing indentation + marker so we can reconstruct nesting from indent.
  const LIST_RE = /^(\s*)(?:([-*])|(\d+)\.)\s(\[[ xX]\]\s?)?(.*)$/;

  const parseListLine = (line: string): ListLine | null => {
    const m = line.match(LIST_RE);
    if (!m) return null;
    const [, indentStr, bullet, , box, rest] = m;
    const task = !!box;
    return {
      indent: indentStr.replace(/\t/g, "  ").length,
      ordered: !bullet, // numbered when there was no `-`/`*` marker
      task,
      checked: task ? /\[x\]/i.test(box!) : false,
      text: rest,
    };
  };

  // Render a contiguous block of list lines (`block`, all already parsed) into nested HTML,
  // honoring indentation. Items deeper than `baseIndent` become a child list of the prior item.
  const renderList = (block: ListLine[]): string => {
    const out: string[] = [];
    let k = 0;
    while (k < block.length) {
      const baseIndent = block[k].indent;
      const task = block[k].task;
      const ordered = block[k].ordered;
      const tag = task ? `<ul data-type="taskList">` : ordered ? "<ol>" : "<ul>";
      out.push(tag);
      // Consume every sibling at this indent (same kind) plus their deeper-indented children.
      while (k < block.length && block[k].indent === baseIndent && block[k].task === task && block[k].ordered === ordered) {
        const it = block[k++];
        // Gather all following lines indented deeper than this item — they're its descendants.
        const children: ListLine[] = [];
        while (k < block.length && block[k].indent > baseIndent) children.push(block[k++]);
        const childHtml = children.length ? renderList(children) : "";
        if (task) {
          out.push(
            `<li data-type="taskItem" data-checked="${it.checked}"><label><input type="checkbox"${
              it.checked ? " checked" : ""
            }><span></span></label><div><p>${inlineMd(it.text)}</p>${childHtml}</div></li>`
          );
        } else {
          out.push(`<li><p>${inlineMd(it.text)}</p>${childHtml}</li>`);
        }
      }
      out.push(task ? "</ul>" : ordered ? "</ol>" : "</ul>");
    }
    return out.join("\n");
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
    // A line that is solely an image → a block image node (avoids an empty wrapping paragraph).
    const imgOnly = line.match(/^!\[([^\]]*)\]\(([^)]+)\)\s*$/);
    if (imgOnly) {
      html.push(`<img alt="${escapeHtml(imgOnly[1])}" src="${imgOnly[2].replace(/"/g, "&quot;")}">`);
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const lang = line.replace(/^```/, "").trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      // A `query` fence becomes an inline query block (the QueryBlock node parses data-query),
      // not a literal code listing.
      if (lang.toLowerCase() === "query") {
        const dsl = code.join(" ").trim();
        html.push(`<div data-query="${dsl.replace(/"/g, "&quot;")}"></div>`);
      } else {
        html.push(
          `<pre><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`
        );
      }
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
    // Lists (task / bullet / ordered, with arbitrary nesting). Gather a contiguous run of list
    // lines and reconstruct nesting from indentation, so nested items survive the round-trip.
    if (parseListLine(line)) {
      const block: ListLine[] = [];
      let parsed: ListLine | null;
      while (i < lines.length && (parsed = parseListLine(lines[i]))) {
        block.push(parsed);
        i++;
      }
      html.push(renderList(block));
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
